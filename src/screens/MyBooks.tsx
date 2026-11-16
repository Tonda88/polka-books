/**
 * «Мои книги» — единая полка пользователя:
 * скачанные сетевые книги, встроенная библиотека «Полки», прогресс,
 * избранное (localStorage `polka:favorites`) и история чтения.
 */
import { useEffect, useMemo, useReducer, useState } from 'react';
import type { CatalogBook } from '../catalog/types';
import type { BookMeta, ProgressEntry } from '../types';
import { BOOKS } from '../data/books';
import { recallBook } from '../catalog/cache';
import { useFavorites } from '../catalog/hooks';
import { downloads } from '../downloads/manager';
import { FORMAT_LABEL } from '../downloads/types';
import type { NetworkBook } from '../downloads/types';
import { readAudioPosition, type AudioPlayerPosition } from '../audio/AudioPlayer';
import { useApp } from '../lib/store';
import { navigate, openAudioBook, openBook, openCatalogBook, openPlayer, openReader } from '../lib/router';
import { humanBytes, plural, timeAgo } from '../lib/format';
import { BookCover } from '../components/Cover';
import { NetworkCover } from '../components/NetworkCover';
import { ProgressBar } from '../components/Progress';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icons';
import { ShelfGrid } from '../components/ShelfRow';
import { useLibraryCategories, usePreferenceState, useRecommendationShelves } from '../prefs/usePreferences';
import { profilesByIds } from '../prefs/repository';
import { openPreferences } from '../lib/router';
import type { BookProfile, ShelfBook } from '../prefs/types';

type Segment = 'all' | 'downloaded' | 'reading' | 'favorites' | 'history';
type FormatFilter = 'all' | 'epub' | 'pdf' | 'audio' | 'text' | 'builtin';
type SortMode = 'added' | 'title' | 'author' | 'size';

const SEGMENTS: Array<{ id: Segment; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'downloaded', label: 'Скачанные' },
  { id: 'reading', label: 'Читаю' },
  { id: 'favorites', label: 'Избранное' },
  { id: 'history', label: 'История' },
];

const FORMAT_FILTERS: Array<{ id: Exclude<FormatFilter, 'all'>; label: string }> = [
  { id: 'epub', label: 'EPUB' },
  { id: 'pdf', label: 'PDF' },
  { id: 'audio', label: 'Аудио' },
  { id: 'text', label: 'Текст' },
  { id: 'builtin', label: 'Встроенные' },
];

/** Ключ элемента «Моих книг» → id, под которым книга сохранена в профиле. */
function catalogIdOfKey(key: string): string {
  if (key.startsWith('builtin:')) return key.slice('builtin:'.length);
  if (key.startsWith('network:net:')) return key.slice('network:net:'.length);
  if (key.startsWith('network:')) return key.slice('network:'.length);
  return key;
}

interface MyBookItem {
  key: string;
  source: 'network' | 'builtin';
  title: string;
  authors: string[];
  formatLabel: string;
  formatGroup: Exclude<FormatFilter, 'all'>;
  bytes: number;
  addedAt: number;
  updatedAt: number;
  progress: number;
  finished: boolean;
  downloaded: boolean;
  favorite: boolean;
  reading: boolean;
  history: boolean;
  hasAudio: boolean;
  chapters?: number;
  coverUrl?: string;
  sourceUrl?: string;
  networkBook?: NetworkBook;
  catalogBook?: CatalogBook;
  builtin?: BookMeta;
}

let initPromise: Promise<void> | null = null;

function ensureDownloadsReady(): Promise<void> {
  if (!initPromise) {
    initPromise = downloads.init().catch((error: unknown) => {
      console.warn('Не удалось открыть хранилище загрузок', error);
    });
  }
  return initPromise;
}

function networkFormat(networkBook: NetworkBook): { label: string; group: Exclude<FormatFilter, 'all'> } {
  if (networkBook.kind === 'audio') return { label: 'Аудио', group: 'audio' };
  if (networkBook.kind === 'pdf') return { label: 'PDF', group: 'pdf' };
  const format = (networkBook.format || '').toLowerCase();
  const label = FORMAT_LABEL[format] ?? (format ? format.toUpperCase() : 'Файл');
  if (format === 'epub') return { label, group: 'epub' };
  if (format === 'pdf' || format === 'djvu') return { label, group: 'pdf' };
  if (format === 'audio' || format === 'mp3') return { label: 'Аудио', group: 'audio' };
  return { label, group: 'text' };
}

