import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookContent, BookStats, DownloadProgress, Mode } from '../types';
import {
  computeBookStats,
  flatIndexAt,
  loadBookContent,
  locatorAtFlat,
  percentAtFlat,
} from '../lib/content';
import { getBook } from '../data/books';
import { downloads } from '../downloads/manager';
import type { NetworkBook } from '../downloads/types';
import { useApp } from '../lib/store';
import { recordReading } from '../prefs/repository';
import type { BookProfile } from '../prefs/types';
import { usePlayer } from '../lib/player';
import { navigate } from '../lib/router';
import { clamp, formatMinutes, plural, shortText } from '../lib/format';
import { Sheet } from '../components/Sheet';
import { Stars } from '../components/Stars';
import { Icon } from '../components/Icons';

interface ReaderProps {
  bookId: string;
  chapter?: number;
  paragraph?: number;
}

const THEMES = [
  { id: 'dark' as const, label: 'Тёмная' },
  { id: 'sepia' as const, label: 'Сепия' },
  { id: 'light' as const, label: 'Светлая' },
];

const HEADER_OFFSET = 104;

// Псевдоним, чтобы не тянуть тип в JSX-файл дважды.
type BookProfileBlock = BookProfile;

export function ReaderScreen({ bookId, chapter, paragraph }: ReaderProps) {
  const app = useApp();
  const player = usePlayer();
  const {
    state,
    saveProgress,
    addSession,
    markFinished,
    addBookmark,
    removeBookmark,
    updateSettings,
    pushToast,
    download,
  } = app;
  const builtinBook = getBook(bookId);
  const [netBook, setNetBook] = useState<NetworkBook | undefined>(() =>
    downloads.getLibrary().find((item) => item.id === bookId),
  );

  // Скачанная сетевая книга: метаданные берём из записи менеджера загрузок.
  useEffect(() => {
    if (builtinBook) return;
    let alive = true;
    const update = () => {
      if (alive) setNetBook(downloads.getLibrary().find((item) => item.id === bookId));
    };
    update();
    void downloads.init().then(update);
    const unsubscribe = downloads.subscribe(update);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [bookId, builtinBook]);

  /** Единые метаданные для встроенной и скачанной книги. */
  const meta = useMemo(() => {
    if (builtinBook) {
      return {
        title: builtinBook.title,
        author: builtinBook.author,
        pages: builtinBook.pages,
        minutes: builtinBook.minutes,
        chapters: builtinBook.chapters,
        sourceName: builtinBook.source?.name ?? 'Викитека',
        sourceEdition: builtinBook.source?.edition ?? '',
        sourceUrl: builtinBook.source?.url,
        kind: 'text' as const,
      };
    }
    if (!netBook) return null;
    const words = netBook.kind === 'text' ? Math.max(500, (netBook.chapters ?? 12) * 900) : 30_000;
    return {
      title: netBook.title,
      author: netBook.authors.join(', ') || 'Неизвестный автор',
      pages: Math.max(8, Math.round(words / 300)),
      minutes: Math.max(5, Math.round(words / 150)),
      chapters: [] as string[],
      sourceName: netBook.sourceName,
      sourceEdition: netBook.license ?? '',
      sourceUrl: netBook.sourceUrl,
      kind: netBook.kind,
    };
  }, [builtinBook, netBook]);

  const metaRef = useRef(meta);
  metaRef.current = meta;

  // Профиль книги для системы предпочтений (встроенная или скачанная сетевая).
  const prefProfile = useMemo<BookProfileBlock | null>(() => {
    const current = meta;
    if (!current) return null;
    const authors = current.author ? current.author.split(',').map((value) => value.trim()).filter(Boolean) : ['Автор неизвестен'];
    return {
      id: bookId,
      sourceId: builtinBook ? 'local' : (netBook?.sourceId ?? 'local'),
      sourceName: current.sourceName,
      title: current.title,
      authors,
      genres: current.kind === 'text' ? current.chapters.slice(0, 3) : [],
      subgenres: [],
      categories: ['fiction'],
      series: undefined,
      languages: [],
      year: undefined,
      description: undefined,
      coverUrl: netBook?.coverUrl,
      formats: builtinBook ? ['epub'] : [netBook?.format ?? 'epub'],
      pageUrl: current.sourceUrl,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    };
  }, [bookId, meta, builtinBook, netBook]);

  const [content, setContent] = useState<BookContent | null>(null);
  const [stats, setStats] = useState<BookStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [paragraphIndex, setParagraphIndex] = useState(0);
  const [scrollToken, setScrollToken] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [restoredHint, setRestoredHint] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const appStateRef = useRef(state);
  appStateRef.current = state;
  const statsRef = useRef<BookStats | null>(null);
  statsRef.current = stats;
  const contentRef = useRef<BookContent | null>(null);
  contentRef.current = content;
  const chapterRef = useRef(0);
  const paragraphRef = useRef(0);
  const readyRef = useRef(false);
  const pendingScrollRef = useRef<{ chapter: number; paragraph: number } | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const hintedRef = useRef(false);
  const activityRef = useRef({ activeMs: 0, pages: 0, lastPercent: 0 });

  const currentChapter = content?.chapters[chapterIndex];
  const currentParagraphText = currentChapter?.paragraphs[paragraphIndex] ?? '';

  // ------------------------------------------------------------------ загрузка
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFinishOpen(false);
    finishedRef.current = false;
    readyRef.current = false;
    pendingScrollRef.current = null;
    if (metaRef.current?.kind === 'pdf') {
      // PDF показываем встроенным просмотрщиком, текст не извлекаем.
      setContent(null);
      setStats(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    loadBookContent(bookId)
      .then((data) => {
        if (cancelled) return;
        const computed = computeBookStats(data);
        const entry = appStateRef.current.progress[bookId];
        let nextChapter = 0;
        let nextParagraph = 0;
        if (chapter !== undefined) {
          nextChapter = clamp(chapter, 0, data.chapters.length - 1);
          nextParagraph = clamp(paragraph ?? 0, 0, data.chapters[nextChapter].paragraphs.length - 1);
        } else if (entry && !entry.finishedAt) {
          nextChapter = clamp(entry.chapter, 0, data.chapters.length - 1);
          nextParagraph = clamp(
            entry.paragraph,
            0,
            data.chapters[nextChapter].paragraphs.length - 1,
          );
        }
        chapterRef.current = nextChapter;
        paragraphRef.current = nextParagraph;
        setChapterIndex(nextChapter);
        setParagraphIndex(nextParagraph);
        pendingScrollRef.current = { chapter: nextChapter, paragraph: nextParagraph };
        setStats(computed);
        setContent(data);
        const flat = flatIndexAt(computed, { chapter: nextChapter, paragraph: nextParagraph });
        activityRef.current = { activeMs: 0, pages: 0, lastPercent: percentAtFlat(computed, flat) };
        setRestoredHint(
          Boolean(
            chapter === undefined &&
              entry &&
              !entry.finishedAt &&
              (entry.percent ?? 0) > 2 &&
              !hintedRef.current,
          ),
        );
        hintedRef.current = true;
        setLoading(false);
        setScrollToken((value) => value + 1);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : 'Не удалось открыть книгу');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, chapter, paragraph, reloadKey]);

  useEffect(() => {
    if (!restoredHint) return;
    const timer = window.setTimeout(() => setRestoredHint(false), 3600);
    return () => window.clearTimeout(timer);
  }, [restoredHint]);

  // ------------------------------------------------ восстановление позиции
  useEffect(() => {
    if (!stats || !content) return;
    const pending = pendingScrollRef.current;
    if (!pending || pending.chapter !== chapterIndex) return;
    pendingScrollRef.current = null;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      scrollToParagraph(pending.paragraph, 'auto');
      window.setTimeout(() => {
        if (cancelled) return;
        readyRef.current = true;
        updateCurrentFromScroll();
      }, 110);
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, content, chapterIndex, scrollToken]);

  // ---------------------------------------------------- отслеживание скролла
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !stats) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      if (!readyRef.current) return;
      updateCurrentFromScroll();
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(measure);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    if (readyRef.current) measure();
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, chapterIndex]);

  // ------------------------------------------------------- учёт времени чтения
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      activityRef.current.activeMs += 1000;
      if (activityRef.current.activeMs >= 60_000) {
        const minutes = activityRef.current.activeMs / 60_000;
        addSession(bookId, 'read', minutes, activityRef.current.pages);
        activityRef.current.activeMs = 0;
        activityRef.current.pages = 0;
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [bookId, addSession]);

  // ------------------------------------------- сохранение при уходе с экрана
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      commitProgress(chapterRef.current, paragraphRef.current);
      if (activityRef.current.activeMs >= 5000 || activityRef.current.pages > 0.3) {
        addSession(bookId, 'read', activityRef.current.activeMs / 60_000, activityRef.current.pages);
        activityRef.current.activeMs = 0;
        activityRef.current.pages = 0;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        commitProgress(chapterRef.current, paragraphRef.current);
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commitProgress(nextChapter: number, nextParagraph: number, mode: Mode = 'read'): void {
    const statsNow = statsRef.current;
    if (!statsNow) return;
    const flat = flatIndexAt(statsNow, { chapter: nextChapter, paragraph: nextParagraph });
    const percent = percentAtFlat(statsNow, flat);
    const delta = Math.max(0, percent - activityRef.current.lastPercent);
    activityRef.current.pages += (delta / 100) * (metaRef.current?.pages ?? 0);
    activityRef.current.lastPercent = Math.max(activityRef.current.lastPercent, percent);
    saveProgress({
      bookId,
      chapter: nextChapter,
      paragraph: nextParagraph,
      percent,
      lastMode: mode,
    });
    if (prefProfile) void recordReading(prefProfile, percent, false);
  }

  function scheduleSave(nextChapter: number, nextParagraph: number): void {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(
      () => commitProgress(nextChapter, nextParagraph),
      320,
    );
  }

  function scrollToParagraph(targetParagraph: number, behavior: ScrollBehavior): void {
    const container = scrollRef.current;
    if (!container) return;
    const element = document.getElementById(`p-${chapterRef.current}-${targetParagraph}`);
    if (!element) return;
    const top =
      element.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      HEADER_OFFSET;
    container.scrollTo({ top: Math.max(0, top), behavior });
  }

  function updateCurrentFromScroll(): void {
    const container = scrollRef.current;
    const statsNow = statsRef.current;
    const data = contentRef.current;
    if (!container || !statsNow || !data) return;
    const chapterNow = chapterRef.current;
    const nodes = container.querySelectorAll<HTMLElement>('[data-paragraph]');
    if (nodes.length === 0) return;
    const containerTop = container.getBoundingClientRect().top;
    let candidate = 0;
    for (const node of nodes) {
      if (node.getBoundingClientRect().top - containerTop <= 130) {
        candidate = Number(node.dataset.paragraph);
      } else {
        break;
      }
    }
    const maxParagraph = data.chapters[chapterNow].paragraphs.length - 1;
    candidate = clamp(candidate, 0, maxParagraph);
    if (candidate !== paragraphRef.current) {
      paragraphRef.current = candidate;
      setParagraphIndex(candidate);
      scheduleSave(chapterNow, candidate);
    }
  }

  const goChapter = useCallback(
    (nextChapter: number, nextParagraph = 0) => {
      const data = contentRef.current;
      if (!data) return;
      const safeChapter = clamp(nextChapter, 0, data.chapters.length - 1);
      const maxParagraph = data.chapters[safeChapter].paragraphs.length - 1;
      const safeParagraph = clamp(nextParagraph, 0, maxParagraph);
      chapterRef.current = safeChapter;
      paragraphRef.current = safeParagraph;
      pendingScrollRef.current = { chapter: safeChapter, paragraph: safeParagraph };
      readyRef.current = false;
      setChapterIndex(safeChapter);
      setParagraphIndex(safeParagraph);
      setChaptersOpen(false);
      commitProgress(safeChapter, safeParagraph);
      setScrollToken((value) => value + 1);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bookId],
  );

  const listenFromHere = async () => {
    const statsNow = statsRef.current;
    if (!statsNow) return;
    const locator = locatorAtFlat(statsNow, flatIndexAt(statsNow, {
      chapter: chapterRef.current,
      paragraph: paragraphRef.current,
    }));
    try {
      await player.open(bookId, locator, true);
      navigate(`/listen/${bookId}`);
    } catch (caught) {
      pushToast(caught instanceof Error ? caught.message : 'Не удалось включить аудио', 'error');
    }
  };

  const retryDownload = async () => {
    setDownloadProgress(0);
    try {
      await download(bookId, (progress: DownloadProgress) => setDownloadProgress(progress.percent));
      setDownloadProgress(null);
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setDownloadProgress(null);
      pushToast(caught instanceof Error ? caught.message : 'Не удалось скачать книгу', 'error');
    }
  };

  if (meta?.kind === 'pdf') {
    return <PdfReader bookId={bookId} title={meta.title} author={meta.author} sourceName={meta.sourceName} />;
  }

  if (!meta) {
    return (
      <div className="reader reader--message">
        <p>Книга не найдена или ещё не скачана.</p>
        <button type="button" className="btn btn--ghost" onClick={() => navigate('/search')}>
          Найти книгу
        </button>
      </div>
    );
  }

  const percent = stats
    ? percentAtFlat(stats, flatIndexAt(stats, { chapter: chapterIndex, paragraph: paragraphIndex }))
    : 0;
  const downloaded = Boolean(state.downloads[bookId]);
  const chapterTitle = currentChapter?.title ?? meta.chapters[chapterIndex] ?? 'Текст';
  const nextChapterTitle = content?.chapters[chapterIndex + 1]?.title;
  const prevChapterTitle = content?.chapters[chapterIndex - 1]?.title;
  const isLastChapter = Boolean(content && chapterIndex === content.chapters.length - 1);
  const finished = Boolean(state.progress[bookId]?.finishedAt);
  const currentBookmark = content
    ? state.bookmarks.find(
        (bookmark) =>
          bookmark.bookId === bookId &&
          bookmark.chapter === chapterIndex &&
          bookmark.paragraph === paragraphIndex,
      )
    : undefined;
  const remainingMinutes = (meta.minutes * (100 - percent)) / 100;

  const toggleBookmark = () => {
    if (!currentParagraphText) return;
    if (currentBookmark) {
      removeBookmark(currentBookmark.id);
    } else {
      addBookmark({
        bookId,
        chapter: chapterIndex,
        paragraph: paragraphIndex,
        chapterTitle,
        text: shortText(currentParagraphText, 200),
      });
    }
  };

  const finishBook = () => {
    if (!content) return;
    const lastChapter = content.chapters.length - 1;
    const lastParagraph = content.chapters[lastChapter].paragraphs.length - 1;
    commitProgress(lastChapter, lastParagraph);
    markFinished(bookId);
    if (prefProfile) void recordReading(prefProfile, 100, true);
    finishedRef.current = true;
    setFinishOpen(true);
  };

  return (
    <div
      className="reader"
      data-theme={state.settings.appearanceMode === 'light' ? 'light' : state.settings.appearanceMode === 'dark' ? 'dark' : state.settings.appearanceTheme === 'ivory' || state.settings.theme === 'sepia' ? 'sepia' : 'dark'}
      style={{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ['--font-scale' as string]: String(state.settings.fontScale * (state.settings.uiFontScale ?? 1)),
        ['--reader-family' as string]: state.settings.serif
          ? 'var(--font-serif)'
          : 'var(--font-ui)',
      }}
    >
      <header className="reader__bar">
        <button
          type="button"
          className="icon-button"
          onClick={() => navigate(`/book/${bookId}`)}
          aria-label="Назад к книге"
        >
          <Icon name="left" size={22} />
        </button>
        <button type="button" className="reader__chapter-button" onClick={() => setChaptersOpen(true)}>
          <span className="reader__chapter-name">{chapterTitle}</span>
          <span className="reader__chapter-sub">
            {Math.round(percent)}% · {meta.title} · глава {chapterIndex + 1} из {meta.chapters.length || (content?.chapters.length ?? 1)}
          </span>
        </button>
        <div className="reader__bar-actions">
          <button
            type="button"
            className={`icon-button ${currentBookmark ? 'is-active' : ''}`}
            onClick={toggleBookmark}
            aria-label={currentBookmark ? 'Убрать закладку' : 'Добавить закладку'}
          >
            <Icon name="bookmark" size={19} filled={Boolean(currentBookmark)} />
          </button>
          <button
            type="button"
            className="icon-button reader__aa"
            onClick={() => setSettingsOpen(true)}
            aria-label="Настройки чтения"
          >
            Aa
          </button>
        </div>
      </header>
      <div className="reader__progress">
        <span style={{ width: `${Math.max(1, percent)}%` }} />
      </div>

      {loading && (
        <div className="reader__loading">
          <div className="skeleton skeleton--line" style={{ width: '70%' }} />
          <div className="skeleton skeleton--line" style={{ width: '92%' }} />
          <div className="skeleton skeleton--line" style={{ width: '84%' }} />
          <div className="skeleton skeleton--line" style={{ width: '88%' }} />
          <div className="skeleton skeleton--line" style={{ width: '56%' }} />
          <p>Открываем книгу…</p>
        </div>
      )}

      {!loading && error && (
        <div className="reader__error">
          <span className="reader__error-icon">
            <Icon name="wifiOff" size={28} />
          </span>
          <h2>Книга недоступна офлайн</h2>
          <p>{error}</p>
          {downloadProgress === null ? (
            <button type="button" className="btn btn--primary" onClick={() => void retryDownload()}>
              Скачать книгу
            </button>
          ) : (
            <div className="reader__error-progress">Скачиваем… {Math.round(downloadProgress)}%</div>
          )}
          <button type="button" className="btn btn--ghost" onClick={() => navigate(`/book/${bookId}`)}>
            К описанию книги
          </button>
        </div>
      )}

      {!loading && !error && content && stats && (
        <>
          <div className="reader__scroll" ref={scrollRef}>
            <div className="reader__content">
              {chapterIndex === 0 && (
                <div className="reader__book-head">
                  <div className="reader__book-title" style={{ fontSize: `${state.settings.fontScale * 13}px`, fontFamily: state.settings.serif ? 'var(--font-serif)' : 'var(--font-ui)' }}>{meta.title}</div>
                  <div className="reader__book-author">{meta.author}</div>
                  <div className="reader__source-line">
                    Полный текст · источник: {meta.sourceName}
                    {meta.sourceEdition ? ` · ${meta.sourceEdition}` : ''}
                  </div>
                  {downloaded && (
                    <div className="reader__offline">
                      <Icon name="check" size={13} /> скачано в базу приложения · доступно офлайн
                    </div>
                  )}
                </div>
              )}

              <section className="reader__chapter">
                <h2 className="reader__chapter-title">{chapterTitle}</h2>
                {currentChapter?.paragraphs.map((text, index) => (
                  <p
                    key={index}
                    id={`p-${chapterIndex}-${index}`}
                    data-paragraph={index}
                    className={`reader__p ${index === paragraphIndex ? 'is-current' : ''}`}
                  >
                    {text}
                  </p>
                ))}
              </section>

              <div className="reader__chapter-nav">
                {chapterIndex > 0 && (
                  <button
                    type="button"
                    className="reader__chapter-link"
                    onClick={() => goChapter(chapterIndex - 1, 0)}
                  >
                    <Icon name="left" size={16} />
                    <span>
                      <small>Предыдущая глава</small>
                      {prevChapterTitle}
                    </span>
                  </button>
                )}
                {!isLastChapter ? (
                  <button
                    type="button"
                    className="reader__chapter-link reader__chapter-link--next"
                    onClick={() => goChapter(chapterIndex + 1, 0)}
                  >
                    <span>
                      <small>Следующая глава</small>
                      {nextChapterTitle}
                    </span>
                    <Icon name="right" size={16} />
                  </button>
                ) : (
                  <div className="reader__end">
                    <span className="reader__end-mark">Конец книги</span>
                    <p>
                      {finished
                        ? 'Вы уже дочитали эту книгу.'
                        : 'Дочитали до конца? Отметьте книгу — она уйдёт в «Готово», а страницы попадут в цели.'}
                    </p>
                    {!finished && (
                      <button type="button" className="btn btn--primary" onClick={finishBook}>
                        Отметить прочитанной
                      </button>
                    )}
                    <button type="button" className="btn btn--ghost" onClick={() => navigate('/library')}>
                      На мою полку
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <footer className="reader__foot">
            <span className="reader__foot-info">
              {Math.round(percent)}% · осталось ~{formatMinutes(remainingMinutes)}
            </span>
            <button type="button" className="reader__listen" onClick={() => void listenFromHere()}>
              <Icon name="headphones" size={17} />
              Слушать отсюда
            </button>
          </footer>
        </>
      )}

      {restoredHint && (
        <div className="reader__restored">
          <Icon name="bookmark" size={15} />
          Продолжаем с места, где вы остановились
        </div>
      )}

      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Настройки чтения">
        <div className="reader-settings">
          <div className="field">
            <span className="field__label">Тема</span>
            <div className="segmented">
              {THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  className={`segmented__item ${state.settings.theme === theme.id ? 'is-active' : ''}`}
                  onClick={() => updateSettings({ theme: theme.id })}
                >
                  {theme.label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <div className="field__row">
              <span className="field__label">Размер шрифта</span>
              <span className="muted">{Math.round(state.settings.fontScale * 100)}%</span>
            </div>
            <input
              className="range"
              type="range"
              min={0.86}
              max={1.34}
              step={0.02}
              value={state.settings.fontScale}
              onChange={(event) => updateSettings({ fontScale: Number(event.target.value) })}
              aria-label="Размер шрифта"
            />
          </div>
          <button
            type="button"
            className="setting-button"
            onClick={() => updateSettings({ serif: !state.settings.serif })}
          >
            <Icon name="book" size={18} />
            {state.settings.serif ? 'Шрифт с засечками включён' : 'Шрифт без засечек'}
            <span className={`switch ${state.settings.serif ? 'is-on' : ''}`}>
              <span className="switch__thumb" />
            </span>
          </button>
          <button
            type="button"
            className="btn btn--primary btn--wide"
            onClick={() => {
              setSettingsOpen(false);
              void listenFromHere();
            }}
          >
            <Icon name="headphones" size={19} />
            Слушать с этого места
          </button>
          <p className="reader-settings__hint">
            Аудио начнётся с текущего абзаца. Позиция общая: вернувшись в текст, вы окажетесь там же, где остановилось
            аудио.
          </p>
          <div className="reader-settings__download">
            {downloaded ? (
              <span>
                <Icon name="check" size={14} /> Книга сохранена в базе приложения и доступна офлайн
              </span>
            ) : (
              <button type="button" className="link-button" onClick={() => void retryDownload()}>
                {downloadProgress !== null
                  ? `Скачиваем… ${Math.round(downloadProgress)}%`
                  : 'Скачать книгу для офлайна'}
              </button>
            )}
          </div>
        </div>
      </Sheet>

      <Sheet open={chaptersOpen} onClose={() => setChaptersOpen(false)} title="Содержание" subtitle={meta.title}>
        <div className="chapter-list">
          {(content?.chapters.map((item) => item.title) ?? meta.chapters).map((title, index) => (
            <button
              key={`${title}-${index}`}
              type="button"
              className="chapter-row"
              onClick={() => goChapter(index, 0)}
            >
              <span className="chapter-row__num">{String(index + 1).padStart(2, '0')}</span>
              <span className="chapter-row__title">{title}</span>
              {chapterIndex === index && <span className="chapter-row__now">читаю</span>}
              <Icon name="right" size={16} className="muted" />
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet
        open={finishOpen}
        onClose={() => setFinishOpen(false)}
        title="Книга прочитана!"
        subtitle={`${meta.title} · ${meta.author}`}
      >
        <div className="finish-sheet">
          <div className="finish-sheet__emoji">🎉</div>
          <p>
            Книга добавлена в «Готово», а {meta.pages} {plural(meta.pages, 'страница', 'страницы', 'страниц')} ушли в
            цели. Поставьте оценку — рекомендации станут точнее.
          </p>
          <Stars
            value={state.ratings[bookId]?.stars ?? 0}
            size={30}
            onChange={(stars) => app.rateBook(bookId, stars, state.ratings[bookId]?.liked ?? false)}
            label="Оцените книгу"
          />
          <div className="finish-sheet__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                setFinishOpen(false);
                navigate('/library');
              }}
            >
              На полку
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setFinishOpen(false);
                void listenFromHere();
              }}
            >
              <Icon name="headphones" size={18} />
              Слушать
            </button>
          </div>
          <p className="finish-sheet__note">Источник текста: {meta.sourceName}</p>
        </div>
      </Sheet>
    </div>
  );
}


/** Встроенный просмотрщик PDF: файл лежит в IndexedDB, открывается через blob URL. */
function PdfReader({
  bookId,
  title,
  author,
  sourceName,
}: {
  bookId: string;
  title: string;
  author: string;
  sourceName: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    downloads
      .getBlob(bookId)
      .then((blob) => {
        if (!alive) return;
        if (!blob) {
          setError('Файл PDF не найден в памяти приложения.');
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((caught: unknown) => {
        if (alive) setError(caught instanceof Error ? caught.message : 'Не удалось открыть PDF');
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bookId]);

  return (
    <div className="reader reader--pdf" data-theme="dark">
      <header className="reader__bar">
        <button type="button" className="icon-button" onClick={() => navigate('/my')} aria-label="Назад к моим книгам">
          <Icon name="left" size={22} />
        </button>
        <div className="reader__chapter-button">
          <span className="reader__chapter-name">{title}</span>
          <span className="reader__chapter-sub">
            {author} · PDF · источник: {sourceName}
          </span>
        </div>
        <div className="reader__bar-actions">
          {url && (
            <a className="icon-button" href={url} target="_blank" rel="noreferrer" aria-label="Открыть в новой вкладке">
              <Icon name="download" size={19} />
            </a>
          )}
        </div>
      </header>
      {error && (
        <div className="reader__error">
          <h2>Не удалось открыть PDF</h2>
          <p>{error}</p>
        </div>
      )}
      {!error && !url && (
        <div className="reader__loading">
          <div className="skeleton skeleton--line" style={{ width: '70%' }} />
          <div className="skeleton skeleton--line" style={{ width: '90%' }} />
          <p>Открываем PDF…</p>
        </div>
      )}
      {url && <iframe className="reader__pdf-frame" src={url} title={title} />}
    </div>
  );
}
