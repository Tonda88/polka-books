import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store';
import { navigate, openMyBooks, openReader } from '../lib/router';
import { Icon } from '../components/Icons';
import { formatNumber } from '../lib/format';
import { apiBase, getSearchServer, setSearchServer } from '../discovery/config';
import { fetchProviders } from '../discovery/api';
import { getCustomSearxInstances, setCustomSearxInstances } from '../discovery/searx';
import { internetSearch } from '../discovery/engine';
import { downloadBookFile } from '../discovery/download';
import type { BookCandidate, BookFile, InternetSearchResult, ProviderStatus } from '../discovery/types';
import { directProviders } from '../discovery/direct';
import { usePreferences } from '../hooks/usePreferences';
import { Sheet } from '../components/Sheet';
import { prepareImport, commitImport } from '../webcatalog/library';
import { isNativeApp, listPendingImports, readPendingImport, clearPendingImports, subscribeNativeImports } from '../webcatalog/browser';
import type { BookDraft } from '../webcatalog/types';

const ACCESS_LABELS: Record<string, string> = {
  ok: 'Доступен',
  requiresAuth: 'Требуется авторизация',
  purchase: 'Только покупка',
  missing: 'Файл отсутствует',
  blocked: 'Источник запрещает автоскачивание',
  unavailable: 'Недоступен',
  invalid: 'Неверная ссылка',
};

const HISTORY_KEY = 'polka:search-history:v1';
const FORMAT_FILTERS = ['all', 'epub', 'fb2', 'pdf', 'txt', 'mobi'] as const;
type FormatFilter = (typeof FORMAT_FILTERS)[number];
type ResultSort = 'relevance' | 'downloadable' | 'title' | 'year';

function readHistory(): string[] {
  try {
    const value = localStorage.getItem(HISTORY_KEY);
    return value ? (JSON.parse(value) as string[]).slice(0, 8) : [];
  } catch {
    return [];
  }
}

function writeHistory(items: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 8)));
  } catch {
    /* localStorage недоступен */
  }
}

function humanBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/**
 * Главный экран поиска: универсальный интернет-поиск книг.
 * Результаты приходят из серверного агрегатора поисковых API,
 * страницы анализируются, файлы проверяются и скачиваются в приложение.
 */