function savedAudioPercent(
  catalogBook: CatalogBook | undefined,
  networkBook: NetworkBook,
  saved: AudioPlayerPosition,
): number {
  const trackCount = catalogBook?.audio?.tracks.length ?? networkBook.audioTracks?.length ?? 0;
  if (trackCount === 0) return 0;
  const index = Math.min(Math.max(0, saved.trackIndex), trackCount - 1);
  const duration =
    catalogBook?.audio?.tracks[index]?.durationSec ?? networkBook.audioTracks?.[index]?.durationSec ?? 0;
  const fraction = duration > 0 ? Math.min(1, saved.currentTime / duration) : 0;
  return Math.min(100, ((index + fraction) / trackCount) * 100);
}

function networkCatalogId(networkBook: NetworkBook): string {
  return networkBook.catalogId ?? `${networkBook.sourceId}:${networkBook.externalId}`;
}

function favoriteKey(item: MyBookItem): string {
  return item.networkBook ? networkCatalogId(item.networkBook) : (item.builtin?.id ?? item.key);
}

function catalogIdOf(item: MyBookItem): string {
  if (item.networkBook) return networkCatalogId(item.networkBook);
  return item.catalogBook?.id ?? '';
}

function canReadItem(item: MyBookItem): boolean {
  return item.source === 'builtin' || item.formatGroup !== 'audio';
}

