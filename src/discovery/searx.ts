/** Android-first free search through the official SearXNG instance registry. */
import { localBase } from './config';
import { searchDirect, type DirectKeys } from './direct';
import type { SearchHit } from './types';

interface RegistryInstance { network_type?: string; timing?: { initial?: { success_percentage?: number } } }
interface RegistryData { instances?: Record<string, RegistryInstance> }
export interface SearxInstance { url: string; success: number; checkedAt: number }
export interface DeviceSearchResult { hits: SearchHit[]; provider: string; errors: string[]; instances: SearxInstance[] }

const REGISTRY_URL = 'https://searx.space/data/instances.json';
const REGISTRY_CACHE = 'polka:searx-instances:v1';
const HEALTH_CACHE = 'polka:searx-health:v1';
const CUSTOM_KEY = 'polka:searx-custom:v1';
const QUERY_CACHE = 'polka:searx-cache:v1';
const HEALTH_TTL = 5 * 60_000;
const QUERY_TTL = 15 * 60_000;
const MAX_INSTANCES = 3;
const MAX_CACHED_QUERIES = 24;
const MIN_INTERVAL = 1_200;
const HEALTH_CHECK_INSTANCES = 6;
const SEARX_BUDGET = 10_000;

let lastRequestAt = 0;

interface CachedQuery { at: number; hits: SearchHit[] }

function readCache<T>(key: string): T | null {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : null; } catch { return null; }
}
function writeCache<T>(key: string, value: T): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* unavailable */ }
}
function validInstance(raw: string): boolean {
  try { const url = new URL(raw); return url.protocol === 'https:' && !/(localhost|127\.0\.0\.1|\.onion)$/i.test(url.hostname); } catch { return false; }
}

/** Свои экземпляры SearXNG (вводятся в настройках поиска). */
export function getCustomSearxInstances(): string[] {
  return (readCache<string[]>(CUSTOM_KEY) ?? []).filter(validInstance).map((url) => url.replace(/\/+$/, ''));
}

export function setCustomSearxInstances(value: string): string[] {
  const list = value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(validInstance)
    .map((item) => item.replace(/\/+$/, ''));
  writeCache(CUSTOM_KEY, [...new Set(list)]);
  return [...new Set(list)];
}

