/**
 * Менеджер загрузок «Полки».
 *
 * Скачивает книгу по URL потоком (с прогрессом и AbortController), проверяет
 * формат по магическим байтам, разбирает текст в формат читалки и складывает
 * всё в IndexedDB:
 *  - текст книги → store «books» (id = локальный id, совместим с /read/<id>);
 *  - PDF/аудио/исходники → store «files» (blob);
 *  - метаданные → store «netbooks» (NetworkBook).
 *
 * Очередь последовательно-параллельная: не больше двух файлов одновременно.
 * Ошибка одной загрузки не роняет остальные. Каждая аудиодорожка — отдельная
 * задача; они добавляются к общей записи аудиокниги по мере готовности.
 */
import { resolveDownloadUrl } from '../catalog/proxy';
import { probeFile } from '../catalog/availability';
import type { AudioTrack, BookFormat, CatalogBook, DownloadFile } from '../catalog/types';
import {
  idbDeleteBook,
  idbDeleteFile,
  idbDeleteNetBook,
  idbGetBook,
  idbGetFile,
  idbGetNetBook,
  idbListNetBooks,
  idbPutBook,
  idbPutFile,
  idbPutNetBook,
  type StoredNetBookRecord,
} from '../lib/db';
import type { BookContent } from '../types';
import type { DownloadManager } from './api';
import { assertSafeDownload, formatBytes } from './detect';
import { parseDownloadedFile } from './parsers';
import {
  DEFAULT_LIMITS,
  type ContentKind,
  type DownloadStatus,
  type DownloadTask,
  type NetworkBook,
} from './types';

const MAX_PARALLEL = 2;
const FILE_TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [1000, 3000];
const LOCAL_PREFIX = 'net:';
const KNOWN_FORMATS: BookFormat[] = ['epub', 'fb2', 'txt', 'pdf', 'audio'];

interface AudioTrackInfo {
  index: number;
  title: string;
  durationSec?: number;
}

// --------------------------------------------------------------------------- //
// Утилиты
// --------------------------------------------------------------------------- //

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localIdFor(book: { sourceId: string; externalId: string }): string {
  return `${LOCAL_PREFIX}${book.sourceId}:${book.externalId}`;
}

function catalogIdFor(book: { sourceId: string; externalId: string }): string {
  return `${book.sourceId}:${book.externalId}`;
}

function fileKey(localId: string, format: string): string {
  return `${localId}.${format}`;
}

function trackOrder(storageKey: string): number {
  const match = /\.track-(\d+)$/.exec(storageKey);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toBlob(bytes: Uint8Array, type: string): Blob {
  return new Blob([toArrayBuffer(bytes)], { type: type || 'application/octet-stream' });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Не удалось скачать книгу. Попробуйте позже.';
}

function isFinished(status: DownloadStatus): boolean {
  return status === 'ready' || status === 'error' || status === 'cancelled';
}

function isRunning(status: DownloadStatus): boolean {
  return status === 'queued' || status === 'downloading' || status === 'validating' || status === 'processing';
}

/** Сетевая/серверная ошибка, после которой имеет смысл повторить попытку. */
class RetryableError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'RetryableError';
    this.status = status;
  }
}

function isStoredNetworkBook(record: StoredNetBookRecord): boolean {
  return (
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.storageKey === 'string' &&
    typeof record.savedAt === 'number'
  );
}

// --------------------------------------------------------------------------- //
// Реализация
// --------------------------------------------------------------------------- //

