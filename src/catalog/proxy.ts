/**
 * Доступ к прокси открытых файлов на своём сервере.
 *
 * Internet Archive отдаёт CORS для TXT и MP3, но не для EPUB/PDF/DJVU.
 * Приложение запускается со своего сервера (server/serve.mjs), который
 * умеет забирать такие файлы и отдавать их браузеру. Если приложение
 * открыто как чистая статика (без сервера), прокси недоступен — тогда
 * такие форматы честно помечаются как «открыть у источника».
 */

let proxyAvailable: boolean | null = null;
let proxyCheck: Promise<boolean> | null = null;

/** Проверяет, доступен ли прокси нашего сервера (один раз, с кэшем). */
export async function isProxyAvailable(): Promise<boolean> {
  if (proxyAvailable !== null) return proxyAvailable;
  if (proxyCheck) return proxyCheck;
  proxyCheck = (async () => {
    try {
      const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (!response.ok) return false;
      const data = (await response.json()) as { proxy?: boolean };
      return Boolean(data.proxy);
    } catch {
      return false;
    }
  })();
  proxyAvailable = await proxyCheck;
  proxyCheck = null;
  return proxyAvailable;
}

/**
 * Форматы, которые браузер не может скачать напрямую из-за отсутствия CORS.
 * TXT и MP3 отдаются с CORS, поэтому их качаем напрямую (быстрее и без сервера).
 */
const NEEDS_PROXY = new Set(['epub', 'pdf', 'fb2', 'djvu', 'mobi', 'html']);

export function needsProxy(format: string): boolean {
  return NEEDS_PROXY.has(format.toLowerCase());
}

/** URL для скачивания: прокси, если нужен и доступен, иначе исходный. */
export async function resolveDownloadUrl(url: string, format: string): Promise<string> {
  if (!needsProxy(format)) return url;
  if (!(await isProxyAvailable())) return url;
  return `/api/fetch?url=${encodeURIComponent(url)}`;
}

/** Прямая ссылка, которую можно открыть у источника, если скачивание недоступно. */
export function directUrl(url: string): string {
  return url;
}
