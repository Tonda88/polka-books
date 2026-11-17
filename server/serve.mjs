#!/usr/bin/env node
/**
 * Сервер «Полки»: статика собранного приложения + прокси открытых файлов.
 *
 * Зачем прокси: Internet Archive отдаёт CORS для TXT и MP3, но не для
 * EPUB/PDF/DJVU. Браузер не может скачать такие файлы напрямую, хотя они
 * свободно доступны. Прокси скачивает их на сервере и отдаёт приложению.
 *
 * Ограничения безопасности:
 *  - только белый список доменов (никаких произвольных URL);
 *  - только http(s), без локальных адресов;
 *  - лимит размера и таймаут;
 *  - DRM и авторизованные ресурсы не затрагиваются.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { searchWeb, providerStatus } from './search/providers.mjs';
import { analyzePage } from './search/analyze.mjs';
import { probeUrl } from './search/probe.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const distDir = join(root, 'dist');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

const ALLOWED_HOSTS = [
  'archive.org',
  'openlibrary.org',
  'covers.openlibrary.org',
  'gutenberg.org',
  'www.gutenberg.org',
  'librivox.org',
  'www.librivox.org',
];
const ALLOWED_SUFFIXES = ['.archive.org'];
const MAX_BYTES = 600 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 180_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function isAllowedHost(hostname) {
  const host = hostname.toLowerCase();
  if (ALLOWED_HOSTS.includes(host)) return true;
  return ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function proxyFile(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const target = requestUrl.searchParams.get('url');
  if (!target) {
    sendJson(res, 400, { error: 'Параметр url обязателен' });
    return;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    sendJson(res, 400, { error: 'Некорректный URL' });
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    sendJson(res, 400, { error: 'Разрешены только http(s)-адреса' });
    return;
  }
  if (!isAllowedHost(parsed.hostname)) {
    sendJson(res, 403, { error: `Домен ${parsed.hostname} не входит в белый список разрешённых источников` });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const range = req.headers.range;

  try {
    const upstream = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'PolkaBooks/1.0 (public-domain book downloader)',
        Accept: '*/*',
        ...(range ? { Range: range } : {}),
      },
    });

    if (!upstream.ok && upstream.status !== 206) {
      sendJson(res, upstream.status === 404 ? 404 : 502, {
        error: `Источник вернул ${upstream.status}`,
      });
      return;
    }
    const declared = Number(upstream.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) {
      sendJson(res, 413, { error: 'Файл больше допустимого размера' });
      return;
    }

    const headers = {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': upstream.headers.get('accept-ranges') ?? 'bytes',
      'Cache-Control': 'public, max-age=86400',
    };
    const length = upstream.headers.get('content-length');
    if (length) headers['Content-Length'] = length;
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) headers['Content-Range'] = contentRange;

    res.writeHead(upstream.status === 206 ? 206 : 200, headers);
    if (upstream.body) {
      const stream = Readable.fromWeb(upstream.body);
      // Обрыв загрузки источника не должен ронять сервер.
      stream.on('error', () => {
        if (!res.destroyed) res.destroy();
      });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
    if (!res.headersSent) sendJson(res, 502, { error: `Не удалось получить файл: ${message}` });
    else res.end();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Прокси Google Books: ключ хранится в переменной окружения сервера
 * (GOOGLE_BOOKS_KEY) и никогда не попадает в клиентский код. Если ключа
 * на сервере нет, используется ключ, переданный пользователем из настроек.
 */
async function proxyGoogleBooks(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const path = (requestUrl.searchParams.get('path') ?? '').replace(/^\/+/, '');
  if (!/^[A-Za-z0-9/_-]+$/.test(path)) {
    sendJson(res, 400, { error: 'Некорректный путь запроса Google Books' });
    return;
  }

  const params = new URLSearchParams();
  for (const [name, value] of requestUrl.searchParams.entries()) {
    if (name === 'path' || name === 'key') continue;
    params.set(name, value);
  }
  const key = process.env.GOOGLE_BOOKS_KEY || requestUrl.searchParams.get('key') || '';
  if (!key) {
    sendJson(res, 503, {
      error: 'Google Books: на сервере не настроен GOOGLE_BOOKS_KEY, и ключ не передан клиентом',
    });
    return;
  }
  params.set('key', key);

  const target = `https://www.googleapis.com/books/v1/${path}?${params.toString()}`;
  try {
    const upstream = await fetch(target, {
      signal: AbortSignal.timeout(25_000),
      headers: { Accept: 'application/json' },
    });
    const body = await upstream.text();
    res.writeHead(upstream.ok ? 200 : upstream.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
    sendJson(res, 502, { error: `Google Books недоступен: ${message}` });
  }
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(distDir, safePath);

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // SPA-фолбэк: всё неизвестное отдаём как index.html.
    const indexPath = join(distDir, 'index.html');
    if (!existsSync(indexPath)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Сборка не найдена. Выполните: pnpm build');
      return;
    }
    const body = createReadStream(indexPath);
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    body.pipe(res);
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  const stats = statSync(filePath);
  const headers = { 'Content-Type': type, 'Content-Length': stats.size };
  if (ext === '.json' || ext === '.js' || ext === '.css') headers['Cache-Control'] = 'no-cache';
  res.writeHead(200, headers);
  createReadStream(filePath).pipe(res);
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
    });
    res.end();
    return;
  }

  const pathname = (req.url ?? '').split('?')[0];

  if (pathname === '/api/search/status') {
    sendJson(res, 200, { providers: providerStatus() });
    return;
  }
  if (pathname === '/api/search') {
    void (async () => {
      const requestUrl = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const query = requestUrl.searchParams.get('q') ?? '';
      const engines = (requestUrl.searchParams.get('engines') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const limit = Number(requestUrl.searchParams.get('limit') ?? 20);
      try {
        const result = await searchWeb(query, { engines, limit: Number.isFinite(limit) ? limit : 20 });
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 502, { error: error instanceof Error ? error.message : 'Поиск не удался' });
      }
    })();
    return;
  }

  if (pathname === '/api/page') {
    void (async () => {
      const requestUrl = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const target = requestUrl.searchParams.get('url') ?? '';
      const { validateUrl } = await import('./search/analyze.mjs');
      const valid = validateUrl(target);
      if (!valid.ok) {
        sendJson(res, 400, { error: valid.error });
        return;
      }
      try {
        const upstream = await fetch(valid.url.toString(), {
          signal: AbortSignal.timeout(15_000),
          redirect: 'follow',
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13) PolkaBooks/1.4',
            'Accept-Language': 'ru,en;q=0.8',
          },
        });
        if (!upstream.ok) {
          sendJson(res, upstream.status, { error: `Страница ответила ${upstream.status}` });
          return;
        }
        const html = (await upstream.text()).slice(0, 3 * 1024 * 1024);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(html);
      } catch (error) {
        sendJson(res, 502, { error: error instanceof Error ? error.message : 'Не удалось открыть страницу' });
      }
    })();
    return;
  }
  if (pathname === '/api/analyze') {
    void (async () => {
      const requestUrl = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const target = requestUrl.searchParams.get('url') ?? '';
      try {
        const result = await analyzePage(target);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Анализ не удался' });
      }
    })();
    return;
  }
  if (pathname === '/api/probe') {
    void (async () => {
      const requestUrl = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const target = requestUrl.searchParams.get('url') ?? '';
      try {
        const result = await probeUrl(target);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Проверка не удалась' });
      }
    })();
    return;
  }
  if (pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      proxy: true,
      googleBooks: Boolean(process.env.GOOGLE_BOOKS_KEY),
      host: HOST,
      port: PORT,
    });
    return;
  }
  if (pathname === '/api/fetch') {
    void proxyFile(req, res);
    return;
  }
  if (pathname === '/api/googlebooks') {
    void proxyGoogleBooks(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Полка запущена: http://${HOST}:${PORT}`);
  console.log('Прокси открытых файлов: /api/fetch?url=… (только archive.org и разрешённые каталоги)');
});