export class DownloadsManager implements DownloadManager {
  private tasks: DownloadTask[] = [];
  private tasksSnapshot: DownloadTask[] = [];
  private library: NetworkBook[] = [];
  private librarySnapshot: NetworkBook[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly audioTrackInfo = new Map<string, AudioTrackInfo>();
  private readonly bookLocks = new Map<string, Promise<void>>();
  private readonly removing = new Set<string>();
  private activeCount = 0;
  private initPromise: Promise<void> | null = null;
  private lastProgressEmit = 0;

  // ------------------------------------------------------------------------- //
  // Подписка и снимки
  // ------------------------------------------------------------------------- //

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getTasks(): DownloadTask[] {
    return this.tasksSnapshot;
  }

  getTask(taskId: string): DownloadTask | undefined {
    return this.tasks.find((task) => task.id === taskId);
  }

  getLibrary(): NetworkBook[] {
    return this.librarySnapshot;
  }

  private emit(): void {
    this.tasksSnapshot = [...this.tasks];
    this.librarySnapshot = [...this.library];
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Слушатель не должен ломать очередь загрузок.
      }
    }
  }

  private emitProgress(): void {
    const now = Date.now();
    if (now - this.lastProgressEmit < 80) return;
    this.lastProgressEmit = now;
    this.emit();
  }

  // ------------------------------------------------------------------------- //
  // Инициализация
  // ------------------------------------------------------------------------- //

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.loadLibrary();
    }
    return this.initPromise;
  }

  /**
   * Перечитывает библиотеку из IndexedDB. Нужен после внешнего импорта
   * (файл добавлен в обход очереди загрузок), чтобы «Мои книги» и читалка
   * сразу увидели новую запись.
   */
  async refreshLibrary(): Promise<void> {
    this.initPromise = null;
    await this.init();
    this.emit();
  }

  private async loadLibrary(): Promise<void> {
    try {
      const rows = await idbListNetBooks<StoredNetBookRecord>();
      const restored: NetworkBook[] = [];
      for (const row of rows) {
        if (!isStoredNetworkBook(row)) continue;
        restored.push(row as unknown as NetworkBook);
      }
      // Не теряем книги, которые успели скачаться, пока читали IndexedDB.
      const restoredIds = new Set(restored.map((book) => book.id));
      const current = this.library.filter((book) => !restoredIds.has(book.id));
      this.library = [...current, ...restored].sort((left, right) => right.savedAt - left.savedAt);
    } catch {
      // IndexedDB может быть недоступен (приватный режим) — работаем без снимка.
      this.library = [...this.library];
    } finally {
      this.emit();
    }
  }

  // ------------------------------------------------------------------------- //
  // Постановка в очередь
  // ------------------------------------------------------------------------- //

  enqueue(book: CatalogBook, file: DownloadFile): DownloadTask {
    void this.init();
    if (!file.url) throw new Error('У этого файла нет ссылки для скачивания.');

    const existing = this.tasks.find(
      (task) => task.url === file.url && localIdFor(task.book) === localIdFor(book) && isRunning(task.status),
    );
    if (existing) return existing;

    const task = this.createTask(book, file);
    this.tasks.push(task);
    this.emit();
    this.pump();
    return task;
  }

  enqueueBest(book: CatalogBook): DownloadTask | null {
    void this.init();
    const file = book.files?.find((candidate) => !candidate.requiresAuth && candidate.url);
    if (!file) return null;
    return this.enqueue(book, file);
  }

  /** Каждая аудиодорожка ставится отдельной задачей; дорожки вливаются в одну книгу. */
  enqueueAudio(book: CatalogBook, tracks: AudioTrack[]): DownloadTask[] {
    void this.init();
    const list = (tracks && tracks.length > 0 ? tracks : book.audio?.tracks ?? []).filter(
      (track) => Boolean(track.url),
    );
    const result: DownloadTask[] = [];
    for (let index = 0; index < list.length; index += 1) {
      const track = list[index];
      const existing = this.tasks.find(
        (task) => task.url === track.url && localIdFor(task.book) === localIdFor(book) && isRunning(task.status),
      );
      if (existing) {
        result.push(existing);
        continue;
      }
      const task = this.createTask(book, {
        url: track.url,
        format: 'audio',
        sizeBytes: track.sizeBytes,
        label: track.title,
      });
      this.audioTrackInfo.set(task.id, {
        index,
        title: track.title || `Дорожка ${index + 1}`,
        durationSec: track.durationSec,
      });
      this.tasks.push(task);
      this.emit();
      this.pump();
      result.push(task);
    }
    return result;
  }

  private createTask(book: CatalogBook, file: DownloadFile): DownloadTask {
    return {
      id: crypto.randomUUID(),
      book: {
        id: book.id,
        sourceId: book.sourceId,
        sourceName: book.source.sourceName,
        externalId: book.externalId,
        title: book.title,
        authors: [...book.authors],
        year: book.year,
        subjects: [...book.subjects],
        description: book.description,
        coverUrl: book.coverUrl,
        sourceUrl: book.accessUrl ?? book.source.pageUrl,
        license: book.source.license,
      },
      url: file.url,
      format: file.format,
      status: 'queued',
      progress: { loaded: 0, total: file.sizeBytes ?? 0, percent: 0, stage: 'queued' },
      startedAt: Date.now(),
      retries: 0,
    };
  }

  // ------------------------------------------------------------------------- //
  // Управление задачами
  // ------------------------------------------------------------------------- //

  cancel(taskId: string): void {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task || !isRunning(task.status)) return;
    task.status = 'cancelled';
    task.error = 'Загрузка отменена.';
    task.finishedAt = Date.now();
    task.progress = { ...task.progress, stage: 'cancelled' };
    const controller = this.controllers.get(taskId);
    if (controller) controller.abort();
    this.emit();
    this.pump();
  }

  async retry(taskId: string): Promise<void> {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    if (task.status !== 'error' && task.status !== 'cancelled') return;
    task.status = 'queued';
    task.error = undefined;
    task.retries = 0;
    task.startedAt = Date.now();
    task.finishedAt = undefined;
    task.progress = { loaded: 0, total: 0, percent: 0, stage: 'queued' };
    this.emit();
    this.pump();
    const runningTask = this.running.get(taskId);
    if (runningTask) await runningTask;
  }

  clearFinished(): void {
    const finished = this.tasks.filter((task) => isFinished(task.status));
    if (finished.length === 0) return;
    for (const task of finished) this.audioTrackInfo.delete(task.id);
    this.tasks = this.tasks.filter((task) => !isFinished(task.status));
    this.emit();
  }

  // ------------------------------------------------------------------------- //
  // Очередь
  // ------------------------------------------------------------------------- //

  private pump(): void {
    while (this.activeCount < MAX_PARALLEL) {
      const task = this.tasks.find((candidate) => candidate.status === 'queued');
      if (!task) break;
      this.start(task);
    }
  }

  private start(task: DownloadTask): void {
    this.activeCount += 1;
    const promise = this.process(task)
      .catch((error: unknown) => {
        // process() сам не пробрасывает ошибки, но подстрахуемся.
        if (!isFinished(task.status)) {
          task.status = 'error';
          task.error = errorMessage(error);
          task.finishedAt = Date.now();
          task.progress = { ...task.progress, stage: 'error' };
          this.emit();
        }
      })
      .finally(() => {
        this.activeCount -= 1;
        this.running.delete(task.id);
        this.pump();
      });
    this.running.set(task.id, promise);
  }

  private async process(task: DownloadTask): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    try {
      task.status = 'downloading';
      task.startedAt = Date.now();
      task.error = undefined;
      task.finishedAt = undefined;
      task.progress = { loaded: 0, total: task.progress.total, percent: 0, stage: 'downloading' };
      this.emit();

      const trackInfo = this.audioTrackInfo.get(task.id);
      const totalBytes = trackInfo
        ? await this.processAudioTrack(task, trackInfo, controller.signal)
        : await this.processSingle(task, controller.signal);

      if (isFinished(task.status)) return;
      task.status = 'ready';
      task.finishedAt = Date.now();
      task.progress = { loaded: totalBytes, total: totalBytes, percent: 100, stage: 'ready' };
      this.emit();
    } catch (error) {
      task.finishedAt = Date.now();
      if (task.status === 'cancelled') {
        task.error = 'Загрузка отменена.';
        task.progress = { ...task.progress, stage: 'cancelled' };
      } else {
        task.status = 'error';
        task.error = errorMessage(error);
        task.progress = { ...task.progress, stage: 'error' };
      }
      this.emit();
    } finally {
      this.controllers.delete(task.id);
    }
  }

  private setStage(task: DownloadTask, stage: DownloadStatus): void {
    task.status = stage;
    task.progress = { ...task.progress, stage };
    this.emit();
  }

  // ------------------------------------------------------------------------- //
  // Один файл
  // ------------------------------------------------------------------------- //

  private async processSingle(task: DownloadTask, signal: AbortSignal): Promise<number> {
    const localId = localIdFor(task.book);
    // Сначала лёгкая проверка: файл существует и отдаётся? Экономит время
    // и даёт честную ошибку вместо «скачали 404-страницу».
    const probe = await probeFile({ url: task.url, format: task.format as BookFormat }).catch(() => null);
    if (probe && probe.status === 404) {
      throw new Error('Файл не найден у источника (404). Попробуйте другой формат.');
    }
    // EPUB/PDF из Internet Archive не отдаются с CORS — качаем через наш прокси.
    const effectiveUrl = await resolveDownloadUrl(task.url, task.format);
    const downloaded = await this.withFileTimeout(
      (fileSignal) =>
        this.downloadWithRetry(task, effectiveUrl, fileSignal, (loaded, total) => {
          this.updateProgress(task, loaded, total, 'downloading');
        }),
      signal,
    );

    this.setStage(task, 'validating');
    const safe = assertSafeDownload({
      bytes: downloaded.bytes,
      mime: downloaded.mime,
      url: task.url,
      expectedFormat: task.format as BookFormat,
    });
    this.setStage(task, 'processing');

    const savedAt = Date.now();
    const mime = safe.mime || downloaded.mime || 'application/octet-stream';

    if (safe.kind === 'audio') {
      return this.saveAudioTrack(
        task,
        { title: task.book.title, storageKey: fileKey(localId, 'audio'), bytes: safe.size },
        downloaded.bytes,
        mime,
      );
    }

    const storageKey = fileKey(localId, safe.format);

    if (safe.kind === 'pdf') {
      // PDF не превращаем в BookContent: читалка откроет встроенный просмотрщик.
      await parseDownloadedFile({ bytes: toArrayBuffer(downloaded.bytes), format: 'pdf', url: downloaded.finalUrl });
      await this.withBookLock(localId, async () => {
        // PDF заменяет текстовую версию книги, если она была скачана раньше.
        await idbDeleteBook(localId);
        await idbPutFile({ key: storageKey, blob: toBlob(downloaded.bytes, mime), bytes: safe.size, mime, savedAt });
        await this.commit(task, { format: safe.format, kind: 'pdf', storageKey, bytes: safe.size }, new Set([storageKey]));
      });
      return safe.size;
    }

    const parsed = await parseDownloadedFile({
      bytes: toArrayBuffer(downloaded.bytes),
      format: safe.format,
      url: downloaded.finalUrl,
    });
    const content = parsed.content;
    if (!content || content.chapters.length === 0) {
      throw new Error('Не удалось разобрать текст книги: в файле не нашлось глав.');
    }

    await this.withBookLock(localId, async () => {
      await idbPutBook({ id: localId, chapters: content.chapters, bytes: safe.size, savedAt });
      await idbPutFile({ key: storageKey, blob: toBlob(downloaded.bytes, mime), bytes: safe.size, mime, savedAt });
      await this.commit(
        task,
        {
          format: safe.format,
          kind: 'text',
          storageKey,
          bytes: safe.size,
          chapters: content.chapters.length,
        },
        new Set([storageKey]),
      );
    });
    return safe.size;
  }

  // ------------------------------------------------------------------------- //
  // Аудио
  // ------------------------------------------------------------------------- //

  private async processAudioTrack(task: DownloadTask, info: AudioTrackInfo, signal: AbortSignal): Promise<number> {
    const localId = localIdFor(task.book);
    const effectiveUrl = await resolveDownloadUrl(task.url, 'audio');
    const downloaded = await this.withFileTimeout(
      (fileSignal) =>
        this.downloadWithRetry(task, effectiveUrl, fileSignal, (loaded, total) => {
          this.updateProgress(task, loaded, total, 'downloading');
        }),
      signal,
    );

    this.setStage(task, 'validating');
    const safe = assertSafeDownload({
      bytes: downloaded.bytes,
      mime: downloaded.mime,
      url: task.url,
      expectedFormat: 'audio',
    });
    this.setStage(task, 'processing');

    const mime = safe.mime || downloaded.mime || 'audio/mpeg';
    return this.saveAudioTrack(
      task,
      {
        title: info.title,
        storageKey: `${localId}.track-${info.index + 1}`,
        bytes: safe.size,
        durationSec: info.durationSec,
      },
      downloaded.bytes,
      mime,
    );
  }

  /** Кладёт дорожку в IndexedDB и вливает её в общую запись аудиокниги. */
  private async saveAudioTrack(
    task: DownloadTask,
    track: { title: string; storageKey: string; bytes: number; durationSec?: number },
    bytes: Uint8Array,
    mime: string,
  ): Promise<number> {
    const localId = localIdFor(task.book);
    return this.withBookLock(localId, async () => {
      // Аудиокнига не имеет текстовой версии — убираем старую, если была.
      await idbDeleteBook(localId);
      await idbPutFile({
        key: track.storageKey,
        blob: toBlob(bytes, mime),
        bytes: track.bytes,
        mime,
        savedAt: Date.now(),
      });

      const existing = await this.readExistingNetBook(localId);
      const tracks: NonNullable<NetworkBook['audioTracks']> = [...(existing?.audioTracks ?? [])];
      const entry = {
        title: track.title,
        storageKey: track.storageKey,
        bytes: track.bytes,
        durationSec: track.durationSec,
      };
      const index = tracks.findIndex((item) => item.storageKey === track.storageKey);
      if (index >= 0) tracks[index] = entry;
      else tracks.push(entry);
      tracks.sort((left, right) => trackOrder(left.storageKey) - trackOrder(right.storageKey));

      const totalBytes = tracks.reduce((sum, item) => sum + item.bytes, 0);
      await this.commit(
        task,
        {
          format: 'audio',
          kind: 'audio',
          storageKey: tracks[0]?.storageKey ?? track.storageKey,
          bytes: totalBytes,
          audioTracks: tracks,
        },
        new Set(tracks.map((item) => item.storageKey)),
      );
      return track.bytes;
    });
  }

  private async readExistingNetBook(localId: string): Promise<NetworkBook | undefined> {
    const known = this.library.find((book) => book.id === localId);
    if (known) return known;
    try {
      const stored = await idbGetNetBook<StoredNetBookRecord>(localId);
      if (stored && isStoredNetworkBook(stored)) return stored as unknown as NetworkBook;
    } catch {
      // ignore
    }
    return undefined;
  }

  /**
   * Сериализует сохранение файлов одной книги: две аудиодорожки могут
   * закончиться одновременно и обе дописывают одну запись NetworkBook.
   */
  private async withBookLock<T>(localId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.bookLocks.get(localId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.bookLocks.set(localId, chained);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.bookLocks.get(localId) === chained) this.bookLocks.delete(localId);
    }
  }

  // ------------------------------------------------------------------------- //
  // Сеть
  // ------------------------------------------------------------------------- //

  private async withFileTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>,
    parentSignal: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FILE_TIMEOUT_MS);
    const onParentAbort = (): void => controller.abort();
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    try {
      return await run(controller.signal);
    } catch (error) {
      if (timedOut && !parentSignal.aborted) {
        throw new Error(
          'Превышено время ожидания (120 секунд) при скачивании файла. Проверьте соединение и попробуйте снова.',
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }

  private async downloadWithRetry(
    task: DownloadTask,
    url: string,
    signal: AbortSignal,
    onProgress: (loaded: number, total: number) => void,
  ): Promise<{ bytes: Uint8Array; mime: string; finalUrl: string }> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.downloadOnce(url, signal, onProgress);
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof RetryableError && attempt < RETRY_DELAYS_MS.length) {
          attempt += 1;
          task.retries = attempt;
          this.emit();
          await delay(RETRY_DELAYS_MS[attempt - 1] ?? 3000);
          if (signal.aborted) throw error;
          continue;
        }
        throw error;
      }
    }
  }

  private async downloadOnce(
    url: string,
    signal: AbortSignal,
    onProgress: (loaded: number, total: number) => void,
  ): Promise<{ bytes: Uint8Array; mime: string; finalUrl: string }> {
    let response: Response;
    try {
      response = await fetch(url, { signal, redirect: 'follow', credentials: 'omit' });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new RetryableError('Не удалось подключиться к серверу источника. Проверьте соединение с интернетом.');
    }

    if (!response.ok) {
      const status = response.status;
      if (status === 408 || status === 425 || status === 429 || status >= 500) {
        throw new RetryableError(`Сервер источника временно недоступен (HTTP ${status}).`, status);
      }
      if (status === 401 || status === 403) {
        throw new Error(
          `Источник требует авторизации для скачивания (HTTP ${status}). Выберите издание с открытой лицензией.`,
        );
      }
      if (status === 404 || status === 410) {
        throw new Error(`Файл не найден на сервере источника (HTTP ${status}). Возможно, ссылка устарела.`);
      }
      throw new Error(`Сервер источника ответил ошибкой HTTP ${status}.`);
    }

    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    const declaredBytes = Number.isFinite(declaredLength) && declaredLength > 0 ? declaredLength : 0;
    if (declaredBytes > DEFAULT_LIMITS.maxBytes) {
      throw new Error(
        `Файл слишком большой: ${formatBytes(declaredBytes)} при лимите ${formatBytes(DEFAULT_LIMITS.maxBytes)}.`,
      );
    }

    const chunks: Uint8Array[] = [];
    let loaded = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        loaded += value.byteLength;
        if (loaded > DEFAULT_LIMITS.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(
            `Файл слишком большой: больше ${formatBytes(DEFAULT_LIMITS.maxBytes)}. Скачивание отменено.`,
          );
        }
        onProgress(loaded, declaredBytes);
      }
    } else {
      const buffer = new Uint8Array(await response.arrayBuffer());
      chunks.push(buffer);
      loaded = buffer.byteLength;
      if (loaded > DEFAULT_LIMITS.maxBytes) {
        throw new Error(
          `Файл слишком большой: ${formatBytes(loaded)} при лимите ${formatBytes(DEFAULT_LIMITS.maxBytes)}.`,
        );
      }
      onProgress(loaded, Math.max(declaredBytes, loaded));
    }

    if (loaded === 0) throw new Error('Источник вернул пустой файл — скачивать нечего.');

    const merged = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return {
      bytes: merged,
      mime: response.headers.get('content-type') ?? '',
      finalUrl: response.url || url,
    };
  }

  private updateProgress(task: DownloadTask, loaded: number, total: number, stage: DownloadStatus): void {
    let percent: number;
    if (total > 0) {
      percent = Math.min(99, Math.round((loaded / total) * 100));
    } else {
      // Сервер не сообщил размер: показываем «псевдопрогресс», чтобы полоска двигалась.
      percent = Math.min(95, Math.round((loaded / (loaded + 1024 * 1024)) * 100));
    }
    task.progress = { loaded, total, percent: Math.max(0, percent), stage };
    this.emitProgress();
  }

  // ------------------------------------------------------------------------- //
  // Сохранение результата
  // ------------------------------------------------------------------------- //

  private async commit(
    task: DownloadTask,
    options: {
      format: BookFormat;
      kind: ContentKind;
      storageKey: string;
      bytes: number;
      chapters?: number;
      audioTracks?: NonNullable<NetworkBook['audioTracks']>;
    },
    storageKeys: Set<string>,
  ): Promise<void> {
    const localId = localIdFor(task.book);
    await this.dropPreviousFiles(localId, storageKeys);

    const book: NetworkBook = {
      id: localId,
      sourceId: task.book.sourceId,
      sourceName: task.book.sourceName,
      externalId: task.book.externalId,
      catalogId: catalogIdFor(task.book),
      title: task.book.title,
      authors: [...task.book.authors],
      year: task.book.year,
      subjects: [...task.book.subjects],
      description: task.book.description,
      coverUrl: task.book.coverUrl,
      sourceUrl: task.book.sourceUrl,
      license: task.book.license,
      format: options.format,
      kind: options.kind,
      bytes: options.bytes,
      storageKey: options.storageKey,
      savedAt: Date.now(),
      chapters: options.chapters,
      audioTracks: options.audioTracks,
    };

    await idbPutNetBook({ ...book });
    this.library = [book, ...this.library.filter((item) => item.id !== book.id)].sort(
      (left, right) => right.savedAt - left.savedAt,
    );
    this.emit();
  }

  /** Убирает файлы прошлого скачивания этой же книги (другой формат). */
  private async dropPreviousFiles(localId: string, nextKeys: Set<string>): Promise<void> {
    const existing = this.library.find((book) => book.id === localId);
    const keys = new Set<string>();
    if (existing) {
      if (existing.storageKey && !nextKeys.has(existing.storageKey)) keys.add(existing.storageKey);
      for (const track of existing.audioTracks ?? []) {
        if (track.storageKey && !nextKeys.has(track.storageKey)) keys.add(track.storageKey);
      }
    }
    for (const format of KNOWN_FORMATS) {
      const key = fileKey(localId, format);
      if (!nextKeys.has(key)) keys.add(key);
    }
    for (const key of keys) await idbDeleteFile(key);
  }

  // ------------------------------------------------------------------------- //
  // Чтение и удаление
  // ------------------------------------------------------------------------- //

  async remove(localId: string): Promise<void> {
    if (this.removing.has(localId)) return;
    this.removing.add(localId);
    try {
      for (const task of this.tasks) {
        if (isRunning(task.status) && localIdFor(task.book) === localId) this.cancel(task.id);
      }

      const record = await this.readExistingNetBook(localId);

      const keys = new Set<string>();
      if (record) {
        if (record.storageKey) keys.add(record.storageKey);
        for (const track of record.audioTracks ?? []) {
          if (track.storageKey) keys.add(track.storageKey);
        }
      }
      for (const format of KNOWN_FORMATS) keys.add(fileKey(localId, format));
      for (const key of keys) await idbDeleteFile(key);
      // Дорожки нумеруются, их точные ключи могут быть неизвестны — чистим известный диапазон.
      for (let index = 1; index <= 64; index += 1) await idbDeleteFile(`${localId}.track-${index}`);

      await idbDeleteNetBook(localId);
      await idbDeleteBook(localId);

      this.library = this.library.filter((book) => book.id !== localId);
      this.tasks = this.tasks.filter((task) => localIdFor(task.book) !== localId);
      this.emit();
    } finally {
      this.removing.delete(localId);
    }
  }

  findByCatalogId(catalogId: string): NetworkBook | undefined {
    if (!catalogId) return undefined;
    return this.library.find((book) => (book.catalogId ?? catalogIdFor(book)) === catalogId);
  }

  async getContent(localId: string): Promise<BookContent | null> {
    try {
      const stored = await idbGetBook(localId);
      if (!stored) return null;
      return { id: stored.id, chapters: stored.chapters };
    } catch {
      return null;
    }
  }

  async getBlob(localId: string, trackKey?: string): Promise<Blob | null> {
    try {
      let storageKey = trackKey;
      if (!storageKey) {
        const known = this.library.find((book) => book.id === localId);
        if (known) {
          storageKey = known.storageKey;
        } else {
          const stored = await idbGetNetBook<StoredNetBookRecord>(localId);
          storageKey = stored && typeof stored.storageKey === 'string' ? stored.storageKey : undefined;
        }
      }
      if (!storageKey) return null;
      const file = await idbGetFile(storageKey);
      return file?.blob ?? null;
    } catch {
      return null;
    }
  }
}

/** Единственный экземпляр на приложение. */
export const downloads: DownloadsManager = new DownloadsManager();
