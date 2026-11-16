import { useEffect, useMemo, useState } from 'react';
import type { BookSource, SearchQuery, SourceError, SourceHealth } from '../catalog/types';
import {
  useCatalogSearch,
  useDebouncedValue,
  useDiscover,
  useSourceHealth,
  useSubjectBooks,
  type CachedSearchState,
} from '../catalog/hooks';
import { listSources } from '../catalog/registry';
import { CATEGORIES, filterByCategory, type CategoryId } from '../catalog/classify';
import { formatNumber, plural, shortText } from '../lib/format';
import { getSearchQuery } from '../lib/router';
import { useAppOptional } from '../lib/store';
import { CatalogCard } from '../components/CatalogCard';
import { Icon } from '../components/Icons';

const SEARCH_FIELDS = [
  { id: 'all', label: 'Все' },
  { id: 'title', label: 'Название' },
  { id: 'author', label: 'Автор' },
  { id: 'isbn', label: 'ISBN' },
  { id: 'subject', label: 'Жанр' },
] as const;

type SearchField = (typeof SEARCH_FIELDS)[number]['id'];

const FIELD_PLACEHOLDERS: Record<SearchField, string> = {
  all: 'Название, автор или ISBN',
  title: 'Название книги',
  author: 'Имя автора',
  isbn: 'ISBN книги',
  subject: 'Жанр или тема',
};

/** Категории для быстрых подборок: подпись и запрос к источникам. */
const QUICK_CATEGORIES = CATEGORIES.filter((category) =>
  ['fiction', 'fantasy', 'mystery', 'poetry', 'history', 'philosophy', 'science', 'children'].includes(category.id),
);

const QUICK_HINTS = ['Пушкин', 'Толстой', 'Чехов', 'Фантастика', 'Онегин'];

type SourceKind = 'ok' | 'error' | 'key' | 'checking' | 'unknown';

interface SourceStatus {
  kind: SourceKind;
  label: string;
  note?: string;
}

function describeSource(
  source: BookSource,
  health: Record<string, SourceHealth>,
  loading: boolean,
  googleKey: string | null,
): SourceStatus {
  if (source.capabilities.requiresKey && !googleKey) {
    return { kind: 'key', label: 'нужен ключ', note: 'Источник работает только с API-ключом из настроек' };
  }
  const entry = health[source.id];
  if (!entry) {
    return loading
      ? { kind: 'checking', label: 'проверяем…' }
      : { kind: 'unknown', label: 'не проверен' };
  }
  if (entry.ok) return { kind: 'ok', label: 'ок', note: entry.note };
  return { kind: 'error', label: 'ошибка', note: entry.note };
}

function errorLine(error: SourceError, sources: BookSource[], googleKey: string | null): string {
  const source = sources.find((item) => item.id === error.sourceId);
  if (source?.capabilities.requiresKey && !googleKey) return `${error.sourceName}: нужен API-ключ`;
  if (error.status === 401 || error.status === 403) return `${error.sourceName}: нужен доступ к API`;
  if (error.status === 429) return `${error.sourceName}: слишком много запросов, попробуйте позже`;
  return `${error.sourceName}: ${shortText(error.message.replace(/\.$/, ''), 80)}`;
}

