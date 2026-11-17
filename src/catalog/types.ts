/**
 * Контракт мульти-источникового каталога.
 *
 * Каждый источник (Google Books, Open Library, Internet Archive, Project
 * Gutenberg через IA, LibriVox через IA, встроенная библиотека «Полки»)
 * реализует интерфейс BookSource и регистрируется в registry.ts.
 * Новый источник = новый файл-адаптер + одна строка регистрации.
 */

export type BookFormat = 'epub' | 'pdf' | 'txt' | 'fb2' | 'mobi' | 'azw3' | 'audio' | 'html' | 'djvu' | 'unknown';

/** Доступность книги у источника. */
export type AccessMode = 'download' | 'borrow' | 'buy' | 'preview' | 'unknown';

export interface DownloadFile {
  url: string;
  format: BookFormat;
  sizeBytes?: number;
  /** Подпись для UI: «EPUB, 640 КБ», «MP3, глава 1» */
  label?: string;
  /** Файл требует авторизации/платной подписки — скачивать нельзя, только официальная ссылка. */
  requiresAuth?: boolean;
}

export interface AudioTrack {
  title: string;
  url: string;
  sizeBytes?: number;
  durationSec?: number;
}

export interface AudioInfo {
  tracks: AudioTrack[];
  narrators?: string[];
  language?: string;
  /** Страница, где аудиокнига официально доступна. */
  sourceUrl?: string;
}

export interface SourceRef {
  sourceId: string;
  sourceName: string;
  /** Официальная страница книги у источника. */
  pageUrl?: string;
  /** Условия распространения: public domain / CC / copyright. */
  license?: string;
}

export interface CatalogBook {
  /** Стабильный id: `${sourceId}:${externalId}`. */
  id: string;
  sourceId: string;
  externalId: string;
  title: string;
  subtitle?: string;
  authors: string[];
  year?: number;
  publishers?: string[];
  languages?: string[];
  description?: string;
  /** Жанры и теги — для фильтров и рекомендаций. */
  subjects: string[];
  isbn?: string[];
  series?: string;
  rating?: number;
  ratingsCount?: number;
  coverUrl?: string;
  /** Другие обложки, полученные из источников (после объединения дублей). */
  coverAlternatives?: string[];
  /** Форматы, реально доступные для скачивания. */
  files: DownloadFile[];
  access: AccessMode;
  /** Официальный способ получить книгу, если скачивание недоступно. */
  accessUrl?: string;
  accessNote?: string;
  audio?: AudioInfo;
  source: SourceRef;
  /** Когда запись получена/обновлена (мс). */
  fetchedAt: number;
}

export type SortMode = 'relevance' | 'newest' | 'popular' | 'rating';

export interface SearchQuery {
  text?: string;
  title?: string;
  author?: string;
  isbn?: string;
  subject?: string;
  /** Поиск по серии/циклу (например, «Ведьмак»). */
  series?: string;
  language?: string;
  sort?: SortMode;
  limit?: number;
}

export interface SourceError {
  sourceId: string;
  sourceName: string;
  message: string;
  retryable: boolean;
  /** HTTP-код, если был. */
  status?: number;
}

export interface SearchResult {
  books: CatalogBook[];
  errors: SourceError[];
  /** Сколько книг вернул каждый источник (до объединения). */
  perSource: Record<string, number>;
  tookMs: number;
}

export interface SourceContext {
  signal?: AbortSignal;
  /** Лимит на источник. */
  limit?: number;
  /** Необязательный ключ Google Books из настроек пользователя. */
  apiKey?: string;
  /** Разрешить сетевые запросы (для офлайна можно отключить). */
  online: boolean;
}

export interface SourceCapabilities {
  search: boolean;
  byIsbn: boolean;
  newest: boolean;
  popular: boolean;
  bySubject: boolean;
  download: boolean;
  audio: boolean;
  /** Источнику нужен ключ (Google Books). */
  requiresKey?: boolean;
}

export interface SourceHealth {
  ok: boolean;
  note?: string;
  checkedAt: number;
}

export interface BookSource {
  id: string;
  name: string;
  /** Официальный сайт источника. */
  homepage: string;
  licenseNote: string;
  capabilities: SourceCapabilities;

  search(query: SearchQuery, ctx: SourceContext): Promise<CatalogBook[]>;
  byIsbn?(isbn: string, ctx: SourceContext): Promise<CatalogBook[]>;
  details?(externalId: string, ctx: SourceContext): Promise<CatalogBook | null>;
  newest?(ctx: SourceContext): Promise<CatalogBook[]>;
  popular?(ctx: SourceContext): Promise<CatalogBook[]>;
  bySubject?(subject: string, ctx: SourceContext): Promise<CatalogBook[]>;
  health?(ctx: SourceContext): Promise<SourceHealth>;
}
