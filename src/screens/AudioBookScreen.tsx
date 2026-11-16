/**
 * Экран аудиокниги: настоящие дорожки LibriVox / Internet Archive.
 * Если у источника аудио нет — честно говорим об этом и предлагаем
 * поиск в LibriVox или чтение текста, без выдуманных треков.
 */
import { useEffect, useReducer, useState } from 'react';
import type { AudioTrack, CatalogBook } from '../catalog/types';
import type { NetworkBook } from '../downloads/types';
import type { DownloadStatus } from '../downloads/types';
import { getSource } from '../catalog/registry';
import { recallBook, rememberBooks } from '../catalog/cache';
import { downloads } from '../downloads/manager';
import { AUDIO_RATES, readAudioPosition, useAudioPlayer } from '../audio/AudioPlayer';
import { useApp } from '../lib/store';
import { navigate, openCatalogBook, openReader } from '../lib/router';
import { formatMinutes, formatSeconds, humanBytes, plural } from '../lib/format';
import { NetworkCover } from '../components/NetworkCover';
import { ProgressBar } from '../components/Progress';
import { Icon } from '../components/Icons';

const ACTIVE_STATUSES: DownloadStatus[] = ['queued', 'downloading', 'validating', 'processing'];

let initPromise: Promise<void> | null = null;

function ensureDownloadsReady(): Promise<void> {
  if (!initPromise) {
    initPromise = downloads.init().catch((error: unknown) => {
      console.warn('Не удалось открыть хранилище загрузок', error);
    });
  }
  return initPromise;
}