export function InternetSearchScreen() {
  const app = useApp();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<InternetSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState('');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState(getSearchServer);
  const [providersOnline, setProvidersOnline] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [downloading, setDownloading] = useState<Record<string, { loaded: number; total: number; percent: number }>>({});
  // --- импорт файлов ---
  const [draft, setDraft] = useState<BookDraft | null>(null);
  const [draftBytes, setDraftBytes] = useState<Uint8Array | null>(null);
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [native] = useState(isNativeApp);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<string[]>(readHistory);
  const [formatFilter, setFormatFilter] = useState<FormatFilter>('all');
  const [genreFilter, setGenreFilter] = useState('all');
  const [sortMode, setSortMode] = useState<ResultSort>('relevance');
  const [customSearx, setCustomSearx] = useState(() => getCustomSearxInstances().join('\n'));
  const abortRef = useRef<AbortController | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settings = app.state.settings;
  const preferences = usePreferences();
  const [activeSearx, setActiveSearx] = useState<Array<{ url: string; success: number; checkedAt: number }>>([]);
  const keys = useMemo(
    () => ({
      googleCseKey: settings.googleCseKey ?? null,
      googleCseCx: settings.googleCseCx ?? null,
      bingKey: settings.bingKey ?? null,
      yandexXmlUser: settings.yandexXmlUser ?? null,
      yandexXmlKey: settings.yandexXmlKey ?? null,
      yandexXmlLr: settings.yandexXmlLr ?? null,
    }),
    [settings.googleCseKey, settings.googleCseCx, settings.bingKey, settings.yandexXmlUser, settings.yandexXmlKey, settings.yandexXmlLr],
  );
  const directInfo = useMemo(() => directProviders(keys), [keys]);

  // --- обработчики импорта файлов ---
  const handleImportFile = async (file: File) => {
    setImportError(null);
    setPreparing(true);
    setDraft(null);
    setDraftBytes(null);
    setIsDuplicate(false);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = await prepareImport({ kind: 'file', name: file.name, bytes, mime: file.type || undefined, origin: 'Файл с устройства' });
      if (!r.ok || !r.draft) { setImportError(r.error ?? 'Не удалось распознать книгу'); return; }
      setDraft(r.draft);
      setDraftBytes(bytes);
      setIsDuplicate(Boolean(r.draft.duplicateOf));
    } finally {
      setPreparing(false);
    }
  };

  const saveDraft = async () => {
    if (!draft || !draftBytes) return;
    setSaving(true);
    setImportError(null);
    try {
      const r = await commitImport(draft, draftBytes);
      if (!r.ok) { setImportError(r.error ?? 'Не удалось добавить книгу'); return; }
      if (r.duplicateOf) { app.pushToast('Такая книга уже есть в библиотеке — открываем её', 'info'); openMyBooks(); return; }
      app.pushToast('Книга добавлена в «Мои книги»', 'success');
      setDraft(null);
      setDraftBytes(null);
      openMyBooks();
    } finally {
      setSaving(false);
    }
  };

  const updateDraft = (field: keyof BookDraft, value: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      if (field === 'authors') return { ...prev, authors: value.split(',').map((s) => s.trim()).filter(Boolean) };
      if (field === 'year') return { ...prev, year: value ? Number(value.replace(/\D/g, '').slice(0, 4)) || undefined : undefined };
      return { ...prev, [field]: value };
    });
  };

  // Нативный импорт (SAF / «Поделиться» из браузера Android).
  useEffect(() => {
    if (!native) return;
    const consume = (items: Array<{ id: string; name: string; origin: string }>) => {
      const first = items[0];
      if (!first) return;
      const bytes = readPendingImport(first.id);
      clearPendingImports();
      if (!bytes) { app.pushToast('Не удалось прочитать скачанный файл', 'error'); return; }
      void (async () => {
        setPreparing(true);
        try {
          const r = await prepareImport({ kind: first.origin === 'picker' ? 'file' : 'browser', name: first.name, bytes, origin: first.origin });
          if (!r.ok || !r.draft) { setImportError(r.error ?? 'Не удалось распознать книгу'); return; }
          setDraft(r.draft);
          setDraftBytes(bytes);
        } finally { setPreparing(false); }
      })();
    };
    consume(listPendingImports());
    return subscribeNativeImports(consume);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  const connect = async () => {
    setSearchServer(serverUrl);
    setError(null);
    const status = await fetchProviders();
    setProvidersOnline(status.online);
    setProviders(status.providers);
    if (status.online) {
      app.pushToast('Сервер поиска подключён', 'success');
    } else {
      app.pushToast('Сервер не отвечает по этому адресу', 'error');
    }
  };

  const run = async (value?: string) => {
    const clean = (value ?? query).trim();
    if (!clean) return;
    setQuery(clean);
    setHistory((previous) => {
      const next = [clean, ...previous.filter((item) => item !== clean)].slice(0, 8);
      writeHistory(next);
      return next;
    });
    setFormatFilter('all');
    setGenreFilter('all');
    setSortMode('relevance');
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setStage('Поиск в интернете…');
    setPercent(3);
    setResult(null);
    try {
      const answer = await internetSearch(clean, {
        signal: controller.signal,
        keys,
        forceDirect: preferences.mode === 'device',
        onProgress: (label, value) => {
          setStage(label);
          setPercent(value);
        },
      });
      setResult(answer);
      setProvidersOnline(answer.mode === 'server');
      setProviders(answer.providers);
      setActiveSearx(answer.searxInstances ?? []);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Поиск не удался';
      setError(message);
      setProvidersOnline(message.includes('сервер') ? false : providersOnline);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const startDownload = async (book: BookCandidate, file: BookFile) => {
    const key = `${book.id}:${file.url}`;
    setDownloading((previous) => ({ ...previous, [key]: { loaded: 0, total: 0, percent: 0 } }));
    const outcome = await downloadBookFile(file, {
      onProgress: (loaded, total, value) =>
        setDownloading((previous) => ({ ...previous, [key]: { loaded, total, percent: value } })),
    });
    setDownloading((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
    if (!outcome.ok) {
      app.pushToast(outcome.error ?? 'Не удалось скачать книгу', 'error');
      return;
    }
    app.pushToast(`Книга «${outcome.draft?.title ?? book.title}» добавлена в библиотеку`, 'success');
    if (outcome.localId) {
      setImported((previous) => ({ ...previous, [book.id]: outcome.localId! }));
    }
  };

  useEffect(() => {
    // Адрес сервера из настроек профиля имеет приоритет над локальным.
    if (settings.searchServerUrl) setSearchServer(settings.searchServerUrl);
    void (async () => {
      const status = await fetchProviders();
      setProvidersOnline(status.online);
      setProviders(status.providers);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.searchServerUrl]);

  const availableProviders = providers.filter((provider) => provider.available);
  const keyProviders = providers.filter((provider) => provider.requiresKey && !provider.available);
  const webApiAvailable = availableProviders.some((provider) =>
    ['google', 'bing', 'brave', 'yandex', 'marginalia', 'searx'].includes(provider.id),
  );

  const serverHint = useMemo(() => {
    if (preferences.mode === 'device') {
      const free = directInfo.filter((provider) => provider.available).length + 1;
      return `Встроенный поиск · без сервера · ${free} бесплатных источников`;
    }
    if (providersOnline === false) return 'Встроенный поиск · серверный агрегатор недоступен';
    if (providersOnline === null) return 'Проверяем сервер…';
    return `Серверный агрегатор · ${availableProviders.length} из ${providers.length} провайдеров`;
  }, [preferences.mode, providersOnline, availableProviders.length, providers.length, directInfo]);

  const resultFormats = useMemo(() => {
    const present = new Set<string>();
    for (const book of result?.books ?? []) for (const file of book.files) present.add(file.format.toLowerCase());
    return FORMAT_FILTERS.filter((item) => item === 'all' || present.has(item));
  }, [result]);

  const resultGenres = useMemo(() => {
    const present = new Set<string>();
    for (const book of result?.books ?? []) for (const genre of book.genres ?? []) present.add(genre);
    return [...present];
  }, [result]);

  const visibleBooks = useMemo(() => {
    let list = result?.books ?? [];
    if (formatFilter !== 'all') list = list.filter((book) => book.files.some((file) => file.format.toLowerCase() === formatFilter));
    if (genreFilter !== 'all') list = list.filter((book) => book.genres?.includes(genreFilter));
    const sorted = [...list];
    switch (sortMode) {
      case 'downloadable':
        sorted.sort((a, b) => Number(b.downloadable) - Number(a.downloadable));
        break;
      case 'title':
        sorted.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
        break;
      case 'year':
        sorted.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
        break;
      default:
        break;
    }
    return sorted;
  }, [result, formatFilter, genreFilter, sortMode]);

  return (
    <div className="screen internet-search-screen">
      <header className="search-hero">
        <div className="page-head">
          <h1 className="page-title">Поиск книг в интернете</h1>
          <p className="page-sub">
            Ищем по всему вебу через SearXNG, открытые поисковые API и книжные каталоги. Анализируем страницы и находим
            файлы EPUB, FB2, PDF, TXT, MOBI.
          </p>
        </div>

        <div className="search-field">
          <Icon name="search" size={19} className="search-field__icon" />
          <input
            type="search"
            className="search-field__input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void run();
            }}
            placeholder="Название книги или автор"
            aria-label="Название книги или автор"
            enterKeyHint="search"
          />
        </div>
        <div className="discovery-mode">
          <span className={`discovery-mode__badge ${result?.mode === 'server' ? 'is-server' : 'is-direct'}`}>
            {result?.mode === 'server' ? 'Серверный агрегатор' : 'Встроенный поиск · Android'}
          </span>
          <button type="button" className="link-button" onClick={() => setSettingsOpen(true)}>
            Источники поиска
          </button>
        </div>

        <div className="discovery-actions">
          <button type="button" className="btn btn--primary" onClick={() => void run()} disabled={loading || !query.trim()}>
            <Icon name="search" size={18} />
            {loading ? 'Ищем…' : 'Найти книгу'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => navigate('/catalogs')}>
            <Icon name="library" size={18} />
            Каталоги
          </button>
        </div>

        {history.length > 0 && !loading && !result && (
          <div className="search-history">
            <div className="search-history__head">
              <span>История запросов</span>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setHistory([]);
                  writeHistory([]);
                }}
              >
                Очистить
              </button>
            </div>
            <div className="chips-row chips-row--wrap">
              {history.map((item) => (
                <button key={item} type="button" className="chip" onClick={() => void run(item)}>
                  {item}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="discovery-providers">
          <span className={`status-dot ${preferences.mode === 'device' || providersOnline ? 'is-online' : 'is-offline'}`} />
          <span className="discovery-providers__label">{serverHint}</span>
          {preferences.mode === 'device' ? (
            <>
              <span className="discovery-chip is-on" title="Публичные узлы из официального реестра SearXNG">
                SearXNG
              </span>
              {directInfo.map((provider) => (
                <span
                  key={provider.id}
                  className={`discovery-chip ${provider.available ? 'is-on' : 'is-key'}`}
                  title={provider.note}
                >
                  {provider.name}
                  {provider.available ? '' : ' · ключ'}
                </span>
              ))}
            </>
          ) : (
            <>
              {availableProviders.slice(0, 6).map((provider) => (
                <span key={provider.id} className="discovery-chip is-on" title={provider.note}>
                  {provider.name}
                </span>
              ))}
              {keyProviders.map((provider) => (
                <span key={provider.id} className="discovery-chip is-key" title={`${provider.note}: ключ задаётся на сервере`}>
                  {provider.name} · ключ
                </span>
              ))}
            </>
          )}
        </div>

        {preferences.mode === 'device' && !result && (
          <div className="discovery-setup discovery-setup--direct">
            <p>
              <strong>Без компьютера и обязательного сервера.</strong> Используем открытые поисковые API и публичные SearXNG-узлы из официального реестра. Узлы проверяются, кэшируются и переключаются автоматически.
              {activeSearx.length > 0 && <> Сейчас доступны SearXNG: {activeSearx.map((item) => new URL(item.url).hostname).join(', ')}.</>}
            </p>
            <p className="discovery-setup__hint">
              Бесплатные публичные узлы могут временно ограничивать запросы. Если все недоступны, продолжают работать Crossref, OpenAlex и книжные API. Безопасный парсинг выдачи Google/Яндекса не используется.
            </p>
          </div>
        )}

        {providersOnline === false && preferences.mode !== 'device' && (
          <div className="discovery-setup">
            <p>
              Для веб-поиска нужен сервер с ключами поисковых API — ключи нельзя держать в APK. Запустите
              <code> pnpm serve </code> на компьютере и укажите его адрес.
            </p>
            <div className="discovery-setup__row">
              <input
                className="text-input"
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder="http://192.168.0.10:4173"
                aria-label="Адрес сервера поиска"
              />
              <button type="button" className="mini-button" onClick={() => void connect()}>
                Подключиться
              </button>
            </div>
            <p className="discovery-setup__hint">
              Текущий адрес: {apiBase() || 'не задан'}. Ключи на сервере: GOOGLE_CSE_KEY + GOOGLE_CSE_CX, BING_SEARCH_KEY,
              BRAVE_SEARCH_KEY, YANDEX_XML_USER + YANDEX_XML_KEY или SEARX_URL.
            </p>
          </div>
        )}

        {providersOnline && !webApiAvailable && (
          <p className="discovery-hint">
            Сейчас работают открытые провайдеры (Marginalia, Crossref, OpenAlex, открытые библиотеки). Чтобы включить
            Google, Bing, Brave или Яндекс — задайте ключи на сервере поиска.
          </p>
        )}
      </header>

      {loading && (
        <div className="discovery-progress" role="status" aria-live="polite">
          <span>{stage}</span>
          <div className="pref-progress">
            <span style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="discovery-error">
          <Icon name="wifiOff" size={18} />
          <div>
            <strong>Поиск не удался</strong>
            <p>{error}</p>
          </div>
        </div>
      )}

      {result && !loading && (
        <div className="discovery-results">
          <div className="discovery-summary">
            <span>
              Найдено {formatNumber(result.books.length)} {result.books.length === 1 ? 'книга' : 'книг'} за {result.tookMs} мс
            </span>
            {result.books.some((book) => book.downloadable) && (
              <span className="discovery-summary__ok">есть файлы для скачивания</span>
            )}
          </div>

          {(resultFormats.length > 1 || resultGenres.length > 0) && (
            <div className="discovery-filters">
              {resultGenres.length > 0 && (
                <div className="chips-row chips-row--wrap">
                  <button
                    type="button"
                    className={`chip ${genreFilter === 'all' ? 'is-active' : ''}`}
                    onClick={() => setGenreFilter('all')}
                  >
                    Все жанры
                  </button>
                  {resultGenres.map((genre) => (
                    <button
                      key={genre}
                      type="button"
                      className={`chip ${genreFilter === genre ? 'is-active' : ''}`}
                      onClick={() => setGenreFilter(genreFilter === genre ? 'all' : genre)}
                    >
                      {genre}
                    </button>
                  ))}
                </div>
              )}
              <div className="discovery-filters__row">
                <div className="chips-row chips-row--wrap">
                  {resultFormats.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={`chip ${formatFilter === item ? 'is-active' : ''}`}
                      onClick={() => setFormatFilter(item)}
                    >
                      {item === 'all' ? 'Все форматы' : item.toUpperCase()}
                    </button>
                  ))}
                </div>
                <label className="discovery-sort">
                  <span>Сортировка</span>
                  <select
                    className="select"
                    value={sortMode}
                    onChange={(event) => setSortMode(event.target.value as ResultSort)}
                  >
                    <option value="relevance">По релевантности</option>
                    <option value="downloadable">Сначала с файлами</option>
                    <option value="title">По названию</option>
                    <option value="year">По году</option>
                  </select>
                </label>
              </div>
            </div>
          )}

          {visibleBooks.length === 0 && result.books.length > 0 && (
            <p className="section-empty">
              Нет книг с такими фильтрами.{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setFormatFilter('all');
                  setGenreFilter('all');
                  setSortMode('relevance');
                }}
              >
                Сбросить
              </button>
            </p>
          )}

          {result.books.length === 0 && (
            <p className="section-empty">Ничего не нашли. Попробуйте другое название или уточните автора.</p>
          )}

          <div className="discovery-list">
            {visibleBooks.map((book) => {
              const localId = imported[book.id];
              return (
                <article className="discovery-card" key={book.id}>
                  <div className="discovery-card__cover">
                    {book.coverUrl ? (
                      <img src={book.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                      <span>{book.title.slice(0, 1).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="discovery-card__body">
                    <div className="discovery-card__head">
                      <h2 className="discovery-card__title">{book.title}</h2>
                      <span className="discovery-card__engine">{book.engine}</span>
                    </div>
                    <p className="discovery-card__author">
                      {book.authors.length > 0 ? book.authors.join(', ') : 'Автор не указан'}
                      {book.year ? ` · ${book.year}` : ''}
                      {book.language ? ` · ${book.language}` : ''}
                    </p>
                    {book.description && <p className="discovery-card__desc">{book.description}</p>}

                    {book.files.length > 0 ? (
                      <div className="discovery-files">
                        {book.files.map((file) => {
                          const key = `${book.id}:${file.url}`;
                          const progress = downloading[key];
                          return (
                            <div className={`discovery-file ${file.access === 'ok' ? 'is-ok' : 'is-off'}`} key={file.url}>
                              <span className="discovery-file__format">{file.format.toUpperCase()}</span>
                              <span className="discovery-file__size">{humanBytes(file.sizeBytes)}</span>
                              {progress ? (
                                <span className="discovery-file__progress">
                                  <span className="pref-progress">
                                    <span style={{ width: `${progress.percent}%` }} />
                                  </span>
                                  {progress.total > 0 ? `${progress.percent}%` : 'качаем…'}
                                </span>
                              ) : file.access === 'ok' ? (
                                <button type="button" className="mini-button" onClick={() => void startDownload(book, file)}>
                                  <Icon name="download" size={14} />
                                  Скачать
                                </button>
                              ) : (
                                <span className="discovery-file__reason">{ACCESS_LABELS[file.access] ?? 'Недоступен'}</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="discovery-card__reason">{book.reason ?? 'Файл не найден'}</p>
                    )}

                    <div className="discovery-card__footer">
                      <a
                        className="link-button"
                        href={book.pageUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Страница источника
                      </a>
                      {localId && (
                        <>
                          <button type="button" className="link-button" onClick={() => openReader(localId)}>
                            Читать
                          </button>
                          <button type="button" className="link-button" onClick={() => openMyBooks()}>
                            Мои книги
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}


      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Источники поиска" subtitle="Ключи хранятся только на этом устройстве" full>
        <div className="discovery-settings">
          <label className="web-field">
            <span>Адрес сервера поиска (необязательно)</span>
            <input
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="http://192.168.0.10:4173"
              inputMode="url"
            />
          </label>
          <button
            type="button"
            className="mini-button"
            onClick={() => {
              void connect();
              app.updateSettings({ searchServerUrl: serverUrl.trim() || null });
              setSettingsOpen(false);
            }}
          >
            Сохранить адрес и проверить
          </button>

          <label className="web-field">
            <span>Свои экземпляры SearXNG (по одному в строке)</span>
            <textarea
              rows={2}
              value={customSearx}
              onChange={(event) => setCustomSearx(event.target.value)}
              placeholder="https://searx.example.com"
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="mini-button"
            onClick={() => {
              const saved = setCustomSearxInstances(customSearx);
              setCustomSearx(saved.join('\n'));
              app.pushToast(
                saved.length > 0 ? `Сохранено экземпляров: ${saved.length}` : 'Свои экземпляры удалены',
                'success',
              );
            }}
          >
            Сохранить экземпляры SearXNG
          </button>

          <p className="pref-card__hint">
            Без сервера работают SearXNG (публичные узлы из официального реестра), Crossref, OpenAlex, Open Library и
            Gutenberg. Google и Bing включаются своими ключами — они сохраняются в памяти приложения и не попадают в код.
          </p>

          <label className="web-field">
            <span>Google Custom Search API key</span>
            <input
              type="password"
              value={settings.googleCseKey ?? ''}
              onChange={(event) => app.updateSettings({ googleCseKey: event.target.value.trim() || null })}
              placeholder="AIza…"
            />
          </label>
          <label className="web-field">
            <span>Google CSE идентификатор (cx)</span>
            <input
              value={settings.googleCseCx ?? ''}
              onChange={(event) => app.updateSettings({ googleCseCx: event.target.value.trim() || null })}
              placeholder="0123456789:abcdefghijk"
            />
          </label>
          <label className="web-field">
            <span>Bing Web Search key</span>
            <input
              type="password"
              value={settings.bingKey ?? ''}
              onChange={(event) => app.updateSettings({ bingKey: event.target.value.trim() || null })}
              placeholder="32-символьный ключ Azure"
            />
          </label>

          <label className="web-field">
            <span>Яндекс XML — логин</span>
            <input
              value={settings.yandexXmlUser ?? ''}
              onChange={(event) => app.updateSettings({ yandexXmlUser: event.target.value.trim() || null })}
              placeholder="login@yandex.ru"
              autoComplete="off"
            />
          </label>
          <label className="web-field">
            <span>Яндекс XML — ключ</span>
            <input
              type="password"
              value={settings.yandexXmlKey ?? ''}
              onChange={(event) => app.updateSettings({ yandexXmlKey: event.target.value.trim() || null })}
              placeholder="XXXX-XXXX-XXXX-XXXX"
            />
          </label>
          <label className="web-field">
            <span>Яндекс — регион (lr, по умолчанию 213 = Москва)</span>
            <input
              value={settings.yandexXmlLr ?? ''}
              onChange={(event) => app.updateSettings({ yandexXmlLr: event.target.value.trim() || null })}
              placeholder="213"
              inputMode="numeric"
            />
          </label>

          <div className="discovery-direct-list">
            {directInfo.map((provider) => (
              <span key={provider.id} className={`discovery-chip ${provider.available ? 'is-on' : 'is-key'}`}>
                {provider.name}
                {provider.available ? '' : ' · нужен ключ'}
              </span>
            ))}
          </div>

          <p className="pref-card__hint">
            Ключи Google CSE: console.cloud.google.com → Custom Search API. Идентификатор cx: programmablesearchengine.google.com.
            Bing: portal.azure.com → Bing Search.
          </p>
        </div>
      </Sheet>

      {!result && !loading && providersOnline && (
        <p className="discovery-legal">
          Приложение не парсит поисковую выдачу и не обходит DRM, CAPTCHA, авторизацию или платный доступ. Если файл
          доступен только за покупку — будет показана причина, а не фиктивная кнопка.
        </p>
      )}

      {/* --- Импорт файла --- */}
      <div className="web-import-section">
        <h2 className="section-title">Добавить книгу из файла</h2>
        <p className="section-sub">EPUB, FB2, PDF, TXT, MOBI — файл останется в приложении и будет доступен офлайн.</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".epub,.fb2,.pdf,.txt,.mobi,.azw3,application/epub+zip,application/pdf,text/plain"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleImportFile(f); e.target.value = ''; }}
          className="web-file-input"
        />
        <button type="button" className="btn btn--ghost" onClick={() => fileInputRef.current?.click()} disabled={preparing}>
          <Icon name="download" size={18} />
          {preparing ? 'Читаем файл…' : 'Выбрать файл'}
        </button>

        {importError && <p className="web-error">{importError}</p>}

        {draft && (
          <div className="web-draft">
            <div className="web-draft__head">
              <span className="web-draft__format">{draft.format.toUpperCase()}</span>
              <span className="web-draft__name">{draft.title || 'Без названия'}</span>
            </div>
            {isDuplicate && (
              <p className="web-draft__duplicate">Уже в библиотеке — книга с таким названием и автором уже есть в «Моих книгах».</p>
            )}
            <label className="web-field">
              <span>Название</span>
              <input value={draft.title ?? ''} onChange={(e) => updateDraft('title', e.target.value)} />
            </label>
            <label className="web-field">
              <span>Автор</span>
              <input value={draft.authors.join(', ')} onChange={(e) => updateDraft('authors', e.target.value)} placeholder="Автор через запятую" />
            </label>
            <label className="web-field">
              <span>Год</span>
              <input value={draft.year?.toString() ?? ''} onChange={(e) => updateDraft('year', e.target.value)} inputMode="numeric" />
            </label>
            <button type="button" className="btn btn--primary" onClick={() => void saveDraft()} disabled={saving}>
              {saving ? 'Сохраняем…' : 'Добавить в библиотеку'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
