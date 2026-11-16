/**
 * Отдельный плеер аудиокниг (LibriVox / Internet Archive).
 *
 * Не пересекается с TTS-плеером текстовых книг (src/lib/player.tsx):
 * здесь играет настоящий HTMLAudioElement — треки источника или скачанные
 * из IndexedDB blob-URL. Позиция хранится в localStorage под ключом
 * `polka:audio:<catalogId>`, чтобы вернуться к главе после перезапуска.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AudioTrack, CatalogBook } from '../catalog/types';
import { downloads } from '../downloads/manager';
import type { NetworkBook } from '../downloads/types';

/** Доступные скорости — 0.8…2.0, как в TTS-плеере. */
export const AUDIO_RATES = [0.8, 1, 1.2, 1.5, 2] as const;

const POSITION_PREFIX = 'polka:audio:';
const RATE_KEY = 'polka:audio:rate';
const MIN_RATE = 0.8;
const MAX_RATE = 2;
const SAVE_INTERVAL_MS = 2500;

export interface AudioPlayerPosition {
  trackIndex: number;
  currentTime: number;
  updatedAt: number;
}

export interface AudioPlayerState {
  book: CatalogBook | null;
  trackIndex: number;
  trackTitle: string;
  playing: boolean;
  currentTime: number;
  duration: number;
  rate: number;
  /** Текущая дорожка играет из скачанного файла, а не из сети. */
  downloadedOnly: boolean;
}

export interface AudioPlayerApi extends AudioPlayerState {
  error: string | null;
  open: (book: CatalogBook, trackIndex?: number, autoplay?: boolean) => Promise<void>;
  play: () => Promise<void>;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  setRate: (rate: number) => void;
  close: () => void;
}

/** Сохранённая позиция книги: последняя глава и время в ней. */
export function readAudioPosition(catalogId: string): AudioPlayerPosition | null {
  try {
    const raw = localStorage.getItem(`${POSITION_PREFIX}${catalogId}`);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const entry = parsed as Partial<AudioPlayerPosition>;
    if (typeof entry.trackIndex !== 'number' || typeof entry.currentTime !== 'number') return null;
    return {
      trackIndex: Math.max(0, Math.floor(entry.trackIndex)),
      currentTime: Math.max(0, entry.currentTime),
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

function writeAudioPosition(catalogId: string, trackIndex: number, currentTime: number): void {
  try {
    localStorage.setItem(
      `${POSITION_PREFIX}${catalogId}`,
      JSON.stringify({ trackIndex, currentTime, updatedAt: Date.now() } satisfies AudioPlayerPosition),
    );
  } catch {
    /* приватный режим или переполнение — не критично */
  }
}

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round(value * 10) / 10));
}

function readRate(): number {
  try {
    const raw = localStorage.getItem(RATE_KEY);
    if (!raw) return 1;
    return clampRate(Number(raw));
  } catch {
    return 1;
  }
}

/** Ключ файла дорожки внутри скачанной книги (совпадение по названию, затем по позиции). */
function findTrackKey(networkBook: NetworkBook, track: AudioTrack, index: number): string | undefined {
  const tracks = networkBook.audioTracks ?? [];
  if (tracks.length === 0) return undefined;
  const byTitle = tracks.find((item) => item.title === track.title);
  if (byTitle) return byTitle.storageKey;
  return tracks[index]?.storageKey;
}

const AudioPlayerContext = createContext<AudioPlayerApi | null>(null);

