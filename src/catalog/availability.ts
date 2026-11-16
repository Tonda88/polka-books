/**
 * Проверка доступности файлов до скачивания.
 *
 * Скачивание «вслепую» — плохой опыт: битая ссылка или 403 выясняются
 * уже после загрузки. Здесь проверяем файл лёгким HEAD-запросом
 * (или Range 0-0, если сервер не любит HEAD), узнаём реальный размер,
 * тип и код ответа. Для EPUB/PDF из Internet Archive запрос идёт через
 * прокси, потому что прямой ответ не отдаёт CORS.
 */
import { resolveDownloadUrl } from './proxy';
import type { CatalogBook, DownloadFile } from './types';

export interface FileProbe {
  url: string;
  ok: boolean;
  status?: number;
  sizeBytes?: number;
  contentType?: string;
  error?: string;
  checkedAt: number;
  viaProxy: boolean;
}

// Прокси может быть медленнее прямого запроса: даём ему больше времени.
const PROBE_TIMEOUT = 25_000;
const PROBE_TIMEOUT_DIRECT = 15_000;

/** Один запрос: HEAD, при неудаче — GET с Range 0-0. */
async function requestProbe(url: string, signal?: AbortSignal): Promise<FileProbe> {
  const controllers: AbortController[] = [];
  const limitMs = url.startsWith('/api/') ? PROBE_TIMEOUT : PROBE_TIMEOUT_DIRECT;
  const timeout = setTimeout(() => controllers.forEach((controller) => controller.abort()), limitMs);
  const combined = new AbortController();
  const onAbort = () => combined.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  controllers.push(combined);

  try {
    const head = await fetch(url, { method: 'HEAD', signal: combined.signal, redirect: 'follow' });
    if (head.ok || head.status === 206) {
      const length = Number(head.headers.get('content-length') ?? 0);
      return {
        url,
        ok: true,
        status: head.status,
        sizeBytes: Number.isFinite(length) && length > 0 ? length : undefined,
        contentType: head.headers.get('content-type') ?? undefined,
        checkedAt: Date.now(),
        viaProxy: url.startsWith('/api/'),
      };
    }
    if (head.status === 405 || head.status === 501) {
      // HEAD не поддерживается — проверяем Range-запросом.
      const ranged = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: combined.signal,
        redirect: 'follow',
      });
      const contentRange = ranged.headers.get('content-range');
      const total = contentRange?.match(/\/(\d+)$/)?.[1];
      return {
        url,
        ok: ranged.ok || ranged.status === 206,
        status: ranged.status,
        sizeBytes: total ? Number(total) : undefined,
        contentType: ranged.headers.get('content-type') ?? undefined,
        checkedAt: Date.now(),
        viaProxy: url.startsWith('/api/'),
      };
    }
    return {
      url,
      ok: false,
      status: head.status,
      error: head.status === 404 ? 'Файл не найден у источника' : `Источник ответил ${head.status}`,
      checkedAt: Date.now(),
      viaProxy: url.startsWith('/api/'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Сеть недоступна';
    return {
      url,
      ok: false,
      error: message.includes('abort') ? 'Источник не ответил вовремя' : message,
      checkedAt: Date.now(),
      viaProxy: url.startsWith('/api/'),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Проверяет один файл книги, при необходимости — через прокси. */
export async function probeFile(
  file: Pick<DownloadFile, 'url' | 'format'>,
  options: { signal?: AbortSignal } = {},
): Promise<FileProbe> {
  if (!file.url) {
    return { url: '', ok: false, error: 'У файла нет ссылки', checkedAt: Date.now(), viaProxy: false };
  }
  if (file.url.startsWith('/api/')) {
    return requestProbe(file.url, options.signal);
  }
  const viaProxy = await resolveDownloadUrl(file.url, file.format);
  const result = await requestProbe(viaProxy, options.signal);
  // Если прокси недоступен, пробуем прямой адрес (TXT/MP3 отдают CORS).
  if (!result.ok && viaProxy !== file.url && result.status !== 404) {
    return requestProbe(file.url, options.signal);
  }
  return result;
}

export interface VerifiedFile extends DownloadFile {
  probe?: FileProbe;
  /** Проверено и доступно. */
  available?: boolean;
}

export interface VerifiedBook extends CatalogBook {
  files: VerifiedFile[];
  /** Все проверенные файлы недоступны. */
  filesUnavailable?: boolean;
  checkedAt?: number;
}

/**
 * Проверяет файлы книги (не больше `limit` одновременно).
 * Недоступные файлы не удаляем, а помечаем — UI покажет честный статус.
 */
export async function verifyBookFiles(
  book: CatalogBook,
  options: { signal?: AbortSignal; limit?: number; maxFiles?: number } = {},
): Promise<VerifiedBook> {
  const limit = Math.max(1, Math.min(4, options.limit ?? 3));
  const maxFiles = options.maxFiles ?? 6;
  const targets = book.files.slice(0, maxFiles);
  const results: VerifiedFile[] = [];
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, targets.length) }, async () => {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      const file = targets[index];
      if (file.requiresAuth) {
        results[index] = { ...file };
        continue;
      }
      const probe = await probeFile(file, { signal: options.signal });
      results[index] = {
        ...file,
        sizeBytes: file.sizeBytes ?? probe.sizeBytes,
        probe,
        available: probe.ok,
        label: file.label ?? formatLabel(file.format, file.sizeBytes ?? probe.sizeBytes),
      };
    }
  });
  await Promise.all(workers);

  const verified = results.filter(Boolean);
  const anyAvailable = verified.some((file) => file.available);
  const downloadable = verified.filter((file) => !file.requiresAuth);
  return {
    ...book,
    files: verified,
    filesUnavailable: downloadable.length > 0 && !anyAvailable,
    checkedAt: Date.now(),
  };
}

function formatLabel(format: string, bytes?: number): string {
  const name = format.toUpperCase();
  if (!bytes) return name;
  if (bytes >= 1024 * 1024) return `${name}, ${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
  return `${name}, ${Math.max(1, Math.round(bytes / 1024))} КБ`;
}
