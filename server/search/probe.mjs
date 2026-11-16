/**
 * DownloadLinkValidator: проверяет, можно ли скачать файл по ссылке.
 *
 * Возвращает честный статус вместо фиктивной кнопки:
 *  - ok — файл доступен;
 *  - requiresAuth — нужна авторизация (401/403);
 *  - purchase — только покупка (402/451);
 *  - missing — файла нет (404/410);
 *  - blocked — источник запрещает автоматическое скачивание (405/406, HTML вместо файла);
 *  - unavailable — прочее.
 */
import { validateUrl } from './analyze.mjs';

const TIMEOUT = 12_000;

function reasonFor(status) {
  if (status === 401 || status === 403) return { reason: 'requiresAuth', message: 'Требуется авторизация на сайте' };
  if (status === 402 || status === 451) return { reason: 'purchase', message: 'Доступ только по подписке или покупке' };
  if (status === 404 || status === 410) return { reason: 'missing', message: 'Файл отсутствует у источника' };
  if (status === 405 || status === 406) return { reason: 'blocked', message: 'Источник не разрешает автоматическое скачивание' };
  if (status === 429) return { reason: 'unavailable', message: 'Источник ограничил частоту запросов' };
  return { reason: 'unavailable', message: `Источник ответил ${status}` };
}

function formatOf(url, mime) {
  const lower = `${url} ${mime ?? ''}`.toLowerCase();
  if (lower.includes('epub')) return 'epub';
  if (lower.includes('fb2') || lower.includes('fictionbook')) return 'fb2';
  if (lower.includes('pdf')) return 'pdf';
  if (lower.includes('mobipocket') || lower.includes('.mobi')) return 'mobi';
  if (lower.includes('azw3')) return 'azw3';
  if (lower.includes('text/plain') || lower.includes('.txt')) return 'txt';
  return undefined;
}

/** Проверяет доступность файла (HEAD, при необходимости — GET с Range). */
export async function probeUrl(rawUrl, options = {}) {
  const valid = validateUrl(rawUrl);
  if (!valid.ok) return { url: rawUrl, ok: false, reason: 'invalid', message: valid.error };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout ?? TIMEOUT);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13) PolkaBooks/1.4',
    Accept: '*/*',
  };
  try {
    let response = await fetch(valid.url.toString(), { method: 'HEAD', redirect: 'follow', signal: controller.signal, headers });
    let size = Number(response.headers.get('content-length') ?? 0);
    let mime = response.headers.get('content-type') ?? '';

    if (!response.ok || response.status === 405) {
      const ranged = await fetch(valid.url.toString(), {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { ...headers, Range: 'bytes=0-0' },
      });
      if (ranged.ok || ranged.status === 206) {
        const contentRange = ranged.headers.get('content-range');
        size = Number(contentRange?.match(/\/(\d+)$/)?.[1] ?? ranged.headers.get('content-length') ?? 0);
        mime = ranged.headers.get('content-type') ?? mime;
        response = ranged;
      }
    }

    if (!response.ok && response.status !== 206) {
      const { reason, message } = reasonFor(response.status);
      return { url: rawUrl, status: response.status, ok: false, reason, message };
    }

    const isHtml = /text\/html/i.test(mime);
    const format = formatOf(rawUrl, mime);
    if (isHtml) {
      return {
        url: rawUrl,
        status: response.status,
        ok: false,
        reason: 'blocked',
        format,
        message: 'Вместо файла сайт отдаёт страницу — нужно открыть страницу скачивания',
      };
    }
    if (size > 0 && size < 1024) {
      return { url: rawUrl, status: response.status, ok: false, reason: 'missing', sizeBytes: size, format, message: 'Файл пустой или повреждён' };
    }

    return {
      url: rawUrl,
      status: response.status,
      ok: true,
      sizeBytes: size > 0 ? size : undefined,
      mime,
      format,
      message: 'Файл доступен для скачивания',
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      url: rawUrl,
      ok: false,
      reason: 'unavailable',
      message: aborted ? 'Источник не ответил вовремя' : 'Не удалось проверить файл',
    };
  } finally {
    clearTimeout(timer);
  }
}
