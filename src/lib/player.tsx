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
import type { BookContent, BookStats, Locator, ParagraphRef } from '../types';
import {
  computeBookStats,
  flatIndexAt,
  loadBookContent,
  locatorAtFlat,
  locatorFromPercent,
  percentAtFlat,
} from './content';
import { getBook } from '../data/books';
import { clamp } from './format';
import { useApp } from './store';

export interface VoiceOption {
  name: string;
  lang: string;
}

export interface PlayerSnapshot {
  bookId: string;
  chapter: number;
  paragraph: number;
  index: number;
  total: number;
  percent: number;
  playing: boolean;
  engine: 'tts' | 'sim' | 'idle';
  rate: number;
  sleepAt: number | null;
  elapsedSec: number;
}

export interface PlayerContextValue {
  snapshot: PlayerSnapshot | null;
  content: BookContent | null;
  stats: BookStats | null;
  current: ParagraphRef | null;
  voices: VoiceOption[];
  voiceAvailable: boolean;
  loading: boolean;
  error: string | null;
  open: (bookId: string, locator?: Locator, autoplay?: boolean) => Promise<void>;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seekLocator: (locator: Locator) => void;
  seekPercent: (percent: number) => void;
  setRate: (rate: number) => void;
  setVoice: (name: string | null) => void;
  setSleep: (minutes: number | null) => void;
  close: () => void;
  flush: () => void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

function estimateParagraphMs(text: string, rate: number): number {
  const words = text.trim() ? text.trim().split(/\s+/).length : 10;
  const seconds = (words / (2.4 * Math.max(0.5, rate))) * 1.0;
  return clamp(seconds * 1000, 3200, 150_000);
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const app = useApp();
  const { state, saveProgress, markFinished, addSession, updateSettings, pushToast } = app;

  const [snapshot, setSnapshot] = useState<PlayerSnapshot | null>(null);
  const [content, setContent] = useState<BookContent | null>(null);
  const [stats, setStats] = useState<BookStats | null>(null);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const appStateRef = useRef(state);
  appStateRef.current = state;

  const contentRef = useRef<BookContent | null>(null);
  const statsRef = useRef<BookStats | null>(null);
  const bookIdRef = useRef<string | null>(null);
  const indexRef = useRef(0);
  const playingRef = useRef(false);
  const engineRef = useRef<'tts' | 'sim' | 'idle'>('idle');
  const rateRef = useRef(state.settings.ttsRate || 1);
  const voiceRef = useRef<string | null>(state.settings.ttsVoice);
  const elapsedRef = useRef(0);
  const pausedRef = useRef(false);
  const forcedSimRef = useRef(false);
  const synthRef = useRef<SpeechSynthesis | null>(typeof window !== 'undefined' ? window.speechSynthesis : null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const simTimerRef = useRef<number | null>(null);
  const simStartRef = useRef(0);
  const simDurationRef = useRef(0);
  const simRemainingRef = useRef(0);
  const watchdogRef = useRef<number | null>(null);
  const startedRef = useRef(false);
  const sleepAtRef = useRef<number | null>(null);
  const sessionSecondsRef = useRef(0);
  const pagesAccumRef = useRef(0);
  const lastPercentRef = useRef(0);
  const sessionBookRef = useRef<string | null>(null);

  const publish = useCallback(() => {
    const statsNow = statsRef.current;
    const bookId = bookIdRef.current;
    if (!statsNow || !bookId) {
      setSnapshot(null);
      return;
    }
    const index = indexRef.current;
    const ref = statsNow.paragraphs[index];
    setSnapshot({
      bookId,
      chapter: ref?.chapter ?? 0,
      paragraph: ref?.paragraph ?? 0,
      index,
      total: statsNow.paragraphs.length,
      percent: percentAtFlat(statsNow, index),
      playing: playingRef.current,
      engine: engineRef.current,
      rate: rateRef.current,
      sleepAt: sleepAtRef.current,
      elapsedSec: elapsedRef.current,
    });
  }, []);

  useEffect(() => {
    rateRef.current = state.settings.ttsRate || 1;
    voiceRef.current = state.settings.ttsVoice;
  }, [state.settings.ttsRate, state.settings.ttsVoice]);

  useEffect(() => {
    const synth = synthRef.current;
    if (!synth) return;
    const load = () => {
      const list = synth
        .getVoices()
        .filter((voice) => voice.lang.toLowerCase().startsWith('ru'))
        .map((voice) => ({ name: voice.name, lang: voice.lang }));
      setVoices(list);
    };
    load();
    synth.addEventListener?.('voiceschanged', load);
    return () => synth.removeEventListener?.('voiceschanged', load);
  }, []);

  const flushSession = useCallback(() => {
    const bookId = sessionBookRef.current;
    const minutes = sessionSecondsRef.current / 60;
    const pages = pagesAccumRef.current;
    if (bookId && (minutes >= 0.25 || pages >= 0.25)) {
      addSession(bookId, 'listen', minutes, pages);
    }
    sessionSecondsRef.current = 0;
    pagesAccumRef.current = 0;
    sessionBookRef.current = bookId;
  }, [addSession]);

  const clearSim = useCallback(() => {
    if (simTimerRef.current !== null) {
      window.clearTimeout(simTimerRef.current);
      simTimerRef.current = null;
    }
  }, []);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const stopEngine = useCallback(() => {
    clearSim();
    clearWatchdog();
    const synth = synthRef.current;
    if (synth) {
      try {
        synth.cancel();
      } catch {
        /* speech может быть недоступен */
      }
    }
    utteranceRef.current = null;
    startedRef.current = false;
    engineRef.current = 'idle';
  }, [clearSim, clearWatchdog]);

  function saveCurrentProgress(): void {
    const statsNow = statsRef.current;
    const bookId = bookIdRef.current;
    if (!statsNow || !bookId) return;
    const index = indexRef.current;
    const locator = locatorAtFlat(statsNow, index);
    const percent = percentAtFlat(statsNow, index);
    const book = getBook(bookId);
    const delta = Math.max(0, percent - lastPercentRef.current);
    if (book) pagesAccumRef.current += (delta / 100) * book.pages;
    lastPercentRef.current = Math.max(lastPercentRef.current, percent);
    saveProgress({
      bookId,
      chapter: locator.chapter,
      paragraph: locator.paragraph,
      percent,
      lastMode: 'listen',
    });
  }

  function finishPlayback(): void {
    const bookId = bookIdRef.current;
    const statsNow = statsRef.current;
    const locator = statsNow ? locatorAtFlat(statsNow, indexRef.current) : { chapter: 0, paragraph: 0 };
    playingRef.current = false;
    engineRef.current = 'idle';
    stopEngine();
    if (bookId) {
      saveProgress({
        bookId,
        chapter: locator.chapter,
        paragraph: locator.paragraph,
        percent: 100,
        lastMode: 'listen',
      });
      markFinished(bookId);
      const book = getBook(bookId);
      pushToast(`«${book?.title ?? 'Книга'}» прослушана до конца`, 'success');
    }
    flushSession();
    publish();
  }

  function advance(auto: boolean): void {
    const statsNow = statsRef.current;
    if (!statsNow) return;
    clearSim();
    clearWatchdog();
    const nextIndex = indexRef.current + 1;
    if (nextIndex >= statsNow.paragraphs.length) {
      finishPlayback();
      return;
    }
    indexRef.current = nextIndex;
    saveCurrentProgress();
    if (auto && playingRef.current) {
      speakCurrent();
    } else {
      if (!auto) {
        playingRef.current = false;
        stopEngine();
        flushSession();
      }
      publish();
    }
  }

  function startSim(): void {
    clearSim();
    clearWatchdog();
    const statsNow = statsRef.current;
    const ref = statsNow?.paragraphs[indexRef.current];
    if (!ref) return;
    const duration = estimateParagraphMs(ref.text, rateRef.current);
    simDurationRef.current = duration;
    simStartRef.current = performance.now();
    simRemainingRef.current = duration;
    engineRef.current = 'sim';
    pausedRef.current = false;
    publish();
    simTimerRef.current = window.setTimeout(() => {
      simTimerRef.current = null;
      if (playingRef.current) advance(true);
    }, duration);
  }

  function pickVoice(): SpeechSynthesisVoice | null {
    const synth = synthRef.current;
    if (!synth) return null;
    const all = synth.getVoices();
    if (!all.length) return null;
    const byName = voiceRef.current ? all.find((voice) => voice.name === voiceRef.current) : undefined;
    if (byName) return byName;
    const russian = all.find((voice) => voice.lang.toLowerCase().startsWith('ru'));
    return russian ?? all[0];
  }

  function speakCurrent(): void {
    clearSim();
    clearWatchdog();
    const statsNow = statsRef.current;
    const ref = statsNow?.paragraphs[indexRef.current];
    if (!ref) return;
    const synth = synthRef.current;
    pausedRef.current = false;
    startedRef.current = false;
    if (!synth || forcedSimRef.current) {
      startSim();
      return;
    }
    try {
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(ref.text);
      utterance.lang = 'ru-RU';
      utterance.rate = clamp(rateRef.current, 0.5, 2);
      utterance.pitch = 1;
      const voice = pickVoice();
      if (voice) utterance.voice = voice;
      utterance.onstart = () => {
        if (utteranceRef.current !== utterance) return;
        startedRef.current = true;
        engineRef.current = 'tts';
        clearWatchdog();
        publish();
      };
      utterance.onend = () => {
        if (utteranceRef.current !== utterance) return;
        if (!playingRef.current) return;
        advance(true);
      };
      utterance.onerror = () => {
        if (utteranceRef.current !== utterance) return;
        forcedSimRef.current = true;
        if (playingRef.current) startSim();
      };
      utteranceRef.current = utterance;
      synth.speak(utterance);
      watchdogRef.current = window.setTimeout(() => {
        if (startedRef.current) return;
        // В окружении без голосов speechSynthesis молчит — переходим на демо-озвучку.
        forcedSimRef.current = true;
        try {
          synth.cancel();
        } catch {
          /* noop */
        }
        if (playingRef.current) startSim();
      }, 1700);
    } catch {
      forcedSimRef.current = true;
      startSim();
    }
  }

  function play(): void {
    if (!statsRef.current || !bookIdRef.current) return;
    saveCurrentProgress();
    sessionBookRef.current = bookIdRef.current;
    playingRef.current = true;
    if (pausedRef.current) {
      const synth = synthRef.current;
      if (engineRef.current === 'tts' && synth && synth.paused) {
        pausedRef.current = false;
        synth.resume();
        publish();
        return;
      }
      if (engineRef.current === 'sim' && simRemainingRef.current > 0) {
        pausedRef.current = false;
        simStartRef.current = performance.now();
        const remaining = simRemainingRef.current;
        engineRef.current = 'sim';
        publish();
        simTimerRef.current = window.setTimeout(() => {
          simTimerRef.current = null;
          if (playingRef.current) advance(true);
        }, remaining);
        return;
      }
    }
    speakCurrent();
    publish();
  }

  function pause(): void {
    if (!playingRef.current) return;
    playingRef.current = false;
    pausedRef.current = true;
    const synth = synthRef.current;
    if (engineRef.current === 'tts' && synth && synth.speaking) {
      try {
        synth.pause();
      } catch {
        /* noop */
      }
    }
    if (engineRef.current === 'sim') {
      simRemainingRef.current = Math.max(
        0,
        simDurationRef.current - (performance.now() - simStartRef.current),
      );
      clearSim();
    }
    flushSession();
    publish();
  }

  function toggle(): void {
    if (playingRef.current) pause();
    else play();
  }

  function goToIndex(target: number, keepPlaying: boolean): void {
    const statsNow = statsRef.current;
    if (!statsNow) return;
    indexRef.current = clamp(target, 0, Math.max(0, statsNow.paragraphs.length - 1));
    saveCurrentProgress();
    if (keepPlaying || playingRef.current) {
      playingRef.current = true;
      stopEngine();
      speakCurrent();
    } else {
      stopEngine();
      publish();
    }
  }

  const open = useCallback(
    async (bookId: string, locator?: Locator, autoplay = false) => {
      setError(null);
      const currentBook = bookIdRef.current;
      if (currentBook && currentBook !== bookId) {
        pause();
        flushSession();
        stopEngine();
        playingRef.current = false;
      }
      setLoading(true);
      try {
        const loaded = await loadBookContent(bookId);
        const statsNow = computeBookStats(loaded);
        contentRef.current = loaded;
        statsRef.current = statsNow;
        bookIdRef.current = bookId;
        setContent(loaded);
        setStats(statsNow);
        if (currentBook !== bookId) {
          elapsedRef.current = 0;
          const entry = appStateRef.current.progress[bookId];
          const initialLocator =
            locator ?? (entry ? { chapter: entry.chapter, paragraph: entry.paragraph } : { chapter: 0, paragraph: 0 });
          indexRef.current = flatIndexAt(statsNow, initialLocator);
          lastPercentRef.current = percentAtFlat(statsNow, indexRef.current);
          sessionSecondsRef.current = 0;
          pagesAccumRef.current = 0;
          sessionBookRef.current = bookId;
        } else if (locator) {
          indexRef.current = flatIndexAt(statsNow, locator);
          lastPercentRef.current = percentAtFlat(statsNow, indexRef.current);
        }
        setLoading(false);
        if (autoplay) play();
        else publish();
      } catch (caught) {
        setLoading(false);
        setError(caught instanceof Error ? caught.message : 'Не удалось открыть аудиокнигу');
        setSnapshot(null);
        throw caught;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flushSession, pause, play, publish, stopEngine],
  );

  const seekPercent = useCallback((percent: number) => {
    const statsNow = statsRef.current;
    if (!statsNow) return;
    const locator = locatorFromPercent(statsNow, clamp(percent, 0, 100));
    goToIndex(flatIndexAt(statsNow, locator), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seekLocator = useCallback((locator: Locator) => {
    const statsNow = statsRef.current;
    if (!statsNow) return;
    goToIndex(flatIndexAt(statsNow, locator), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = useCallback(() => {
    pause();
    flushSession();
    stopEngine();
    playingRef.current = false;
    bookIdRef.current = null;
    statsRef.current = null;
    contentRef.current = null;
    indexRef.current = 0;
    setSnapshot(null);
    setContent(null);
    setStats(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flushSession, pause, stopEngine]);

  const setRate = useCallback(
    (rate: number) => {
      rateRef.current = rate;
      updateSettings({ ttsRate: rate });
      if (playingRef.current && statsRef.current) {
        stopEngine();
        speakCurrent();
      }
      publish();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [publish, stopEngine, updateSettings],
  );

  const setVoice = useCallback(
    (name: string | null) => {
      voiceRef.current = name;
      updateSettings({ ttsVoice: name });
      if (playingRef.current && statsRef.current) {
        stopEngine();
        speakCurrent();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [speakCurrent, stopEngine, updateSettings],
  );

  const setSleep = useCallback(
    (minutes: number | null) => {
      sleepAtRef.current = minutes ? Date.now() + minutes * 60_000 : null;
      publish();
    },
    [publish],
  );

  // Тикер: копит время сессии и следит за таймером сна.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!playingRef.current) return;
      elapsedRef.current += 1;
      sessionSecondsRef.current += 1;
      if (sessionSecondsRef.current >= 60) {
        flushSession();
        sessionSecondsRef.current = 0;
      }
      if (sleepAtRef.current && Date.now() >= sleepAtRef.current) {
        sleepAtRef.current = null;
        pause();
        pushToast('Таймер сна выключил плеер', 'info');
      }
      publish();
    }, 1000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushSession();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [flushSession]);

  useEffect(() => {
    return () => {
      stopEngine();
    };
  }, [stopEngine]);

  const current = useMemo<ParagraphRef | null>(() => {
    if (!snapshot || !stats) return null;
    return stats.paragraphs[snapshot.index] ?? null;
  }, [snapshot, stats]);

  const value = useMemo<PlayerContextValue>(
    () => ({
      snapshot,
      content,
      stats,
      current,
      voices,
      voiceAvailable: voices.length > 0,
      loading,
      error,
      open,
      play,
      pause,
      toggle,
      next: () => goToIndex(indexRef.current + 1, false),
      prev: () => goToIndex(indexRef.current - 1, false),
      seekLocator,
      seekPercent,
      setRate,
      setVoice,
      setSleep,
      close,
      flush: flushSession,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, content, stats, current, voices, loading, error, open, seekLocator, seekPercent, setRate, setVoice, setSleep, close, flushSession],
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerContextValue {
  const context = useContext(PlayerContext);
  if (!context) throw new Error('usePlayer должен использоваться внутри PlayerProvider');
  return context;
}