export function MyBooksScreen() {
  const { state, removeDownload, pushToast } = useApp();
  const [segment, setSegment] = useState<Segment>('all');
  const [format, setFormat] = useState<FormatFilter>('all');
  const [sort, setSort] = useState<SortMode>('added');
  const { isFavorite, toggle: toggleFavoriteId } = useFavorites();
  const [sheetItem, setSheetItem] = useState<MyBookItem | null>(null);
  const [version, bump] = useReducer((value: number) => value + 1, 0);
  const [catalogMap, setCatalogMap] = useState<Record<string, CatalogBook>>({});

  useEffect(() => {
    const sync = () => bump();
    const unsubscribe = downloads.subscribe(sync);
    sync();
    void ensureDownloadsReady().then(sync);
    return unsubscribe;
  }, []);

  const library = useMemo(() => downloads.getLibrary(), [version]);
  const libraryKey = library.map(networkCatalogId).join('|');

  useEffect(() => {
    const ids = libraryKey ? libraryKey.split('|') : [];
    let cancelled = false;
    if (ids.length === 0) {
      setCatalogMap({});
      return () => {
        cancelled = true;
      };
    }
    void Promise.all(ids.map(async (id) => [id, await recallBook(id)] as const)).then((entries) => {
      if (cancelled) return;
      const next: Record<string, CatalogBook> = {};
      for (const [id, book] of entries) {
        if (book) next[id] = book;
      }
      setCatalogMap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [libraryKey]);

  const items = useMemo<MyBookItem[]>(() => {
    const result: MyBookItem[] = [];

    for (const networkBook of library) {
      const catalogId = networkCatalogId(networkBook);
      const catalogBook = catalogMap[catalogId];
      const formatInfo = networkFormat(networkBook);
      const entry: ProgressEntry | undefined = state.progress[catalogId] ?? state.progress[networkBook.id];
      const saved = readAudioPosition(catalogId);
      const audioPositionActive = Boolean(saved && (saved.currentTime > 1 || saved.trackIndex > 0));
      const audioProgress = saved ? savedAudioPercent(catalogBook, networkBook, saved) : 0;
      const progress = Math.max(entry ? Math.min(100, Math.max(0, entry.percent)) : 0, audioProgress);
      const finished = Boolean(entry?.finishedAt);
      const hasAudio =
        formatInfo.group === 'audio' ||
        (catalogBook?.audio?.tracks.length ?? 0) > 0 ||
        (networkBook.audioTracks?.length ?? 0) > 0;
      result.push({
        key: `network:${networkBook.id}`,
        source: 'network',
        title: networkBook.title,
        authors: networkBook.authors,
        formatLabel: formatInfo.label,
        formatGroup: formatInfo.group,
        bytes: networkBook.bytes,
        addedAt: networkBook.savedAt,
        updatedAt: Math.max(entry?.updatedAt ?? 0, saved?.updatedAt ?? 0, networkBook.savedAt),
        progress,
        finished,
        downloaded: true,
        favorite: isFavorite(catalogId),
        reading: !finished && progress > 0.5,
        history: Boolean(entry) || audioPositionActive,
        hasAudio,
        chapters: networkBook.chapters,
        coverUrl: catalogBook?.coverUrl ?? networkBook.coverUrl,
        sourceUrl: networkBook.sourceUrl ?? catalogBook?.source.pageUrl,
        networkBook,
        catalogBook,
      });
    }

    for (const book of BOOKS) {
      const entry = state.progress[book.id];
      const downloadMeta = state.downloads[book.id];
      const progress = entry ? Math.min(100, Math.max(0, entry.percent)) : 0;
      const finished = Boolean(entry?.finishedAt);
      result.push({
        key: `builtin:${book.id}`,
        source: 'builtin',
        title: book.title,
        authors: [book.author],
        formatLabel: 'Встроенная',
        formatGroup: 'builtin',
        bytes: downloadMeta?.bytes ?? book.bytes,
        addedAt: entry?.startedAt ?? 0,
        updatedAt: Math.max(entry?.updatedAt ?? 0, state.ratings[book.id]?.at ?? 0),
        progress,
        finished,
        downloaded: Boolean(downloadMeta),
        favorite: isFavorite(book.id),
        reading: !finished && progress > 0,
        history: Boolean(entry),
        hasAudio: true,
        chapters: book.chapters.length,
        sourceUrl: book.source?.page,
        builtin: book,
      });
    }

    return result;
  }, [library, catalogMap, isFavorite, state.progress, state.downloads, state.ratings]);

  const stats = useMemo(() => {
    const networkBytes = library.reduce((sum, book) => sum + book.bytes, 0);
    const builtinBytes = Object.values(state.downloads).reduce((sum, meta) => sum + meta.bytes, 0);
    return {
      total: items.length,
      downloaded: items.filter((item) => item.downloaded).length,
      bytes: networkBytes + builtinBytes,
    };
  }, [items, library, state.downloads]);

  const counts = useMemo(
    () => ({
      all: items.length,
      downloaded: items.filter((item) => item.downloaded).length,
      reading: items.filter((item) => item.reading).length,
      favorites: items.filter((item) => item.favorite).length,
      history: items.filter((item) => item.history).length,
    }),
    [items],
  );

  const formatCounts = useMemo(() => {
    const result: Record<Exclude<FormatFilter, 'all'>, number> = {
      epub: 0,
      pdf: 0,
      audio: 0,
      text: 0,
      builtin: 0,
    };
    for (const item of items) result[item.formatGroup] += 1;
    return result;
  }, [items]);

  // --- персональные категории (система предпочтений) ---
  const prefCategories = useLibraryCategories();
  const { state: prefState } = usePreferenceState();
  const { bundle: recBundle, loading: recLoading } = useRecommendationShelves({ limit: 12 });
  const [prefCategory, setPrefCategory] = useState<string | null>(null);
  const [categoryProfiles, setCategoryProfiles] = useState<BookProfile[]>([]);

  const activeCategory = prefCategories.find((category) => category.id === prefCategory) ?? null;
  const categoryIds = activeCategory ? new Set(activeCategory.bookIds) : null;

  useEffect(() => {
    let alive = true;
    if (!activeCategory) {
      setCategoryProfiles([]);
      return;
    }
    void profilesByIds(activeCategory.bookIds).then((list) => {
      if (alive) setCategoryProfiles(list);
    });
    return () => {
      alive = false;
    };
  }, [prefCategory]);

  /** Книги категории, которых нет в локальной полке — показываем как карточки. */
  const categoryExtras = useMemo<ShelfBook[]>(() => {
    if (!activeCategory) return [];
    const known = new Set(items.map((item) => catalogIdOfKey(item.key)));
    return categoryProfiles
      .filter((profile) => !known.has(profile.id))
      .map((profile) => ({ book: profile, score: 0, reasons: [], source: 'similar' }));
  }, [activeCategory, categoryProfiles, items]);

  const visible = useMemo(() => {
    let list = items;
    if (segment === 'downloaded') list = list.filter((item) => item.downloaded);
    else if (segment === 'reading') list = list.filter((item) => item.reading);
    else if (segment === 'favorites') list = list.filter((item) => item.favorite);
    else if (segment === 'history') list = list.filter((item) => item.history);
    if (categoryIds) list = list.filter((item) => categoryIds.has(catalogIdOfKey(item.key)));
    if (format !== 'all') list = list.filter((item) => item.formatGroup === format);

    const sorted = [...list];
    switch (sort) {
      case 'title':
        sorted.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
        break;
      case 'author':
        sorted.sort((a, b) => (a.authors[0] ?? '').localeCompare(b.authors[0] ?? '', 'ru'));
        break;
      case 'size':
        sorted.sort((a, b) => b.bytes - a.bytes);
        break;
      default:
        sorted.sort((a, b) => b.addedAt - a.addedAt);
        break;
    }
    return sorted;
  }, [items, segment, format, sort]);

  const resetFilters = () => {
    setSegment('all');
    setFormat('all');
    setSort('added');
  };

  const toggleFavorite = (item: MyBookItem) => {
    const key = favoriteKey(item);
    const active = isFavorite(key);
    toggleFavoriteId(key);
    pushToast(active ? 'Убрано из избранного' : 'Добавлено в избранное');
  };

  const handleRead = (item: MyBookItem) => {
    if (item.source === 'network' && item.networkBook) {
      openReader(item.networkBook.id);
      return;
    }
    if (item.builtin) openReader(item.builtin.id);
  };

  const handleListen = (item: MyBookItem) => {
    if (item.source === 'network' && item.networkBook) {
      openAudioBook(networkCatalogId(item.networkBook));
      return;
    }
    if (item.builtin) openPlayer(item.builtin.id);
  };

  const handleAbout = (item: MyBookItem) => {
    setSheetItem(null);
    if (item.source === 'network') openCatalogBook(catalogIdOf(item));
    else if (item.builtin) openBook(item.builtin.id);
  };

  const handleRemoveFromDevice = async (item: MyBookItem) => {
    try {
      if (item.source === 'network' && item.networkBook) {
        await downloads.remove(item.networkBook.id);
      } else if (item.builtin) {
        await removeDownload(item.builtin.id);
      }
      setSheetItem(null);
    } catch {
      pushToast('Не удалось удалить книгу с устройства', 'error');
    }
  };

  const sheetSourceUrl = sheetItem?.sourceUrl;

  return (
    <div className="screen mybooks">
      <header className="page-head page-head--row">
        <div>
          <h1 className="page-title">Мои книги</h1>
          <p className="page-sub">
            {items.length > 0
              ? `${stats.total} ${plural(stats.total, 'книга', 'книги', 'книг')} на полке · ${stats.downloaded} ${plural(
                  stats.downloaded,
                  'скачана',
                  'скачаны',
                  'скачано',
                )}`
              : 'Скачанные и встроенные книги, прогресс и избранное — в одном месте'}
          </p>
        </div>
        <button
          type="button"
          className="icon-button icon-button--accent"
          onClick={() => navigate('/search')}
          aria-label="Найти книгу"
        >
          <Icon name="search" size={19} />
        </button>
      </header>

      <div className="mybooks-stats">
        <div className="stat-tile">
          <strong>{stats.total}</strong>
          <span>всего книг</span>
        </div>
        <div className="stat-tile">
          <strong>{stats.downloaded}</strong>
          <span>скачано</span>
        </div>
        <div className="stat-tile">
          <strong>{humanBytes(stats.bytes)}</strong>
          <span>на устройстве</span>
        </div>
      </div>

      <section className="pref-category-strip" aria-label="Категории личной библиотеки">
        <div className="section__head">
          <div>
            <h2 className="section__title">Категории</h2>
            <p className="section__sub">
              {prefState
                ? `На основе ${prefState.prefs.signalCount} сигналов: оценки, скачивания, чтение и поиск`
                : 'Любимое, прочитанное и рекомендации — по вашим оценкам'}
            </p>
          </div>
          <button type="button" className="link-button" onClick={openPreferences}>
            Настроить
          </button>
        </div>
        <div className="chips-row chips-row--wrap">
          <button
            type="button"
            className={`chip ${prefCategory === null ? 'is-active' : ''}`}
            onClick={() => setPrefCategory(null)}
          >
            Все книги
          </button>
          {prefCategories.map((category) => (
            <button
              key={category.id}
              type="button"
              className={`chip ${prefCategory === category.id ? 'is-active' : ''}`}
              onClick={() => setPrefCategory(prefCategory === category.id ? null : category.id)}
              aria-pressed={prefCategory === category.id}
            >
              {category.label}
              {category.count > 0 && <span className="chip__count">{category.count}</span>}
            </button>
          ))}
          <button
            type="button"
            className={`chip ${prefCategory === 'recommendations' ? 'is-active' : ''}`}
            onClick={() => setPrefCategory(prefCategory === 'recommendations' ? null : 'recommendations')}
            aria-pressed={prefCategory === 'recommendations'}
          >
            Рекомендации
          </button>
        </div>
        {prefCategory === 'recommendations' && (
          <div className="mybooks-category-block">
            {recLoading && !recBundle ? (
              <p className="section-empty">Подбираем книги…</p>
            ) : (
              <ShelfGrid books={recBundle?.shelves.find((shelf) => shelf.id === 'forYou')?.books ?? []} />
            )}
            <p className="pref-card__hint">
              Книги не добавляются автоматически: откройте карточку и скачайте, если понравилась.
            </p>
          </div>
        )}
        {activeCategory && activeCategory.count === 0 && (
          <p className="pref-card__hint">Пока пусто — оцените книги в карточке или дочитайте начатую.</p>
        )}
        {activeCategory && categoryExtras.length > 0 && (
          <div className="mybooks-category-block">
            <p className="pref-card__hint">Ещё книги из этой категории (не скачаны):</p>
            <ShelfGrid books={categoryExtras} />
          </div>
        )}
      </section>

      <div className="mybooks-filters">
        <div className="segmented library-tabs">
          {SEGMENTS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`segmented__item ${segment === item.id ? 'is-active' : ''}`}
              onClick={() => setSegment(item.id)}
            >
              {item.label}
              {counts[item.id] > 0 && <span className="segmented__count">{counts[item.id]}</span>}
            </button>
          ))}
        </div>

        <div className="mybooks-sort">
          <label className="mybooks-sort__label" htmlFor="mybooks-sort">
            <Icon name="list" size={14} />
            Сортировка
          </label>
          <select
            id="mybooks-sort"
            className="select mybooks-sort__select"
            value={sort}
            onChange={(event) => setSort(event.target.value as SortMode)}
          >
            <option value="added">Сначала новые</option>
            <option value="title">По названию</option>
            <option value="author">По автору</option>
            <option value="size">По размеру</option>
          </select>
          <span className="mybooks-sort__count">
            {visible.length} из {items.length}
          </span>
        </div>

        <div className="chips-row mybooks-formats">
          <button
            type="button"
            className={`chip ${format === 'all' ? 'is-active' : ''}`}
            onClick={() => setFormat('all')}
          >
            Все форматы
          </button>
          {FORMAT_FILTERS.filter((item) => formatCounts[item.id] > 0).map((item) => (
            <button
              key={item.id}
              type="button"
              className={`chip ${format === item.id ? 'is-active' : ''}`}
              onClick={() => setFormat(item.id)}
            >
              {item.label}
              <span className="chip__count">{formatCounts[item.id]}</span>
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={items.length === 0 ? 'На полке пока пусто' : 'Ничего не нашлось'}
          text={
            items.length === 0
              ? 'Скачайте книгу в каталоге — текст и аудио останутся на устройстве. Встроенные книги «Полки» уже здесь.'
              : 'Попробуйте другой сегмент, формат или сортировку.'
          }
          actionLabel={items.length === 0 ? 'Найти книгу' : 'Сбросить фильтры'}
          onAction={items.length === 0 ? () => navigate('/search') : resetFilters}
          icon={items.length === 0 ? 'book' : 'search'}
        />
      ) : (
        <div className="lib-list">
          {visible.map((item) => (
            <article className="lib-card" key={item.key}>
              <div className="lib-card__main">
                <div className="lib-card__cover">
                  {item.source === 'network' ? (
                    <NetworkCover
                      book={{ title: item.title, authors: item.authors, coverUrl: item.coverUrl }}
                      size="sm"
                    />
                  ) : item.builtin ? (
                    <BookCover
                      book={item.builtin}
                      size="sm"
                      progress={item.finished ? 100 : item.progress}
                    />
                  ) : null}
                  {item.downloaded && (
                    <span className="lib-card__offline" title="Скачано — доступно офлайн">
                      <Icon name="check" size={11} />
                    </span>
                  )}
                </div>
                <div className="lib-card__body">
                  <div className="lib-card__top">
                    <h3 className="lib-card__title">{item.title}</h3>
                    {item.favorite && (
                      <span className="lib-card__fav" aria-label="В избранном">
                        <Icon name="heart" size={13} filled />
                      </span>
                    )}
                  </div>
                  <p className="lib-card__author">
                    {item.authors.length > 0 ? item.authors.join(', ') : 'Автор неизвестен'}
                  </p>
                  <div className="lib-card__meta">
                    <span className={`lib-badge lib-badge--${item.formatGroup}`}>{item.formatLabel}</span>
                    {item.bytes > 0 && <span>{humanBytes(item.bytes)}</span>}
                    {item.chapters ? (
                      <>
                        <span className="lib-dot">·</span>
                        <span>
                          {item.chapters} {plural(item.chapters, 'глава', 'главы', 'глав')}
                        </span>
                      </>
                    ) : null}
                    {item.hasAudio && item.source === 'network' && (
                      <>
                        <span className="lib-dot">·</span>
                        <span>аудио</span>
                      </>
                    )}
                  </div>
                  {item.progress > 0 && (
                    <div className="lib-progress">
                      <ProgressBar value={item.progress} height={4} />
                      <span className="lib-progress__label">
                        {item.finished
                          ? 'Прочитано'
                          : `${item.formatGroup === 'audio' ? 'Прослушано' : 'Прочитано'} ${Math.round(
                              item.progress,
                            )}%`}
                      </span>
                    </div>
                  )}
                  {item.updatedAt > 0 && (
                    <p className="lib-card__updated">
                      {item.finished ? 'Завершено' : item.reading ? 'Читали' : 'Добавлено'} {timeAgo(item.updatedAt)}
                    </p>
                  )}
                </div>
              </div>
              <div className="lib-card__actions">
                {canReadItem(item) && (
                  <button type="button" className="mini-button mini-button--primary" onClick={() => handleRead(item)}>
                    <Icon name="book" size={14} />
                    Читать
                  </button>
                )}
                {item.hasAudio && (
                  <button type="button" className="mini-button" onClick={() => handleListen(item)}>
                    <Icon name="headphones" size={14} />
                    Слушать
                  </button>
                )}
                <button
                  type="button"
                  className="mini-button lib-card__more"
                  onClick={() => setSheetItem(item)}
                  aria-label={`Ещё: ${item.title}`}
                >
                  <Icon name="list" size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <Sheet
        open={Boolean(sheetItem)}
        onClose={() => setSheetItem(null)}
        title={sheetItem?.title ?? ''}
        subtitle={sheetItem ? `${sheetItem.authors.join(', ')} · ${sheetItem.formatLabel}` : undefined}
      >
        {sheetItem && (
          <div className="lib-sheet">
            {canReadItem(sheetItem) && (
              <button
                type="button"
                className="setting-button"
                onClick={() => {
                  handleRead(sheetItem);
                  setSheetItem(null);
                }}
              >
                <Icon name="book" size={18} />
                Читать текст
              </button>
            )}
            {sheetItem.hasAudio && (
              <button
                type="button"
                className="setting-button"
                onClick={() => {
                  handleListen(sheetItem);
                  setSheetItem(null);
                }}
              >
                <Icon name="headphones" size={18} />
                Слушать
              </button>
            )}
            <button type="button" className="setting-button" onClick={() => handleAbout(sheetItem)}>
              <Icon name="list" size={18} />
              О книге
              <Icon name="right" size={16} className="muted" />
            </button>
            {sheetSourceUrl && (
              <a className="setting-button" href={sheetSourceUrl} target="_blank" rel="noopener noreferrer">
                <Icon name="compass" size={18} />
                Открыть источник
                <Icon name="right" size={16} className="muted" />
              </a>
            )}
            <button type="button" className="setting-button" onClick={() => toggleFavorite(sheetItem)}>
              <Icon name="heart" size={18} filled={sheetItem.favorite} />
              {sheetItem.favorite ? 'Убрать из избранного' : 'В избранное'}
            </button>
            {sheetItem.downloaded ? (
              <button
                type="button"
                className="setting-button is-danger"
                onClick={() => void handleRemoveFromDevice(sheetItem)}
              >
                <Icon name="trash" size={18} />
                Удалить с устройства
              </button>
            ) : sheetItem.source === 'network' ? (
              <button
                type="button"
                className="setting-button"
                onClick={() => {
                  openCatalogBook(catalogIdOf(sheetItem));
                  setSheetItem(null);
                }}
              >
                <Icon name="download" size={18} />
                Скачать книгу
              </button>
            ) : null}
          </div>
        )}
      </Sheet>
    </div>
  );
}

function EmptyState({
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
