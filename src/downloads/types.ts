/**
 * Модель скачивания сетевых книг.
 *
 * Скачанные книги живут в двух местах:
 *  - текст/PDF/аудио — в IndexedDB (blob), чтобы читать без интернета;
 *  - метаданные и прогресс — в записи NetworkBook.
 */

export type DownloadStatus = 'queued' | 'downloading' | 'validating' | 'processing' | 'ready' | 'error' | 'cancelled';

export type ContentKind = 'text' | 'pdf' | 'audio';

export interface DownloadProgress {
  /** Загружено байт. */
  loaded: number;
  /** Всего байт (0, если сервер не сообщил). */
  total: number;
  /** 0..100 */
  percent: number;
  stage: DownloadStatus;
}

export interface NetworkBook {
  /** Локальный id: `net:<sourceId>:<externalId>`. */
  id: string;
  sourceId: string;
  sourceName: string;
  externalId: string;
  /** id книги в каталоге (`sourceId:externalId`) — для поиска скачанной копии. */
  catalogId?: string;
  title: string;
  authors: string[];
  year?: number;
  subjects: string[];
  description?: string;
  publisher?: string;
  coverUrl?: string;
  /** Официальная страница книги у источника. */
  sourceUrl?: string;
  license?: string;
  format: string;
  kind: ContentKind;
  bytes: number;
  /** Папка/имя файла внутри хранилища. */
  storageKey: string;
  savedAt: number;
  /** Сколько глав распознано при разборе. */
  chapters?: number;
  /** Для аудиокниг — список дорожек, доступных офлайн. */
  audioTracks?: Array<{ title: string; storageKey: string; bytes: number; durationSec?: number }>;
}

export interface DownloadTask {
  id: string;
  book: {
    id: string;
    sourceId: string;
    sourceName: string;
    externalId: string;
    title: string;
    authors: string[];
    year?: number;
    subjects: string[];
    description?: string;
    coverUrl?: string;
    sourceUrl?: string;
    license?: string;
  };
  url: string;
  format: string;
  status: DownloadStatus;
  progress: DownloadProgress;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  retries: number;
}

export interface DownloadLimits {
  /** Максимальный размер одного файла (по умолчанию 512 МБ). */
  maxBytes: number;
  /** Минимальный разумный размер (защита от пустых файлов). */
  minBytes: number;
}

export const DEFAULT_LIMITS: DownloadLimits = {
  maxBytes: 512 * 1024 * 1024,
  minBytes: 1024,
};

export const FORMAT_LABEL: Record<string, string> = {
  epub: 'EPUB',
  pdf: 'PDF',
  txt: 'TXT',
  fb2: 'FB2',
  mobi: 'MOBI',
  audio: 'MP3',
  html: 'HTML',
  djvu: 'DJVU',
  unknown: 'файл',
};

export const READABLE_FORMATS = new Set(['epub', 'fb2', 'txt']);
export const VIEWABLE_FORMATS = new Set(['pdf']);
export const AUDIO_FORMATS = new Set(['audio']);