export function AudioProvider({ children }: { children: ReactNode }) {
  const [audio] = useState<HTMLAudioElement | null>(() => {
    if (typeof Audio === 'undefined') return null;
    const element = new Audio();
    element.preload = 'metadata';
    return element;
  });

  const [state, setState] = useState<AudioPlayerState>({
    book: null,
    trackIndex: 0,
    trackTitle: '',
    playing: false,
    currentTime: 0,
    duration: 0,
    rate: readRate(),
    downloadedOnly: false,
  });
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<AudioPlayerState>(state);

  const loadTokenRef = useRef(0);
  const blobUrlRef = useRef<string | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const lastSavedRef = useRef(0);
  /** Что реально загружено в <audio> — сохраняем позицию по нему, а не по будущему треку. */
  const loadedRef = useRef<{ bookId: string; trackIndex: number } | null>(null);

  const updateState = useCallback((patch: Partial<AudioPlayerState>) => {
    setState((previous) => {
      const next = { ...previous, ...patch };
      stateRef.current = next;
      return next;
    });
  }, []);

  const revokeBlob = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  const persistPosition = useCallback((force = false) => {
    if (!audio) return;
    const loaded = loadedRef.current;
    if (!loaded) return;
    const now = Date.now();
    if (!force && now - lastSavedRef.current < SAVE_INTERVAL_MS) return;
    lastSavedRef.current = now;
    const time = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    writeAudioPosition(loaded.bookId, loaded.trackIndex, Math.max(0, time));
  }, [audio]);

  const syncPositionState = useCallback(() => {
    if (!audio || !('mediaSession' in navigator)) return;
    if (typeof navigator.mediaSession.setPositionState !== 'function') return;
    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const position = Math.max(0, Math.min(Number.isFinite(audio.currentTime) ? audio.currentTime : 0, duration));
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: Number.isFinite(audio.playbackRate) && audio.playbackRate > 0 ? audio.playbackRate : 1,
        position,
      });
    } catch {
      /* некоторые браузеры отвергают positionState — не критично */
    }
  }, [audio]);

  const updateMediaMetadata = useCallback((targetBook: CatalogBook, track: AudioTrack) => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const narrators = targetBook.audio?.narrators?.filter(Boolean) ?? [];
    const artist = narrators.length > 0 ? narrators.join(', ') : targetBook.authors.join(', ');
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || targetBook.title,
        artist,
        album: targetBook.title,
        artwork: targetBook.coverUrl ? [{ src: targetBook.coverUrl }] : [],
      });
    } catch {
      /* метаданные не обязательны для воспроизведения */
    }
  }, []);

  const loadTrack = useCallback(
    async (targetBook: CatalogBook, index: number, autoplay: boolean, startAt?: number) => {
      if (!audio) return;
      const tracks = targetBook.audio?.tracks ?? [];
      const track = tracks[index];
      if (!track) {
        setError('У источника нет этой аудиодорожки');
        return;
      }

      // Сохраняем позицию предыдущей дорожки прежде чем менять источник.
      persistPosition(true);
      const token = loadTokenRef.current + 1;
      loadTokenRef.current = token;
      audio.pause();
      revokeBlob();
      pendingSeekRef.current = typeof startAt === 'number' && startAt > 0 ? startAt : null;
      setError(null);
      updateState({
        book: targetBook,
        trackIndex: index,
        trackTitle: track.title,
        playing: false,
        currentTime: pendingSeekRef.current ?? 0,
        duration: track.durationSec ?? 0,
        downloadedOnly: false,
      });

      let source = track.url;
      let downloaded = false;
      try {
        const networkBook = downloads.findByCatalogId(targetBook.id);
        const storageKey = networkBook ? findTrackKey(networkBook, track, index) : undefined;
        if (networkBook && storageKey) {
          const blob = await downloads.getBlob(networkBook.id, storageKey);
          if (loadTokenRef.current !== token) return;
          if (blob) {
            const url = URL.createObjectURL(blob);
            blobUrlRef.current = url;
            source = url;
            downloaded = true;
          }
        }
      } catch (cause) {
        console.warn('Скачанная дорожка недоступна — играем из сети', cause);
      }
      if (loadTokenRef.current !== token) return;

      audio.src = source;
      audio.playbackRate = stateRef.current.rate;
      loadedRef.current = { bookId: targetBook.id, trackIndex: index };
      updateState({ downloadedOnly: downloaded });
      updateMediaMetadata(targetBook, track);
      audio.load();

      if (autoplay) {
        try {
          await audio.play();
        } catch {
          setError('Не удалось включить звук. Нажмите «Слушать» ещё раз.');
        }
      }
    },
    [audio, persistPosition, revokeBlob, updateMediaMetadata, updateState],
  );

  const play = useCallback(async () => {
    if (!audio || !stateRef.current.book || !audio.src) return;
    try {
      await audio.play();
      setError(null);
    } catch {
      setError('Не удалось включить звук. Нажмите «Слушать» ещё раз.');
    }
  }, [audio]);

  const pause = useCallback(() => {
    if (!audio) return;
    audio.pause();
    persistPosition(true);
  }, [audio, persistPosition]);

  const toggle = useCallback(() => {
    if (stateRef.current.playing) pause();
    else void play();
  }, [pause, play]);

  const seek = useCallback(
    (seconds: number) => {
      if (!audio) return;
      const knownDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : stateRef.current.duration;
      const target = Math.max(0, knownDuration > 0 ? Math.min(seconds, knownDuration) : seconds);
      try {
        audio.currentTime = target;
        updateState({ currentTime: target });
      } catch {
        pendingSeekRef.current = target;
        updateState({ currentTime: target });
      }
      persistPosition(true);
      syncPositionState();
    },
    [audio, persistPosition, syncPositionState, updateState],
  );

  const setRate = useCallback(
    (nextRate: number) => {
      const rate = clampRate(nextRate);
      if (audio) audio.playbackRate = rate;
      updateState({ rate });
      try {
        localStorage.setItem(RATE_KEY, String(rate));
      } catch {
        /* не критично */
      }
      syncPositionState();
    },
    [audio, syncPositionState, updateState],
  );

  const next = useCallback(() => {
    const current = stateRef.current;
    const tracks = current.book?.audio?.tracks ?? [];
    if (!current.book || tracks.length === 0) return;
    const index = (current.trackIndex + 1) % tracks.length;
    void loadTrack(current.book, index, true);
  }, [loadTrack]);

  const prev = useCallback(() => {
    const current = stateRef.current;
    const tracks = current.book?.audio?.tracks ?? [];
    if (!current.book || tracks.length === 0) return;
    if ((audio?.currentTime ?? 0) > 3) {
      seek(0);
      return;
    }
    const index = (current.trackIndex - 1 + tracks.length) % tracks.length;
    void loadTrack(current.book, index, true);
  }, [audio, loadTrack, seek]);

  const handleEnded = useCallback(() => {
    const current = stateRef.current;
    const tracks = current.book?.audio?.tracks ?? [];
    if (!current.book || tracks.length === 0) return;
    updateState({ playing: false });
    const nextIndex = current.trackIndex + 1;
    if (nextIndex >= tracks.length) {
      persistPosition(true);
      return;
    }
    void loadTrack(current.book, nextIndex, true);
  }, [loadTrack, persistPosition, updateState]);

  const open = useCallback(
    async (targetBook: CatalogBook, requestedIndex?: number, autoplay = true) => {
      const tracks = targetBook.audio?.tracks ?? [];
      const saved = readAudioPosition(targetBook.id);
      if (tracks.length === 0) {
        updateState({
          book: targetBook,
          trackIndex: 0,
          trackTitle: '',
          playing: false,
          currentTime: 0,
          duration: 0,
          downloadedOnly: false,
        });
        audio?.pause();
        if (audio) {
          audio.removeAttribute('src');
          audio.load();
        }
        revokeBlob();
        loadedRef.current = null;
        setError('У этой книги нет аудиодорожек');
        return;
      }
      const fallbackIndex = saved ? Math.min(saved.trackIndex, tracks.length - 1) : 0;
      const index =
        requestedIndex === undefined ? fallbackIndex : Math.min(Math.max(0, Math.floor(requestedIndex)), tracks.length - 1);
      const alreadyLoaded =
        stateRef.current.book?.id === targetBook.id && stateRef.current.trackIndex === index && Boolean(audio?.src);

      updateState({
        book: targetBook,
        trackIndex: index,
        trackTitle: tracks[index]?.title ?? '',
      });
      if (alreadyLoaded) {
        if (autoplay && audio?.paused) await play();
        return;
      }
      const restoreTime = requestedIndex === undefined && saved?.trackIndex === index ? saved.currentTime : 0;
      await loadTrack(targetBook, index, autoplay, restoreTime);
    },
    [audio, loadTrack, play, updateState],
  );

  const close = useCallback(() => {
    if (audio) {
      persistPosition(true);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    revokeBlob();
    loadedRef.current = null;
    updateState({
      book: null,
      trackIndex: 0,
      trackTitle: '',
      playing: false,
      currentTime: 0,
      duration: 0,
      downloadedOnly: false,
    });
    setError(null);
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
      } catch {
        /* noop */
      }
    }
  }, [audio, persistPosition, revokeBlob, updateState]);

  useEffect(() => {
    if (!audio) return;

    const onTimeUpdate = () => {
      const patch: Partial<AudioPlayerState> = {
        currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      };
      if (
        Number.isFinite(audio.duration) &&
        audio.duration > 0 &&
        Math.abs(audio.duration - stateRef.current.duration) > 0.5
      ) {
        patch.duration = audio.duration;
      }
      updateState(patch);
      persistPosition();
      syncPositionState();
    };

    const onMetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        updateState({ duration: audio.duration });
      }
      const pending = pendingSeekRef.current;
      pendingSeekRef.current = null;
      if (pending !== null && pending > 0) {
        const limit = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.max(0, audio.duration - 0.25) : pending;
        try {
          audio.currentTime = Math.min(pending, limit);
          updateState({ currentTime: audio.currentTime });
        } catch {
          /* браузер ещё не готов — останется начало дорожки */
        }
      }
      syncPositionState();
    };

    const onPlay = () => {
      updateState({ playing: true });
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.playbackState = 'playing';
        } catch {
          /* noop */
        }
      }
      syncPositionState();
    };

    const onPause = () => {
      updateState({ playing: false });
      // После смены источника readyState ещё 0 — не затираем позицию нового трека.
      if (audio.readyState >= 1) persistPosition(true);
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.playbackState = 'paused';
        } catch {
          /* noop */
        }
      }
      syncPositionState();
    };

    const onEnded = () => {
      handleEnded();
    };

    const onError = () => {
      if (!audio.src || !stateRef.current.book) return;
      updateState({ playing: false });
      setError('Не удалось воспроизвести дорожку. Проверьте соединение с интернетом.');
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onMetadata);
    audio.addEventListener('durationchange', onMetadata);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onMetadata);
      audio.removeEventListener('durationchange', onMetadata);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      persistPosition(true);
    };
  }, [audio, handleEnded, persistPosition, syncPositionState, updateState]);

  // Media Session: экран блокировки, наушники, фон.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => void play()],
      ['pause', () => pause()],
      ['nexttrack', () => next()],
      ['previoustrack', () => prev()],
      [
        'seekbackward',
        (details) => seek((audio?.currentTime ?? 0) - (details.seekOffset ?? 15)),
      ],
      [
        'seekforward',
        (details) => seek((audio?.currentTime ?? 0) + (details.seekOffset ?? 15)),
      ],
      [
        'seekto',
        (details) => {
          if (typeof details.seekTime === 'number') seek(details.seekTime);
        },
      ],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        /* действие не поддерживается браузером */
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          /* noop */
        }
      }
    };
  }, [audio, next, pause, play, prev, seek]);

  // Не теряем позицию при сворачивании вкладки или уходе со страницы.
  useEffect(() => {
    const save = () => persistPosition(true);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') save();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', save);
    window.addEventListener('beforeunload', save);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', save);
      window.removeEventListener('beforeunload', save);
    };
  }, [persistPosition]);

  // Полное освобождение ресурсов плеера при размонтировании провайдера.
  useEffect(() => {
    return () => {
      audio?.pause();
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [audio]);

  const value = useMemo<AudioPlayerApi>(
    () => ({
      ...state,
      error,
      open,
      play,
      pause,
      toggle,
      next,
      prev,
      seek,
      setRate,
      close,
    }),
    [state, error, open, play, pause, toggle, next, prev, seek, setRate, close],
  );

  return <AudioPlayerContext.Provider value={value}>{children}</AudioPlayerContext.Provider>;
}

export function useAudioPlayer(): AudioPlayerApi {
  const value = useContext(AudioPlayerContext);
  if (!value) throw new Error('useAudioPlayer должен использоваться внутри AudioProvider');
  return value;
}