function isActive(status: DownloadStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

function isTrackDownloaded(networkBook: NetworkBook | undefined, track: AudioTrack, index: number): boolean {
  const tracks = networkBook?.audioTracks ?? [];
  if (tracks.length === 0) return false;
  if (tracks.some((item) => item.title === track.title)) return true;
  return index < tracks.length;
}

/**
 * Карточка из скачанной копии — на случай, когда кэш каталога уже истёк,
 * а интернета нет. Треки здесь настоящие: это файлы, лежащие в IndexedDB.
 */
function catalogBookFromNetwork(networkBook: NetworkBook): CatalogBook {
  const tracks: AudioTrack[] = (networkBook.audioTracks ?? []).map((track) => ({
    title: track.title,
    url: '',
    sizeBytes: track.bytes,
    durationSec: track.durationSec,
  }));
  return {
    id: networkBook.catalogId ?? `${networkBook.sourceId}:${networkBook.externalId}`,
    sourceId: networkBook.sourceId,
    externalId: networkBook.externalId,
    title: networkBook.title,
    authors: networkBook.authors,
    year: networkBook.year,
    description: networkBook.description,
    subjects: networkBook.subjects,
    coverUrl: networkBook.coverUrl,
    files: [],
    access: 'download',
    audio: tracks.length > 0 ? { tracks, sourceUrl: networkBook.sourceUrl } : undefined,
    source: {
      sourceId: networkBook.sourceId,
      sourceName: networkBook.sourceName,
      pageUrl: networkBook.sourceUrl,
      license: networkBook.license,
    },
    fetchedAt: networkBook.savedAt,
  };
}

export function AudioBookScreen({ bookId }: { bookId: string }) {
  const player = useAudioPlayer();
  const { pushToast } = useApp();

  const [book, setBook] = useState<CatalogBook | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(() => readAudioPosition(bookId)?.trackIndex ?? 0);
  const [savedPosition, setSavedPosition] = useState(() => readAudioPosition(bookId));
  const [online, setOnline] = useState(() => navigator.onLine);
  const [, bump] = useReducer((value: number) => value + 1, 0);

  useEffect(() => {
    const sync = () => bump();
    const unsubscribe = downloads.subscribe(sync);
    sync();
    void ensureDownloadsReady().then(sync);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    const position = readAudioPosition(bookId);
    setSavedPosition(position);
    setSelectedIndex(position?.trackIndex ?? 0);
  }, [bookId]);

  useEffect(() => {
    if (player.book?.id !== bookId) return;
    setSelectedIndex(player.trackIndex);
  }, [bookId, player.book?.id, player.trackIndex]);

  useEffect(() => {
    const [sourceId, ...rest] = bookId.split(':');
    const externalId = rest.join(':');
    const source = sourceId ? getSource(sourceId) : undefined;
    const controller = new AbortController();
    let cancelled = false;

    setLoading(true);
    setLoadError(null);

    void (async () => {
      let cached: CatalogBook | null = null;
      try {
        cached = await recallBook(bookId);
      } catch {
        cached = null;
      }

      // Скачанная копия: работает, даже если кэш каталога истёк и сети нет.
      let downloadedCopy: CatalogBook | null = null;
      try {
        await ensureDownloadsReady();
        const networkBook = downloads.findByCatalogId(bookId);
        if (networkBook?.audioTracks?.length) downloadedCopy = catalogBookFromNetwork(networkBook);
      } catch {
        downloadedCopy = null;
      }
      if (cancelled) return;
      if (cached) setBook(cached);

      let fresh: CatalogBook | null = null;
      const needsAudio = !cached?.audio?.tracks?.length;
      if (needsAudio && source?.details && navigator.onLine) {
        try {
          fresh = await source.details(externalId, { online: true, signal: controller.signal });
        } catch (cause) {
          console.warn('Не удалось обновить карточку аудиокниги', cause);
        }
      }
      if (cancelled) return;
      if (fresh) {
        setBook(fresh);
        void rememberBooks([fresh]);
      } else if (needsAudio && downloadedCopy?.audio) {
        if (cached) {
          setBook({
            ...cached,
            coverUrl: cached.coverUrl ?? downloadedCopy.coverUrl,
            audio: downloadedCopy.audio,
            source: {
              ...cached.source,
              pageUrl: cached.source.pageUrl ?? downloadedCopy.source.pageUrl,
              license: cached.source.license ?? downloadedCopy.source.license,
            },
          });
        } else {
          setBook(downloadedCopy);
        }
      } else if (!cached && downloadedCopy) {
        setBook(downloadedCopy);
      }
      if (!cached && !fresh && !downloadedCopy) {
        if (!source) setLoadError('Источник этой книги не найден в «Полке».');
        else if (!navigator.onLine) setLoadError('Нет интернета — карточка книги ещё не сохранена на устройстве.');
        else setLoadError('Не удалось загрузить карточку книги. Попробуйте ещё раз.');
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [bookId, reloadKey]);

  const goBack = () => {
    if (window.history.length > 1) window.history.back();
    else navigate('/my');
  };

  if (loading && !book) {
    return (
      <div className="screen audio-screen">
        <header className="audio-screen__bar">
          <button type="button" className="icon-button" onClick={goBack} aria-label="Назад">
            <Icon name="left" size={22} />
          </button>
          <span className="audio-screen__bar-label">Аудиокнига</span>
          <span className="audio-screen__bar-spacer" />
        </header>
        <div className="audio-loading">
          <div className="spinner" />
          <p>Загружаем аудиокнигу…</p>
        </div>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="screen audio-screen">
        <header className="audio-screen__bar">
          <button type="button" className="icon-button" onClick={goBack} aria-label="Назад">
            <Icon name="left" size={22} />
          </button>
          <span className="audio-screen__bar-label">Аудиокнига</span>
          <span className="audio-screen__bar-spacer" />
        </header>
        <div className="empty">
          <div className="empty__icon">
            <Icon name="headphones" size={26} />
          </div>
          <h2 className="empty__title">Не удалось открыть книгу</h2>
          <p className="empty__text">{loadError ?? 'Попробуйте открыть карточку книги из каталога ещё раз.'}</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              setReloadKey((value) => value + 1);
            }}
          >
            Повторить
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => navigate('/search')}>
            В поиск
          </button>
        </div>
      </div>
    );
  }

  const tracks = book.audio?.tracks ?? [];
  const hasAudio = tracks.length > 0;
  const networkBook = downloads.findByCatalogId(bookId);
  const downloadedBook = networkBook;
  const tasks = downloads.getTasks().filter((task) => task.book.id === bookId);
  const activeTasks = tasks.filter((task) => isActive(task.status));
  const failedTasks = tasks.filter((task) => task.status === 'error');
  const downloadPercent =
    tasks.length > 0
      ? Math.round(tasks.reduce((sum, task) => sum + (task.progress.percent || 0), 0) / tasks.length)
      : 0;
  const downloadedChapters = tracks.filter((track, index) => isTrackDownloaded(networkBook, track, index)).length;
  const allDownloaded = hasAudio && downloadedChapters >= tracks.length;
  const downloadBusy = activeTasks.length > 0;
  const downloadFailed = failedTasks.length > 0;

  const isCurrent = player.book?.id === book.id;
  const activeIndex = hasAudio
    ? Math.min(isCurrent ? player.trackIndex : selectedIndex, Math.max(0, tracks.length - 1))
    : 0;
  const activeTrack: AudioTrack | undefined = tracks[activeIndex];
  const isSavedTrack = !isCurrent && savedPosition?.trackIndex === activeIndex;
  const displayedTime = isCurrent ? player.currentTime : isSavedTrack ? (savedPosition?.currentTime ?? 0) : 0;
  const displayedDuration = isCurrent
    ? player.duration || activeTrack?.durationSec || 0
    : activeTrack?.durationSec || 0;
  const progressPercent =
    displayedDuration > 0 ? Math.min(100, Math.max(0, (displayedTime / displayedDuration) * 100)) : 0;
  const rangeMax = Math.max(1, displayedDuration, displayedTime);

  const totalSeconds = tracks.reduce((sum, track) => sum + (track.durationSec ?? 0), 0);
  const totalBytes = tracks.reduce((sum, track) => sum + (track.sizeBytes ?? 0), 0);
  const narrators = book.audio?.narrators?.filter(Boolean) ?? [];
  const sourceDef = getSource(book.sourceId);
  const sourcePageUrl =
    book.source.pageUrl ?? book.audio?.sourceUrl ?? book.accessUrl ?? sourceDef?.homepage;
  const sourceLicense = book.source.license ?? sourceDef?.licenseNote;
  const librivoxUrl = `https://librivox.org/search?q=${encodeURIComponent(book.title)}`;
  const hasFiles =
    book.files.some((file) => file.format !== 'audio' && Boolean(file.url)) ||
    Boolean(downloadedBook && downloadedBook.kind !== 'audio');

  const playTrack = (index: number) => {
    if (!hasAudio) return;
    const safeIndex = Math.min(Math.max(0, index), tracks.length - 1);
    setSelectedIndex(safeIndex);
    if (isCurrent && safeIndex === player.trackIndex) {
      player.toggle();
      return;
    }
    void player.open(book, safeIndex, true);
  };

  const handlePlayPause = () => {
    if (!hasAudio) return;
    if (isCurrent) player.toggle();
    // Без явного номера главы провайдер восстановит сохранённую позицию.
    else void player.open(book, undefined, true);
  };

  const handlePrev = () => {
    if (!hasAudio) return;
    if (isCurrent) {
      player.prev();
      return;
    }
    playTrack((activeIndex - 1 + tracks.length) % tracks.length);
  };

  const handleNext = () => {
    if (!hasAudio) return;
    if (isCurrent) {
      player.next();
      return;
    }
    playTrack((activeIndex + 1) % tracks.length);
  };

  const handleSeek = (seconds: number) => {
    if (!isCurrent) return;
    player.seek(seconds);
  };

  const handleDownload = () => {
    if (!hasAudio) return;
    if (downloadFailed) {
      const retry = failedTasks.map((task) => downloads.retry(task.id));
      void Promise.all(retry)
        .then(() => pushToast('Повторяем скачивание глав', 'info'))
        .catch(() => pushToast('Не удалось повторить скачивание глав', 'error'));
      return;
    }
    try {
      downloads.enqueueAudio(book, tracks);
      pushToast('Скачиваем главы — они будут доступны офлайн', 'info');
    } catch {
      pushToast('Не удалось начать скачивание глав', 'error');
    }
  };

  const readText = () => {
    if (downloadedBook && downloadedBook.kind !== 'audio') openReader(downloadedBook.id);
    else openCatalogBook(book.id);
  };

  let downloadLabel = 'Скачать все главы';
  if (allDownloaded) downloadLabel = 'Все главы на устройстве';
  else if (downloadBusy) downloadLabel = `Скачиваем главы… ${downloadPercent}%`;
  else if (downloadFailed) downloadLabel = 'Повторить скачивание глав';

  return (
    <div className="screen audio-screen">
      <header className="audio-hero">
        <div className="audio-hero__bar">
          <button type="button" className="icon-button" onClick={goBack} aria-label="Назад">
            <Icon name="left" size={22} />
          </button>
          <span className="audio-hero__source">{book.source.sourceName}</span>
          <button type="button" className="icon-button" onClick={() => navigate('/my')} aria-label="Мои книги">
            <Icon name="library" size={18} />
          </button>
        </div>

        <div className="audio-hero__main">
          <div className="audio-hero__cover">
            <NetworkCover book={book} size="xl" />
          </div>
          <div className="audio-hero__text">
            <span className="eyebrow">{hasAudio ? 'Аудиокнига' : 'Книга'}</span>
            <h1 className="audio-hero__title">{book.title}</h1>
            <p className="audio-hero__author">
              {book.authors.length > 0 ? book.authors.join(', ') : 'Автор неизвестен'}
            </p>
            <p className="audio-hero__facts">
              {[
                book.year ? String(book.year) : '',
                hasAudio ? `${tracks.length} ${plural(tracks.length, 'глава', 'главы', 'глав')}` : '',
                totalSeconds > 0 ? formatMinutes(totalSeconds / 60) : '',
                totalBytes > 0 ? humanBytes(totalBytes) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {narrators.length > 0 && <p className="audio-hero__narrator">Читает {narrators.join(', ')}</p>}
            {downloadedChapters > 0 && (
              <span className="lib-badge lib-badge--audio audio-hero__offline">
                <Icon name="check" size={11} />
                {allDownloaded
                  ? 'Все главы на устройстве'
                  : `${downloadedChapters} из ${tracks.length} глав на устройстве`}
              </span>
            )}
          </div>
        </div>
      </header>

      {player.error && isCurrent && (
        <div className="audio-error">
          <Icon name="wifiOff" size={16} />
          {player.error}
        </div>
      )}

      {hasAudio ? (
        <>
          <section className="audio-player">
            <div className="audio-progress">
              <input
                className="range range--player"
                type="range"
                min={0}
                max={rangeMax}
                step={1}
                value={Math.min(displayedTime, rangeMax)}
                onChange={(event) => handleSeek(Number(event.target.value))}
                disabled={!isCurrent || displayedDuration <= 0}
                aria-label="Позиция в главе"
              />
              <div className="audio-progress__time">
                <span>{formatSeconds(displayedTime)}</span>
                <span>−{formatSeconds(Math.max(0, displayedDuration - displayedTime))}</span>
              </div>
            </div>

            <div className="audio-controls">
              <button type="button" className="player-skip" onClick={handlePrev} aria-label="Предыдущая глава">
                <Icon name="skipBack" size={26} />
              </button>
              <button
                type="button"
                className="player-play"
                onClick={handlePlayPause}
                aria-label={isCurrent && player.playing ? 'Пауза' : 'Слушать'}
              >
                <Icon name={isCurrent && player.playing ? 'pause' : 'play'} size={30} />
              </button>
              <button type="button" className="player-skip" onClick={handleNext} aria-label="Следующая глава">
                <Icon name="skipForward" size={26} />
              </button>
            </div>

            <div className="player-rates audio-rates">
              {AUDIO_RATES.map((rate) => (
                <button
                  key={rate}
                  type="button"
                  className={`chip ${Math.abs(player.rate - rate) < 0.01 ? 'is-active' : ''}`}
                  onClick={() => player.setRate(rate)}
                >
                  ×{rate}
                </button>
              ))}
            </div>

            <p className="audio-progress__hint">
              {isCurrent
                ? player.playing
                  ? `Играет: ${player.trackTitle || activeTrack?.title || 'глава'}`
                  : `Пауза: ${player.trackTitle || activeTrack?.title || 'глава'}`
                : isSavedTrack && (savedPosition?.currentTime ?? 0) > 0
                  ? `Продолжим с ${formatSeconds(savedPosition?.currentTime ?? 0)} в главе ${activeIndex + 1}`
                  : 'Нажмите «Слушать», чтобы начать с сохранённого места'}
            </p>

            {isCurrent && player.downloadedOnly && (
              <span className="audio-progress__offline">
                <Icon name="check" size={13} />
                Играет с устройства
              </span>
            )}
          </section>

          <section className="section audio-chapters">
            <div className="section__head">
              <div>
                <h2 className="section__title">Главы</h2>
                <p className="section__sub">
                  {tracks.length} {plural(tracks.length, 'дорожка', 'дорожки', 'дорожек')}
                  {totalSeconds > 0 ? ` · ${formatMinutes(totalSeconds / 60)}` : ''}
                </p>
              </div>
            </div>
            <div className="audio-track-list">
              {tracks.map((track, index) => {
                const current = index === activeIndex;
                const playingThis = current && isCurrent && player.playing;
                const downloaded = isTrackDownloaded(networkBook, track, index);
                const meta = [
                  track.durationSec ? formatMinutes(track.durationSec / 60) : '',
                  track.sizeBytes ? humanBytes(track.sizeBytes) : '',
                  downloaded ? 'скачано' : '',
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <button
                    key={`${index}-${track.title}`}
                    type="button"
                    className={`audio-track ${current ? 'is-current' : ''} ${playingThis ? 'is-playing' : ''}`}
                    onClick={() => playTrack(index)}
                  >
                    <span className="audio-track__num">
                      {playingThis ? <Icon name="volume" size={14} /> : String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="audio-track__body">
                      <span className="audio-track__title">{track.title}</span>
                      {meta && <span className="audio-track__meta">{meta}</span>}
                    </span>
                    <span className="audio-track__side">
                      {current && <span className="audio-track__now">{playingThis ? 'играет' : 'текущая'}</span>}
                      <Icon name={playingThis ? 'pause' : 'play'} size={16} />
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="section audio-download">
            <div className="section__head">
              <div>
                <h2 className="section__title">Офлайн-аудио</h2>
                <p className="section__sub">Скачанные главы играют без интернета — прямо из памяти устройства</p>
              </div>
            </div>
            <button
              type="button"
              className={`btn ${allDownloaded ? 'btn--ghost' : 'btn--primary'} btn--wide`}
              onClick={handleDownload}
              disabled={allDownloaded || downloadBusy}
            >
              <Icon name={allDownloaded ? 'check' : 'download'} size={18} />
              {downloadLabel}
            </button>
            {downloadBusy && (
              <div className="audio-download__progress">
                <ProgressBar value={downloadPercent} height={5} />
                <span>
                  {downloadPercent}% · {activeTasks.length} из {tracks.length} глав
                </span>
              </div>
            )}
            {downloadFailed && !downloadBusy && (
              <p className="audio-download__error">
                Не все главы скачались. Проверьте интернет и нажмите «Повторить скачивание глав».
              </p>
            )}
            <p className="audio-download__hint">
              Скачанные дорожки хранятся в IndexedDB и не требуют сети. Удалить их можно на экране «Загрузки».
            </p>
          </section>
        </>
      ) : (
        <div className="audio-note">
          <div className="audio-note__icon">
            <Icon name="headphones" size={24} />
          </div>
          <h2 className="audio-note__title">Аудиоверсия не найдена у источника</h2>
          <p className="audio-note__text">
            У книги «{book.title}» в источнике {book.source.sourceName} нет аудиодорожек. Мы не подставляем чужое
            аудио: можно поискать озвучку в LibriVox или прочитать текст в приложении.
          </p>
          <div className="audio-note__actions">
            <a className="btn btn--primary" href={librivoxUrl} target="_blank" rel="noopener noreferrer">
              <Icon name="search" size={17} />
              Найти в LibriVox
            </a>
            {hasFiles && (
              <button type="button" className="btn btn--ghost" onClick={readText}>
                <Icon name="book" size={17} />
                Читать текст
              </button>
            )}
          </div>
          {!online && (
            <p className="audio-note__hint">
              Вы офлайн — ссылка на LibriVox откроется, когда появится интернет. Скачанный текст доступен сразу.
            </p>
          )}
        </div>
      )}

      <footer className="audio-source">
        <p>
          Источник:{' '}
          {sourcePageUrl ? (
            <a href={sourcePageUrl} target="_blank" rel="noopener noreferrer">
              {book.source.sourceName}
            </a>
          ) : (
            book.source.sourceName
          )}
          {sourceLicense ? ` · ${sourceLicense}` : ''}
        </p>
        {book.audio?.sourceUrl && book.audio.sourceUrl !== sourcePageUrl && (
          <p>
            <a href={book.audio.sourceUrl} target="_blank" rel="noopener noreferrer">
              Официальная страница аудиокниги
            </a>
          </p>
        )}
        <p className="audio-source__note">
          Аудиокниги LibriVox и Internet Archive — общественное достояние. Позиция сохраняется в этом браузере
          автоматически.
        </p>
      </footer>

      {isCurrent && (
        <div className="audio-nowbar">
          <div className="audio-nowbar__progress">
            <span style={{ width: `${Math.max(2, progressPercent)}%` }} />
          </div>
          <NetworkCover book={book} size="xxs" />
          <div className="audio-nowbar__body">
            <strong>{player.trackTitle || activeTrack?.title || book.title}</strong>
            <span>
              {player.playing ? 'Играет' : 'Пауза'} · {book.title}
              {player.downloadedOnly ? ' · офлайн' : ''}
            </span>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={player.toggle}
            aria-label={player.playing ? 'Пауза' : 'Слушать'}
          >
            <Icon name={player.playing ? 'pause' : 'play'} size={19} />
          </button>
          <button type="button" className="icon-button" onClick={player.next} aria-label="Следующая глава">
            <Icon name="skipForward" size={19} />
          </button>
        </div>
      )}
    </div>
  );
}
