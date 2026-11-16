import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store';
import { openMyBooks, openReader } from '../lib/router';
import { Icon } from '../components/Icons';
import { buildWebQuery, SEARCH_ENGINES, SEARCH_PRESETS, getEngine } from '../webcatalog/providers';
import type { BookDraft, SearchEngineId, WebSearchHistoryEntry } from '../webcatalog/types';
import { openInAppBrowser, isNativeApp, pickFileNative, shareContent, subscribeNativeImports, listPendingImports, readPendingImport, clearPendingImports } from '../webcatalog/browser';
import { prepareImport, commitImport, downloadToImport } from '../webcatalog/library';
import { recordSearch } from '../prefs/repository';

const HISTORY_KEY = 'polka:websearch-history';
const ENGINE_KEY = 'polka:websearch-engine';

function loadHistory(): WebSearchHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WebSearchHistoryEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, 12) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: WebSearchHistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, 12)));
  } catch {
    /* localStorage может быть недоступен */
  }
}

function loadEngine(): SearchEngineId {
  try {
    const raw = localStorage.getItem(ENGINE_KEY) as SearchEngineId | null;
    if (raw && SEARCH_ENGINES.some((engine) => engine.id === raw)) return raw;
  } catch {
    /* ignore */
  }
  return 'google';
}

/**
 * «Поиск в интернете»: реальные поисковики + встроенный браузер + импорт
 * скачанных файлов с распознаванием метаданных.
 */
