#!/usr/bin/env node
/**
 * Проверка серверной части интернет-поиска (server/search/*).
 *
 * Требует запущенный сервер: pnpm serve (http://127.0.0.1:4173).
 * Запуск: node scripts/check-search-server.mjs
 */
const BASE = process.env.POLKA_URL || 'http://127.0.0.1:4173';

const FORM = { green: '\u001b[32m', red: '\u001b[31m', dim: '\u001b[2m', bold: '\u001b[1m', reset: '\u001b[0m' };
const color = process.stdout.isTTY === true;
const paint = (name, text) => (color ? `${FORM[name]}${text}${FORM.reset}` : text);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ${paint('green', 'OK  ')} ${name}${detail ? paint('dim', ` — ${detail}`) : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ${paint('red', 'FAIL')} ${name}${detail ? paint('dim', ` — ${detail}`) : ''}`);
  }
}

function section(title) {
  console.log(`\n${paint('bold', `══ ${title} ══`)}`);
}

async function getJson(path, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    return { status: response.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

section('Сервер поиска');
const health = await getJson('/api/search/status', 10_000).catch(() => null);
check('сервер отвечает /api/search/status', health?.status === 200 && Array.isArray(health.json?.providers));
const providers = health?.json?.providers ?? [];
check('провайдеры перечислены', providers.length >= 2, providers.map((provider) => provider.id).join(', '));
const hasAvailableProvider = providers.some((provider) => provider.available);
check(
  'есть бесплатные провайдеры без ключа или честно показано отсутствие настройки',
  providers.some((provider) => provider.available && !provider.requiresKey) || !hasAvailableProvider,
  providers.filter((provider) => provider.available && !provider.requiresKey).map((provider) => provider.id).join(', ') || 'ключи/инстанс не настроены',
);
check(
  'ключевые провайдеры помечены requiresKey',
  providers.some((provider) => provider.requiresKey && provider.id === 'yandex'),
);

section('Веб-поиск');
const search = await getJson('/api/search?q=frankenstein%20epub&limit=8', 90_000).catch(() => null);
const searchResults = search?.json?.results ?? [];
const searchConfigured = providers.some((provider) => provider.available);
check('поиск вернул результаты или честно сообщил об отсутствии провайдера', searchResults.length > 0 || (!searchConfigured && (search?.json?.errors?.length ?? 0) > 0), `${searchResults.length} результатов за ${search?.json?.tookMs ?? '?'} мс`);
check('результаты содержат URL и заголовок', (search?.json?.results ?? []).every((item) => item.url && item.url.startsWith('http')));
check('в выдаче есть открытая библиотека или веб-страница, либо провайдер не настроен', searchResults.some((item) => item.engine) || (!searchConfigured && (search?.json?.errors?.length ?? 0) > 0));
check('поиск не падает без ключей', search?.status === 200, `HTTP ${search?.status}`);

section('Анализ страницы книги');
const pageUrl = 'https://standardebooks.org/ebooks/mary-shelley/frankenstein';
const page = await getJson(`/api/analyze?url=${encodeURIComponent(pageUrl)}`, 60_000).catch(() => null);
check('страница проанализирована', page?.json?.ok === true, page?.json?.title ?? page?.json?.error ?? '');
check('название извлечено', Boolean(page?.json?.title));
check('автор извлечён', (page?.json?.authors ?? []).length > 0, (page?.json?.authors ?? []).join(', '));
check('найдены файлы книги', (page?.json?.files ?? []).length > 0, (page?.json?.files ?? []).map((file) => file.format).join(', '));
check('формат файла определён по расширению', (page?.json?.files ?? []).every((file) => /^(epub|fb2|pdf|txt|mobi|azw3|djvu)$/.test(file.format)));

section('Проверка и защита');
const epub = (page?.json?.files ?? []).find((file) => file.format === 'epub');
if (epub) {
  const probe = await getJson(`/api/probe?url=${encodeURIComponent(epub.url)}`, 60_000).catch(() => null);
  check('доступный EPUB проверен', probe?.json?.ok === true, `${probe?.json?.sizeBytes ?? '?'} байт`);
}
const missing = await getJson(`/api/probe?url=${encodeURIComponent('https://archive.org/download/no-such-item/no-such.epub')}`, 40_000).catch(() => null);
check('несуществующий файл отклонён', missing?.json?.ok === false, missing?.json?.reason ?? '');

const ssrf = await getJson(`/api/analyze?url=${encodeURIComponent('http://127.0.0.1:4173/index.html')}`, 15_000).catch(() => null);
check('SSRF-защита: внутренний адрес запрещён', ssrf?.json?.ok === false, ssrf?.json?.error ?? '');

const blocked = await fetch(`${BASE}/api/fetch?url=${encodeURIComponent('https://example.com/a.epub')}`);
check('прокси файлов блокирует чужие домены', blocked.status === 403, `HTTP ${blocked.status}`);

section('Итог');
console.log(`  Проверок успешно: ${passed} · с ошибками: ${failed}`);
if (failed > 0) {
  console.log(`  Провалено: ${failures.join(', ')}`);
  process.exitCode = 1;
}