export function SearchScreen() {
  const app = useAppOptional();
  const googleKey = app?.state.settings.googleBooksKey ?? null;

  const sources = useMemo(() => listSources(), []);
  const [field, setField] = useState<SearchField>('all');
  const [text, setText] = useState(() => getSearchQuery());
  const [subject, setSubject] = useState<string | null>(null);
  // Категория-фильтр для текущей выдачи (клиентская, без нового запроса).
  const [categoryFilter, setCategoryFilter] = useState<CategoryId | 'all'>('all');
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const debouncedText = useDebouncedValue(text, 320);
  const searchText = debouncedText.trim();
  const hasQuery = searchText.length > 0;

  const defaultEnabled = useMemo(
    () => new Set(sources.filter((source) => !source.capabilities.requiresKey || googleKey).map((source) => source.id)),
    [sources, googleKey],
  );

  const enabledIds = useMemo(
    () => sources.filter((source) => overrides[source.id] ?? defaultEnabled.has(source.id)).map((source) => source.id),
    [sources, overrides, defaultEnabled],
  );

  const activeCount = enabledIds.length;
  const activeSources = useMemo(
    () => sources.filter((source) => enabledIds.includes(source.id)),
    [sources, enabledIds],
  );

  const query = useMemo<SearchQuery>(() => {
    if (!searchText) return {};
    switch (field) {
      case 'title':
        return { title: searchText };
      case 'author':
        return { author: searchText };
      case 'isbn':
        return { isbn: searchText };
      case 'subject':
        return { subject: searchText };
      default:
        return { text: searchText };
    }
  }, [searchText, field]);

  const search = useCatalogSearch(query, {
    enabled: hasQuery && activeCount > 0,
    sourceIds: enabledIds,
    googleKey,
    limit: 40,
  });

  const newest = useDiscover('newest', { enabled: !hasQuery, googleKey, limit: 12 });
  const popular = useDiscover('popular', { enabled: !hasQuery, googleKey, limit: 12 });
  const genre = useSubjectBooks(hasQuery ? null : subject, {
    enabled: !hasQuery && subject !== null,
    googleKey,
    limit: 24,
  });

  const health = useSourceHealth();

  useEffect(() => {
    setSubject(null);
  }, [hasQuery]);

  const toggleSource = (id: string): void => {
    setOverrides((previous) => {
      const current = previous[id] ?? defaultEnabled.has(id);
      return { ...previous, [id]: !current };
    });
  };

  const resetSources = (): void => setOverrides({});

  const errors = search.result?.errors ?? [];
  const searchableSources = activeSources.filter((source) => source.capabilities.search).length;
  const visibleBooks = useMemo(
    () => (search.result ? search.result.books.filter((book) => filterByCategory(book, categoryFilter)) : []),
    [search.result, categoryFilter],
  );

  const allFailed = errors.length > 0 && errors.length >= searchableSources && (search.result?.books.length ?? 0) === 0;

  return (
    <div className="screen search-screen">
      <header className="search-hero">
        <div className="page-head">
          <h1 className="page-title">Поиск</h1>
          <p className="page-sub">
            Книги из открытых библиотек и каталогов. Скачивайте свободные файлы и читайте без интернета.
          </p>
        </div>

        <div className="search-field">
          <Icon name="search" size={19} className="search-field__icon" />
          <input
            type="search"
            className="search-field__input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={FIELD_PLACEHOLDERS[field]}
            aria-label="Поиск книг"
            enterKeyHint="search"
          />
          {text && (
            <button
              type="button"
              className="search-field__clear"
              onClick={() => setText('')}
              aria-label="Очистить строку поиска"
            >
              <Icon name="x" size={16} />
            </button>
          )}
        </div>
      </header>

      <div className="chips-row" role="group" aria-label="Поле поиска">
        {SEARCH_FIELDS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`chip ${field === item.id ? 'is-active' : ''}`}
            onClick={() => setField(item.id)}
            aria-pressed={field === item.id}
          >
            {item.label}
          </button>
        ))}
      </div>

      <section className="source-panel" aria-label="Источники книг">
        <div className="source-panel__head">
          <span className="source-panel__title">
            Источники <span className="source-panel__count">{activeCount} из {sources.length}</span>
          </span>
          <div className="source-panel__actions">
            {activeCount < sources.length && (
              <button type="button" className="link-button" onClick={resetSources}>
                Включить все
              </button>
            )}
            <button
              type="button"
              className="link-button"
              onClick={health.check}
              disabled={health.loading}
            >
              {health.loading ? 'Проверяем…' : 'Проверить'}
            </button>
          </div>
        </div>

        <div className="source-chips">
          {sources.map((source) => {
            const enabled = enabledIds.includes(source.id);
            const status = describeSource(source, health.health, health.loading, googleKey);
            return (
              <button
                key={source.id}
                type="button"
                className={`source-chip source-chip--${status.kind} ${enabled ? '' : 'is-off'}`.trim()}
                onClick={() => toggleSource(source.id)}
                aria-pressed={enabled}
                aria-label={`${source.name}: ${status.label}. ${enabled ? 'Включён в поиск' : 'Выключен из поиска'}`}
                title={status.note ?? source.licenseNote}
              >
                <span className="source-chip__dot" aria-hidden="true" />
                <span className="source-chip__name">{source.name}</span>
                <span className="source-chip__state">{status.label}</span>
              </button>
            );
          })}
        </div>

        {health.error && <p className="source-panel__error">{health.error}</p>}
        {activeCount === 0 && (
          <p className="source-panel__error">
            Ни один источник не включён — включите хотя бы один, чтобы искать книги.
          </p>
        )}
      </section>

      {hasQuery ? (
        <>
          {errors.length > 0 && (
            <ul className="source-errors" aria-label="Ошибки источников">
              {errors.slice(0, 4).map((error) => (
                <li key={`${error.sourceId}-${error.message}`}>{errorLine(error, sources, googleKey)}</li>
              ))}
              {errors.length > 4 && <li>и ещё {errors.length - 4}…</li>}
            </ul>
          )}

          {search.result && search.result.books.length > 0 && (
            <div className="chips-row chips-row--wrap category-filter" role="group" aria-label="Категории книг">
              <button
                type="button"
                className={`chip ${categoryFilter === 'all' ? 'is-active' : ''}`}
                onClick={() => setCategoryFilter('all')}
                aria-pressed={categoryFilter === 'all'}
              >
                Все
              </button>
              {CATEGORIES.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={`chip ${categoryFilter === category.id ? 'is-active' : ''}`}
                  onClick={() =>
                    setCategoryFilter(categoryFilter === category.id ? 'all' : category.id)
                  }
                  aria-pressed={categoryFilter === category.id}
                >
                  {category.label}
                </button>
              ))}
            </div>
          )}

          <div className="search-status" role="status" aria-live="polite">
            {search.loading ? (
              <>
                <span className="spinner spinner--sm" aria-hidden="true" />
                <span>
                  Ищем в {activeCount} {plural(activeCount, 'источнике', 'источниках', 'источниках')}…
                </span>
              </>
            ) : search.result ? (
              <>
                <span>
                  Найдено {formatNumber(search.result.books.length)}{' '}
                  {plural(search.result.books.length, 'книга', 'книги', 'книг')} за {search.result.tookMs} мс
                </span>
                {search.fromCache && <span className="search-status__cache">из кэша</span>}
                <button type="button" className="link-button" onClick={search.refresh}>
                  Обновить
                </button>
              </>
            ) : (
              <span>
                {search.error
                  ? 'Поиск не удался'
                  : activeCount === 0
                    ? 'Источники выключены'
                    : 'Готовим поиск…'}
              </span>
            )}
          </div>

          {categoryFilter !== 'all' && (
            <div className="chips-row chips-row--wrap" role="group" aria-label="Фильтр по категории">
              <button
                type="button"
                className="chip"
                onClick={() => setCategoryFilter('all')}
              >
                Все категории
              </button>
              <span className="chip is-active">{CATEGORIES.find((item) => item.id === categoryFilter)?.label}</span>
            </div>
          )}

          {search.offline && (
            <div className="search-offline">
              <Icon name="wifiOff" size={16} />
              <span>Нет сети: показаны сохранённые результаты</span>
            </div>
          )}

          {activeCount === 0 ? (
            <SearchEmpty
              icon="compass"
              title="Источники выключены"
              text="Включите хотя бы один источник в панели выше — и мы поищем книгу."
              actionLabel="Включить все"
              onAction={resetSources}
            />
          ) : search.loading && !search.result ? (
            <ResultSkeleton count={5} />
          ) : search.result && search.result.books.length > 0 && visibleBooks.length === 0 ? (
            <SearchEmpty
              icon="search"
              title="В этой категории ничего нет"
              text="Среди найденных книг нет книг выбранной категории. Покажите все результаты."
              actionLabel="Показать все"
              onAction={() => setCategoryFilter('all')}
            />
          ) : search.result && search.result.books.length > 0 ? (
            <div className="catalog-list">
              {visibleBooks.map((book) => (
                <CatalogCard key={book.id} book={book} />
              ))}
            </div>
          ) : allFailed ? (
            <SearchEmpty
              icon="wifiOff"
              title="Источники не ответили"
              text="Ни один источник не смог ответить на запрос. Проверьте интернет и попробуйте ещё раз."
              actionLabel="Повторить"
              onAction={search.refresh}
            />
          ) : search.offline ? (
            <SearchEmpty
              icon="wifiOff"
              title="Нет сети"
              text="Сохранённых результатов по этому запросу нет. Как только появится интернет — поищем снова."
              actionLabel="Повторить"
              onAction={search.refresh}
            />
          ) : search.error && !search.result ? (
            <SearchEmpty
              icon="wifiOff"
              title="Не удалось выполнить поиск"
              text={search.error}
              actionLabel="Повторить"
              onAction={search.refresh}
            />
          ) : (
            <SearchEmpty
              icon="search"
              title="Ничего не найдено"
              text="Попробуйте другое название, автора или жанр — или включите больше источников."
              actionLabel="Сбросить запрос"
              onAction={() => setText('')}
            />
          )}
        </>
      ) : (
        <>
          <DiscoverSection
            title="Новинки"
            subtitle="Свежие поступления из открытых библиотек"
            state={newest}
          />
          <DiscoverSection
            title="Популярное"
            subtitle="Что чаще всего берут читатели"
            state={popular}
          />

          <section className="section">
            <div className="section__head">
              <div>
                <h2 className="section__title">Жанры</h2>
                <p className="section__sub">Выберите тему — покажем книги из включённых источников</p>
              </div>
              {subject && (
                <button type="button" className="link-button" onClick={() => setSubject(null)}>
                  Сбросить
                </button>
              )}
            </div>
            <div className="chips-row chips-row--wrap">
              {QUICK_CATEGORIES.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={`chip ${subject === category.query ? 'is-active' : ''}`}
                  onClick={() => setSubject(subject === category.query ? null : category.query)}
                  aria-pressed={subject === category.query}
                >
                  {category.label}
                </button>
              ))}
            </div>

            {subject && (
              <div className="search-genre">
                <div className="search-genre__head">
                  <h3 className="section__title search-genre__title">
                    {CATEGORIES.find((item) => item.query === subject)?.label ?? subject}
                  </h3>
                  <span className="muted">
                    {genre.result
                      ? `${formatNumber(genre.result.books.length)} ${plural(
                          genre.result.books.length,
                          'книга',
                          'книги',
                          'книг',
                        )}`
                      : ''}
                  </span>
                </div>
                {genre.loading && !genre.result ? (
                  <div className="h-scroll h-scroll--edge">
                    <TileSkeleton />
                    <TileSkeleton />
                    <TileSkeleton />
                  </div>
                ) : genre.result && genre.result.books.length > 0 ? (
                  <div className="h-scroll h-scroll--edge">
                    {genre.result.books.map((book) => (
                      <CatalogCard key={book.id} book={book} variant="tile" />
                    ))}
                  </div>
                ) : (
                  <p className="section-empty">
                    {genre.error ?? 'По этой теме пока ничего нет — попробуйте другой жанр.'}
                  </p>
                )}
              </div>
            )}
          </section>

          <section className="section search-hints">
            <div className="section__head">
              <div>
                <h2 className="section__title">Попробуйте</h2>
                <p className="section__sub">Быстрые запросы для начала</p>
              </div>
            </div>
            <div className="chips-row chips-row--wrap">
              {QUICK_HINTS.map((hint) => (
                <button key={hint} type="button" className="chip chip--soft" onClick={() => setText(hint)}>
                  {hint}
                </button>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function DiscoverSection({
  title,
  subtitle,
  state,
}: {
  title: string;
  subtitle: string;
  state: CachedSearchState;
}) {
  return (
    <section className="section">
      <div className="section__head">
        <div>
          <h2 className="section__title">{title}</h2>
          <p className="section__sub">{subtitle}</p>
        </div>
        {state.result && state.result.books.length > 0 && (
          <button type="button" className="link-button" onClick={state.refresh}>
            Обновить
          </button>
        )}
      </div>

      {state.loading && !state.result ? (
        <div className="h-scroll h-scroll--edge">
          <TileSkeleton />
          <TileSkeleton />
          <TileSkeleton />
        </div>
      ) : state.result && state.result.books.length > 0 ? (
        <div className="h-scroll h-scroll--edge">
          {state.result.books.map((book) => (
            <CatalogCard key={book.id} book={book} variant="tile" />
          ))}
        </div>
      ) : (
        <p className="section-empty">{state.error ?? 'Пока пусто — источники не вернули книг.'}</p>
      )}
    </section>
  );
}

function SearchEmpty({
  icon,
  title,
  text,
  actionLabel,
  onAction,
}: {
  icon: string;
  title: string;
  text: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="empty">
      <div className="empty__icon">
        <Icon name={icon} size={26} />
      </div>
      <h2 className="empty__title">{title}</h2>
      <p className="empty__text">{text}</p>
      <button type="button" className="btn btn--ghost" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}

function ResultSkeleton({ count }: { count: number }) {
  return (
    <div className="catalog-list" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="catalog-skeleton" key={index}>
          <span className="skeleton catalog-skeleton__cover" />
          <span className="catalog-skeleton__lines">
            <span className="skeleton skeleton--line catalog-skeleton__title" />
            <span className="skeleton skeleton--line catalog-skeleton__author" />
            <span className="skeleton skeleton--line catalog-skeleton__meta" />
          </span>
        </div>
      ))}
    </div>
  );
}

function TileSkeleton() {
  return (
    <div className="tile-skeleton" aria-hidden="true">
      <span className="skeleton tile-skeleton__cover" />
      <span className="skeleton skeleton--line tile-skeleton__title" />
      <span className="skeleton skeleton--line tile-skeleton__author" />
    </div>
  );
}