export function WebSearchScreen() {
  const app = useApp();
  const [engine, setEngine] = useState<SearchEngineId>(loadEngine);
  const [query, setQuery] = useState('');
  const [author, setAuthor] = useState('');
  const [preset, setPreset] = useState<'any' | 'epub' | 'fb2' | 'pdf' | 'txt' | 'mobi' | 'audiobook'>('epub');
  const [history, setHistory] = useState<WebSearchHistoryEntry[]>(loadHistory);
  const [draft, setDraft] = useState<BookDraft | null>(null);
  const [draftBytes, setDraftBytes] = useState<Uint8Array | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [native] = useState(isNativeApp);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [openLink, setOpenLink] = useState<{ url: string; engine: SearchEngineId } | null>(null);

  const engineInfo = getEngine(engine);

  useEffect(() => {
    localStorage.setItem(ENGINE_KEY, engine);
  }, [engine]);

  // ---------------------------------------------------------------- поиск
  const preview = useMemo(
    () => buildWebQuery(query || 'название книги', author || undefined, preset, engine).text,
    [query, author, preset, engine],
  );

  const runSearch = (title = query, keepPreset = preset) => {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      app.pushToast('Введите название книги или имя автора', 'info');
      return;
    }
    const built = buildWebQuery(cleanTitle, author.trim() || undefined, keepPreset, engine);
    const entry: WebSearchHistoryEntry = { ...built, id: `web:${built.at}:${Math.random().toString(36).slice(2, 6)}` };
    const next = [entry, ...history.filter((item) => item.text !== entry.text)].slice(0, 12);
    setHistory(next);
    saveHistory(next);
    void recordSearch(entry.text, []);
    const openedInside = openInAppBrowser(entry.url);
    setOpenLink(native ? null : { url: entry.url, engine: entry.engine });
    app.pushToast(
      openedInside
        ? 'Открыли поиск в браузере приложения'
        : 'Если вкладка не открылась — нажмите «Открыть страницу поиска» ниже',
      'info',
    );
  };

  const openHistory = (entry: WebSearchHistoryEntry) => {
    setQuery(entry.title);
    setAuthor(entry.author ?? '');
    setPreset(entry.preset);
    setEngine(entry.engine);
    openInAppBrowser(entry.url);
  };

  const copyLink = async (entry: WebSearchHistoryEntry) => {
    try {
      await navigator.clipboard.writeText(entry.url);
      app.pushToast('Ссылка скопирована', 'success');
    } catch {
      app.pushToast('Не удалось скопировать ссылку', 'error');
    }
  };

  // ---------------------------------------------------------------- импорт
  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setPreparing(true);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await prepareImport({
          kind: 'file',
          name: file.name,
          bytes,
          mime: file.type || undefined,
          origin: 'Файл с устройства',
        });
        if (!result.ok || !result.draft) {
          setError(result.error ?? 'Не удалось распознать книгу');
          return;
        }
        setDraft(result.draft);
        setDraftBytes(bytes);
      } finally {
        setPreparing(false);
      }
    },
    [],
  );

  const handleUrlDownload = async () => {
    if (!urlInput.trim()) return;
    setError(null);
    setPreparing(true);
    try {
      const result = await downloadToImport(urlInput.trim());
      if (!result.ok || !result.draft) {
        setError(result.error ?? 'Не удалось скачать файл');
        return;
      }
      setDraft(result.draft);
      const response = await fetch(result.draft.fileName === '' ? urlInput : urlInput).catch(() => null);
      // Байты для сохранения: перечитываем через prepareImport-путь.
      if (response?.ok) {
        setDraftBytes(new Uint8Array(await response.arrayBuffer()));
      }
    } finally {
      setPreparing(false);
    }
  };

  // Импорт из нативной части: скачивание в браузере, SAF, «Поделиться».
  useEffect(() => {
    if (!native) return;
    const consume = (items: Array<{ id: string; name: string; origin: string }>) => {
      const first = items[0];
      if (!first) return;
      const bytes = readPendingImport(first.id);
      clearPendingImports();
      if (!bytes) {
        app.pushToast('Не удалось прочитать скачанный файл', 'error');
        return;
      }
      void (async () => {
        setPreparing(true);
        try {
          const result = await prepareImport({
            kind: first.origin === 'picker' ? 'file' : 'browser',
            name: first.name,
            bytes,
            origin: first.origin,
          });
          if (!result.ok || !result.draft) {
            setError(result.error ?? 'Не удалось распознать книгу');
            return;
          }
          setDraft(result.draft);
          setDraftBytes(bytes);
        } finally {
          setPreparing(false);
        }
      })();
    };
    consume(listPendingImports());
    return subscribeNativeImports(consume);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  const updateDraft = (field: keyof BookDraft, value: string) => {
    setDraft((current) => {
      if (!current) return current;
      if (field === 'authors') {
        return { ...current, authors: value.split(',').map((item) => item.trim()).filter(Boolean) };
      }
      if (field === 'languages') {
        return { ...current, languages: value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean) };
      }
      if (field === 'year') {
        return { ...current, year: value ? Number(value.replace(/\D/g, '').slice(0, 4)) || undefined : undefined };
      }
      return { ...current, [field]: value };
    });
  };

  const saveDraft = async () => {
    if (!draft || !draftBytes) return;
    setSaving(true);
    setError(null);
    try {
      const result = await commitImport(draft, draftBytes);
      if (!result.ok) {
        setError(result.error ?? 'Не удалось добавить книгу');
        return;
      }
      if (result.duplicateOf) {
        app.pushToast('Такая книга уже есть в библиотеке — открываем её', 'info');
        openMyBooks();
        return;
      }
      app.pushToast('Книга добавлена в «Мои книги»', 'success');
      setDraft(null);
      setDraftBytes(null);
      setUrlInput('');
      openMyBooks();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="screen web-search-screen">
      <header className="search-hero">
        <div className="page-head">
          <h1 className="page-title">Поиск в интернете</h1>
          <p className="page-sub">
            Google, Яндекс, Bing и DuckDuckGo открывают реальную выдачу — находите издание на сайте и скачивайте
            разрешённые файлы. Парсинг выдачи не используется.
          </p>
        </div>

        <div className="chips-row chips-row--wrap web-engines" role="group" aria-label="Поисковая система">
          {SEARCH_ENGINES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`chip ${engine === item.id ? 'is-active' : ''}`}
              style={{ ['--engine-hue' as string]: String(item.hue) }}
              onClick={() => setEngine(item.id)}
              aria-pressed={engine === item.id}
            >
              {item.name}
            </button>
          ))}
        </div>
        <p className="web-engine-note">{engineInfo.note}</p>

        <div className="search-field">
          <Icon name="search" size={19} className="search-field__icon" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') runSearch();
            }}
            placeholder="Название книги или автор"
            aria-label="Название книги"
            enterKeyHint="search"
          />
        </div>
        <div className="web-author-row">
          <input
            className="text-input"
            value={author}
            onChange={(event) => setAuthor(event.target.value)}
            placeholder="Автор (необязательно)"
            aria-label="Автор"
          />
          <button type="button" className="btn btn--primary" onClick={() => runSearch()}>
            <Icon name="compass" size={18} />
            Искать
          </button>
        </div>

        <div className="chips-row chips-row--wrap" role="group" aria-label="Формат">
          {SEARCH_PRESETS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`chip ${preset === item.id ? 'is-active' : ''}`}
              onClick={() => setPreset(item.id)}
              aria-pressed={preset === item.id}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="web-query-preview">Запрос: «{preview}»</p>
        {openLink && (
          <a className="web-open-link" href={openLink.url} target="_blank" rel="noreferrer">
            <Icon name="compass" size={16} />
            Открыть страницу поиска в {getEngine(openLink.engine).name}
          </a>
        )}
      </header>

      {history.length > 0 && (
        <section className="web-section">
          <div className="section__head">
            <h2 className="section__title">История интернет-поиска</h2>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setHistory([]);
                saveHistory([]);
              }}
            >
              Очистить
            </button>
          </div>
          <div className="web-history">
            {history.map((entry) => (
              <div className="web-history__row" key={entry.id}>
                <button type="button" className="web-history__main" onClick={() => openHistory(entry)}>
                  <span className="web-history__query">{entry.text}</span>
                  <span className="web-history__meta">
                    {getEngine(entry.engine).name} · {new Date(entry.at).toLocaleDateString('ru-RU')}
                  </span>
                </button>
                <button type="button" className="icon-button" onClick={() => void copyLink(entry)} aria-label="Скопировать ссылку">
                  <Icon name="bookmark" size={16} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="web-section">
        <div className="section__head">
          <div>
            <h2 className="section__title">Добавить книгу из интернета</h2>
            <p className="section__sub">EPUB, FB2, PDF, TXT, MOBI — файл останется в памяти приложения</p>
          </div>
        </div>

        <div className="web-import-actions">
          <button type="button" className="btn btn--primary" onClick={() => fileInput.current?.click()}>
            <Icon name="download" size={18} />
            Выбрать файл
          </button>
          {native && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                if (!pickFileNative()) app.pushToast('Системный выбор файла доступен в приложении', 'info');
              }}
            >
              <Icon name="library" size={18} />
              Из файлов телефона
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            className="visually-hidden"
            accept=".epub,.fb2,.pdf,.txt,.mobi,application/epub+zip,application/pdf,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
              event.target.value = '';
            }}
          />
        </div>

        <div
          className={`web-dropzone ${dragOver ? 'is-over' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            const file = event.dataTransfer.files?.[0];
            if (file) void handleFile(file);
          }}
        >
          <Icon name="download" size={22} />
          <span>Перетащите файл сюда — или скачайте его во встроенном браузере и вернитесь в приложение</span>
        </div>

        <div className="web-url-row">
          <input
            className="text-input"
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            placeholder="Прямая ссылка на файл (.epub, .fb2, .pdf, .txt)"
            aria-label="Ссылка на файл"
          />
          <button type="button" className="mini-button" onClick={() => void handleUrlDownload()} disabled={preparing || !urlInput.trim()}>
            {preparing ? 'Скачиваем…' : 'Импортировать'}
          </button>
        </div>

        {native && (
          <p className="web-native-hint">
            В приложении доступны: скачивание прямо в встроенном браузере, «Поделиться файлом» из другого
            приложения и выбор через системный файловый менеджер.
          </p>
        )}

        {error && <p className="web-error">{error}</p>}
        {preparing && <p className="web-preparing">Читаем файл и ищем метаданные…</p>}
      </section>

      {draft && draftBytes && (
        <section className="web-section web-draft">
          <div className="section__head">
            <h2 className="section__title">Проверьте книгу</h2>
            <span className="muted">{draft.format.toUpperCase()} · {(draft.fileSize / 1024).toFixed(0)} КБ</span>
          </div>

          {draft.duplicateOf && (
            <p className="web-warning">Похоже, эта книга уже есть в библиотеке — повторно добавлять не будем.</p>
          )}

          <div className="web-draft__row">
            <div className="web-draft__cover">
              {draft.coverDataUrl || draft.coverUrl ? (
                <img src={draft.coverDataUrl ?? draft.coverUrl} alt="" />
              ) : (
                <span>{draft.title.slice(0, 1).toUpperCase() || '?'}</span>
              )}
            </div>
            <div className="web-draft__fields">
              <label className="web-field">
                <span>Название</span>
                <input value={draft.title} onChange={(event) => updateDraft('title', event.target.value)} />
              </label>
              <label className="web-field">
                <span>Автор</span>
                <input
                  value={draft.authors.join(', ')}
                  onChange={(event) => updateDraft('authors', event.target.value)}
                  placeholder="Несколько — через запятую"
                />
              </label>
              <div className="web-field-pair">
                <label className="web-field">
                  <span>Серия</span>
                  <input value={draft.series ?? ''} onChange={(event) => updateDraft('series', event.target.value)} />
                </label>
                <label className="web-field">
                  <span>Жанр</span>
                  <input value={draft.genre ?? ''} onChange={(event) => updateDraft('genre', event.target.value)} />
                </label>
              </div>
              <div className="web-field-pair">
                <label className="web-field">
                  <span>Язык</span>
                  <input value={draft.languages.join(', ')} onChange={(event) => updateDraft('languages', event.target.value)} placeholder="ru" />
                </label>
                <label className="web-field">
                  <span>Год</span>
                  <input value={draft.year ? String(draft.year) : ''} onChange={(event) => updateDraft('year', event.target.value)} inputMode="numeric" />
                </label>
              </div>
            </div>
          </div>

          <label className="web-field">
            <span>Описание</span>
            <textarea
              rows={3}
              value={draft.description ?? ''}
              onChange={(event) => updateDraft('description', event.target.value)}
            />
          </label>

          {draft.filledFrom.length > 0 && (
            <p className="web-draft__sources">
              Распознано: {draft.filledFrom.join(' · ')}
              {draft.matchedSource ? ` · дополнено: ${draft.matchedSource}` : ''}
            </p>
          )}

          <div className="web-draft__actions">
            <button type="button" className="btn btn--primary btn--wide" onClick={() => void saveDraft()} disabled={saving || Boolean(draft.duplicateOf)}>
              <Icon name="check" size={18} />
              {saving ? 'Сохраняем…' : draft.duplicateOf ? 'Уже в библиотеке' : 'Добавить в библиотеку'}
            </button>
            {draft.duplicateOf && (
              <button
                type="button"
                className="btn btn--ghost btn--wide"
                onClick={() => {
                  app.pushToast('Открываем книгу из библиотеки', 'info');
                  openReader(draft.duplicateOf ?? '');
                }}
              >
                Открыть существующую
              </button>
            )}
            <button
              type="button"
              className="btn btn--ghost btn--wide"
              onClick={() => {
                setDraft(null);
                setDraftBytes(null);
              }}
            >
              Отменить
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() =>
                void shareContent({
                  title: draft.title,
                  text: `Книга «${draft.title}»${draft.authors[0] ? ` — ${draft.authors[0]}` : ''}`,
                })
              }
            >
              Поделиться
            </button>
          </div>
        </section>
      )}

      <p className="web-legal">
        Скачивайте только материалы, которые разрешено распространять. Приложение не обходит DRM, платный доступ и
        авторизацию, а также не парсит поисковую выдачу.
      </p>
    </div>
  );
}
