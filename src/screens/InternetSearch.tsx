import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store';
import { navigate, openMyBooks, openReader } from '../lib/router';
import { Icon } from '../components/Icons';
import { formatNumber } from '../lib/format';
import { apiBase, getSearchServer, setSearchServer } from '../discovery/config';
import { fetchProviders } from '../discovery/api';
import { internetSearch } from '../discovery/engine';
import { downloadBookFile } from '../discovery/download';
import type { BookCandidate, BookFile, InternetSearchResult, ProviderStatus } from '../discovery/types';

const ACCESS_LABELS: Record<string, string> = {
  ok: 'Доступен',
  requiresAuth: 'Требуется авторизация',
  purchase: 'Только покупка',
  missing: 'Файл отсутствует',
  blocked: 'Источник запрещает автоскачивание',
  unavailable: 'Недоступен',
  invalid: 'Неверная ссылка',
};

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
  const [imported, setImported] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);

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

  const run = async () => {
    const clean = query.trim();
    if (!clean) return;
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
        onProgress: (label, value) => {
          setStage(label);
          setPercent(value);
        },
      });
      setResult(answer);
      setProvidersOnline(true);
      setProviders(answer.providers);
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
    void (async () => {
      const status = await fetchProviders();
      setProvidersOnline(status.online);
      setProviders(status.providers);
    })();
  }, []);

  const availableProviders = providers.filter((provider) => provider.available);
  const keyProviders = providers.filter((provider) => provider.requiresKey && !provider.available);
  const webApiAvailable = availableProviders.some((provider) =>
    ['google', 'bing', 'brave', 'yandex', 'marginalia', 'searx'].includes(provider.id),
  );

  const serverHint = useMemo(() => {
    if (providersOnline === false) return 'Сервер не найден';
    if (providersOnline === null) return 'Проверяем сервер…';
    return `Сервер доступен · ${availableProviders.length} из ${providers.length} провайдеров`;
  }, [providersOnline, availableProviders.length, providers.length]);

  return (
    <div className="screen internet-search-screen">
      <header className="search-hero">
        <div className="page-head">
          <h1 className="page-title">Поиск книг в интернете</h1>
          <p className="page-sub">
            Ищем по всему вебу через поисковые API, анализируем страницы и находим файлы EPUB, FB2, PDF, TXT, MOBI.
          </p>
        </div>

        <div className="search-field">
          <Icon name="search" size={19} className="search-field__icon" />
          <input
            type="search"
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
        <div className="discovery-actions">
          <button type="button" className="btn btn--primary" onClick={() => void run()} disabled={loading || !query.trim()}>
            <Icon name="search" size={18} />
            {loading ? 'Ищем…' : 'Найти книгу'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => navigate('/catalogs')}>
            <Icon name="library" size={18} />
            Каталоги
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => navigate('/web')}>
            <Icon name="compass" size={18} />
            Браузер
          </button>
        </div>

        <div className="discovery-providers">
          <span className={`status-dot ${providersOnline ? 'is-online' : 'is-offline'}`} />
          <span className="discovery-providers__label">{serverHint}</span>
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
        </div>

        {providersOnline === false && (
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

          {result.books.length === 0 && (
            <p className="section-empty">Ничего не нашли. Попробуйте другое название или уточните автора.</p>
          )}

          <div className="discovery-list">
            {result.books.map((book) => {
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

      {!result && !loading && providersOnline && (
        <p className="discovery-legal">
          Приложение не парсит поисковую выдачу и не обходит DRM, CAPTCHA, авторизацию или платный доступ. Если файл
          доступен только за покупку — будет показана причина, а не фиктивная кнопка.
        </p>
      )}
    </div>
  );
}