/** Официальный реестр + свои экземпляры. Свои проверяются первыми. */
export async function loadSearxInstances(signal?: AbortSignal): Promise<SearxInstance[]> {
  const custom = getCustomSearxInstances().map((url) => ({ url, success: 100, checkedAt: Date.now() }));
  let registry: SearxInstance[] = [];
  const cached = readCache<SearxInstance[]>(REGISTRY_CACHE);
  if (cached?.length) {
    registry = cached;
  } else {
    try {
      const response = await fetch(REGISTRY_URL, {
        signal: signal ?? AbortSignal.timeout(6_000),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Registry HTTP ${response.status}`);
      const data = await response.json() as RegistryData;
      registry = Object.entries(data.instances ?? {})
        .filter(([url, item]) => validInstance(url) && item.network_type === 'normal' && (item.timing?.initial?.success_percentage ?? 0) >= 90)
        .map(([url, item]) => ({ url: url.replace(/\/+$/, ''), success: item.timing?.initial?.success_percentage ?? 0, checkedAt: Date.now() }))
        .sort((a, b) => b.success - a.success);
      if (registry.length) writeCache(REGISTRY_CACHE, registry);
    } catch {
      // Реестр может быть недоступен; свои экземпляры продолжают работать.
    }
  }
  const seen = new Set(custom.map((item) => item.url));
  return [...custom, ...registry.filter((item) => !seen.has(item.url))];
}

/** Пауза между запросами к публичным узлам (уважаем rate limit). */
async function throttle(signal?: AbortSignal): Promise<void> {
  const wait = Math.max(0, MIN_INTERVAL - (Date.now() - lastRequestAt));
  if (wait > 0 && !signal?.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, wait);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  lastRequestAt = Date.now();
}

/** JSON-запрос с обходом CORS через локальный прокси приложения. */
async function fetchJsonUrl(url: string, signal?: AbortSignal): Promise<unknown> {
  const requestSignal = signal ?? AbortSignal.timeout(10_000);
  try {
    const direct = await fetch(url, { signal: requestSignal, headers: { Accept: 'application/json' } });
    if (direct.ok && (direct.headers.get('content-type') ?? '').includes('json')) return await direct.json();
  } catch {
    /* CORS или сеть — пробуем локальный прокси */
  }
  const base = localBase();
  if (!base) throw new Error('JSON-источник недоступен');
  const proxied = await fetch(`${base}/api/page?url=${encodeURIComponent(url)}`, {
    signal: requestSignal,
    headers: { Accept: 'application/json' },
  });
  if (!proxied.ok) throw new Error(`HTTP ${proxied.status}`);
  return await proxied.json();
}

/** JSON-запрос к SearXNG: напрямую, затем через локальный прокси (обход CORS). */
async function searxJson(instance: SearxInstance, path: string, signal?: AbortSignal): Promise<unknown> {
  return fetchJsonUrl(`${instance.url}${path}`, signal);
}

async function healthyInstances(instances: SearxInstance[], signal?: AbortSignal): Promise<SearxInstance[]> {
  const status = readCache<Record<string, { ok: boolean; at: number }>>(HEALTH_CACHE) ?? {};
  const now = Date.now();
  const pending = instances.filter((instance) => !status[instance.url] || now - status[instance.url].at > HEALTH_TTL);
  await Promise.all(pending.slice(0, HEALTH_CHECK_INSTANCES).map(async (instance) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const data = await searxJson(instance, '/search?q=test&format=json', controller.signal) as { results?: unknown[] };
      status[instance.url] = { ok: Array.isArray(data.results), at: now };
    } catch { status[instance.url] = { ok: false, at: now }; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }));
  writeCache(HEALTH_CACHE, status);
  return instances.filter((instance) => status[instance.url]?.ok).slice(0, MAX_INSTANCES);
}

function fromSearx(value: unknown): SearchHit | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const url = typeof item.url === 'string' ? item.url : '';
  if (!/^https?:\/\//.test(url)) return null;
  return { engine: 'searxng', url, title: String(item.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 300), snippet: String(item.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) };
}

async function searchInstance(instance: SearxInstance, query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const data = await searxJson(instance, `/search?q=${encodeURIComponent(query)}&format=json&language=ru`, controller.signal) as { results?: unknown[] };
    return (data.results ?? []).map(fromSearx).filter((item): item is SearchHit => Boolean(item));
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function cacheKey(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

function readQueryCache(query: string): SearchHit[] | null {
  const cache = readCache<Record<string, CachedQuery>>(QUERY_CACHE);
  const entry = cache?.[cacheKey(query)];
  if (!entry || Date.now() - entry.at > QUERY_TTL) return null;
  return entry.hits;
}

function writeQueryCache(query: string, hits: SearchHit[]): void {
  if (hits.length === 0) return;
  const cache = readCache<Record<string, CachedQuery>>(QUERY_CACHE) ?? {};
  const key = cacheKey(query);
  cache[key] = { at: Date.now(), hits };
  const entries = Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CACHED_QUERIES);
  writeCache(QUERY_CACHE, Object.fromEntries(entries));
}

export async function searchOnDevice(query: string, keys: DirectKeys, options: { signal?: AbortSignal; limit?: number } = {}): Promise<DeviceSearchResult> {
  const errors: string[] = [];
  const parts: SearchHit[][] = [];
  const directPromise = searchDirect(query, keys, options.limit ?? 12).catch(() => [] as SearchHit[]);
  let usedInstances: SearxInstance[] = [];

  const cachedHits = readQueryCache(query);
  const searxPromise = cachedHits
    ? Promise.resolve(cachedHits)
    : (async () => {
        // Общий бюджет: публичные узлы не должны задерживать выдачу.
        const controller = new AbortController();
        const abort = () => controller.abort();
        options.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(), SEARX_BUDGET);
        try {
          const instances = await loadSearxInstances(controller.signal);
          const healthy = await healthyInstances(instances, controller.signal);
          usedInstances = healthy.slice(0, 2);
          if (usedInstances.length === 0) {
            errors.push('Публичные SearXNG временно не принимают автоматические запросы');
            return [] as SearchHit[];
          }
          await throttle(controller.signal);
          const answers = await Promise.all(
            usedInstances.map(async (instance) => {
              try {
                return await searchInstance(instance, query, controller.signal);
              } catch {
                return [] as SearchHit[];
              }
            }),
          );
          const searxHits = answers.flat();
          if (searxHits.length) writeQueryCache(query, searxHits);
          return searxHits;
        } catch (error) {
          errors.push(error instanceof Error ? error.message : 'SearXNG unavailable');
          return [] as SearchHit[];
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
        }
      })();

  const [direct, searxHits] = await Promise.all([directPromise, searxPromise]);
  if (direct.length) parts.push(direct);
  if (searxHits.length) parts.push(searxHits);

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const item of parts.flat()) {
    const key = item.url.replace(/[#?].*$/, '').replace(/^https?:\/\/www\./, 'https://');
    if (!seen.has(key)) { seen.add(key); hits.push(item); }
  }
  return { hits: hits.slice(0, options.limit ?? 12), provider: parts.length > 1 ? 'direct+searxng' : parts.length ? 'direct' : 'none', errors, instances: usedInstances };
}
