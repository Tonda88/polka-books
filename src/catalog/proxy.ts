/**
 * Доступ к прокси открытых файлов на своём сервере.
 *
 * Internet Archive отдаёт CORS для TXT и MP3, но не для EPUB/PDF/DJVU.
 * Приложение запускается со своего сервера (server/serve.mjs на ПК,
 * LocalServer.java в APK), который умеет забирать такие файлы и отдавать
 * их браузеру. Если приложение открыто как чистая статика (без сервера),
 * прокси недоступен — тогда такие форматы честно помечаются как
 * «открыть у источника».
 *
 * Тот же прокси используется для Google Books: ключ можно держать на
 * сервере (переменная окружения GOOGLE_BOOKS_KEY), и тогда он не попадает
 * в клиентский код и не требуется от пользователя.
 */

let proxyAvailable: boolean | null = null;
let proxyCheck: Promise<boolean> | null = null;
let proxyMode = false;
let serverGoogleBooksKey = false;

export interface ProxyHealth {
  ok: boolean;
  proxy: boolean;
  googleBooks: boolean;
}

/** Проверяет прокси нашего сервера (один раз, результат кэшируется). */
export async function checkProxyHealth(): Promise<ProxyHealth> {
  try {
    const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!response.ok) return { ok: false, proxy: false, googleBooks: false };
    const data = (await response.json()) as { proxy?: boolean; googleBooks?: boolean };
    return { ok: true, proxy: Boolean(data.proxy), googleBooks: Boolean(data.googleBooks) };
  } catch {
    return { ok: false, proxy: false, googleBooks: false };
  }
}

export async function isProxyAvailable(): Promise<boolean> {
  if (proxyAvailable !== null) return proxyAvailable;
  if (proxyCheck) return proxyCheck;
  proxyCheck = (async () => {
    const health = await checkProxyHealth();
    serverGoogleBooksKey = health.googleBooks;
    return health.proxy;
  })();
  proxyAvailable = await proxyCheck;
  proxyCheck = null;
  return proxyAvailable;
}

/** Включает/выключает серверный режим (вызывается при старте приложения). */
export async function ensureProxyMode(): Promise<boolean> {
  const available = await isProxyAvailable();
  proxyMode = available;
  return available;
}

export function setProxyMode(value: boolean): void {
  proxyMode = value;
  proxyAvailable = value;
}

export function isProxyMode(): boolean {
  return proxyMode;
}

/** Настроен ли ключ Google Books на сервере (тогда ключ пользователя не нужен). */
export function hasServerGoogleKey(): boolean {
  return serverGoogleBooksKey;
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

/**
 * Адрес запроса к Google Books через серверный прокси.
 * Ключ пользователя добавляется как `key`, сервер может подставить свой.
 */
export function googleBooksProxyUrl(
  path: string,
  params: Record<string, string | number | undefined>,
  userKey?: string | null,
): string {
  const search = new URLSearchParams();
  search.set('path', path.replace(/^\/+/, ''));
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(name, String(value));
  }
  if (userKey) search.set('key', userKey);
  return `/api/googlebooks?${search.toString()}`;
}
