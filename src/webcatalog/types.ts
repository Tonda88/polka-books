/**
 * Интернет-поиск книг: контракты.
 *
 * Важно: приложение НЕ парсит выдачу Google/Яндекса (это запрещено их
 * условиями). Вместо этого оно формирует корректный поисковый запрос и
 * открывает реальную страницу поиска в встроенном браузере (WebView в APK),
 * где пользователь сам переходит по сайтам и скачивает разрешённые файлы.
 */

export type SearchEngineId = 'google' | 'yandex' | 'bing' | 'duckduckgo';

export interface SearchEngine {
  id: SearchEngineId;
  name: string;
  /** Официальная страница поиска. */
  homepage: string;
  /** Собирает URL поиска для запроса. */
  buildUrl(query: string): string;
  /** Подсказка в интерфейсе. */
  note: string;
  /** Цвет бренда для бейджа. */
  hue: number;
}

export interface SearchPreset {
  id: 'any' | 'epub' | 'fb2' | 'pdf' | 'txt' | 'mobi' | 'audiobook';
  label: string;
  /** Что добавляется к запросу. */
  suffix: string;
}

/** Готовый поисковый запрос для поисковика. */
export interface WebQuery {
  /** Название книги или имя автора. */
  title: string;
  author?: string;
  preset: SearchPreset['id'];
  engine: SearchEngineId;
  /** Итоговая строка запроса. */
  text: string;
  url: string;
  at: number;
}

export interface WebSearchHistoryEntry extends WebQuery {
  id: string;
}

/** Файл, выбранный для импорта (из браузера, файловой системы или share). */
export interface ImportSource {
  kind: 'file' | 'url' | 'browser' | 'share';
  name?: string;
  bytes: Uint8Array;
  mime?: string;
  /** Откуда пришёл файл (URL страницы, имя папки). */
  origin?: string;
}

/** Разобранные метаданные книги до сохранения в библиотеку. */
export interface BookDraft {
  /** Временный id черновика. */
  draftId: string;
  title: string;
  authors: string[];
  series?: string;
  genre?: string;
  languages: string[];
  year?: number;
  description?: string;
  publisher?: string;
  isbn?: string;
  coverUrl?: string;
  /** Обложка из самого файла (data URL). */
  coverDataUrl?: string;
  format: 'epub' | 'fb2' | 'pdf' | 'txt' | 'mobi' | 'unknown';
  fileSize: number;
  fileName: string;
  /** Имя файла в памяти приложения. */
  storageKey: string;
  /** Совпадение с источником (Open Library) для дополнения. */
  matchedSource?: string;
  confidence: number;
  /** Что удалось распознать из файла, а что — из источников. */
  filledFrom: string[];
  /** Возможный дубликат уже в библиотеке. */
  duplicateOf?: string;
}

/** Метаданные, извлечённые из файла + источников (до сохранения). */
export type ExtractedMeta = Omit<BookDraft, 'draftId' | 'storageKey' | 'fileName' | 'fileSize' | 'format'>;

export interface ImportResult {
  ok: boolean;
  draft?: BookDraft;
  error?: string;
}
