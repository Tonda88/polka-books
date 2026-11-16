/**
 * Публичный контракт менеджера загрузок.
 * Реализация — src/downloads/manager.ts. UI работает только через этот API.
 */
import type { AudioTrack, CatalogBook, DownloadFile } from '../catalog/types';
import type { DownloadTask, NetworkBook } from './types';

export interface DownloadManager {
  /** Подписка на изменения очереди и библиотеки. */
  subscribe(listener: () => void): () => void;
  /** Текущее состояние очереди (синхронный снимок). */
  getTasks(): DownloadTask[];
  /** Скачанные книги (снимок, обновляется после init/загрузок). */
  getLibrary(): NetworkBook[];
  /** Инициализация: читает IndexedDB. Вызывается один раз при старте. */
  init(): Promise<void>;
  /** Ставит книгу в очередь. Возвращает задачу. */
  enqueue(book: CatalogBook, file: DownloadFile): DownloadTask;
  /** Ставит в очередь первый доступный файл без авторизации. */
  enqueueBest(book: CatalogBook): DownloadTask | null;
  /** Ставит в очередь все треки аудиокниги (LibriVox / Internet Archive). */
  enqueueAudio(book: CatalogBook, tracks: AudioTrack[]): DownloadTask[];
  cancel(taskId: string): void;
  retry(taskId: string): Promise<void>;
  /** Удаляет скачанную книгу и её файлы. */
  remove(localId: string): Promise<void>;
  /** Проверяет, скачана ли книга (по исходному id каталога). */
  findByCatalogId(catalogId: string): NetworkBook | undefined;
  /** Полный текст скачанной книги в формате читалки. */
  getContent(localId: string): Promise<import('../types').BookContent | null>;
  /** Blob файла (PDF/аудио). */
  getBlob(localId: string, trackKey?: string): Promise<Blob | null>;
  clearFinished(): void;
}

export type { DownloadTask, NetworkBook };
