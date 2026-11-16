import { chromium } from 'playwright-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.POLKA_URL || 'http://127.0.0.1:4173';
const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--mute-audio'] });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })).newPage();
page.setDefaultTimeout(90_000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
if (await page.locator('.onboarding').count()) {
  await page.getByRole('button', { name: 'Пропустить' }).click();
  await page.waitForSelector('.home');
}
await page.evaluate(() => { location.hash = '/search'; });
await page.waitForSelector('.search-hero');

// Быстрая смена запросов: каждый новый ввод отменяет предыдущие запросы.
const input = page.locator('.search-field input, input[type="search"]').first();
const queries = ['f', 'fr', 'fra', 'fran', 'frank', 'franke', 'franken', 'frankenstein'];
for (const query of queries) {
  await input.fill(query);
  await page.waitForTimeout(260);
}
await page.waitForSelector('.catalog-list .catalog-card', { timeout: 90_000 }).catch(() => {});
await page.waitForTimeout(2500);

const first = await page.evaluate(() => ({
  cards: document.querySelectorAll('.catalog-list .catalog-card').length,
  skipped: /временно пропущен/i.test(document.body.innerText),
  errors: document.querySelector('.source-errors')?.textContent?.replace(/\s+/g, ' ') ?? '',
}));
console.log('after rapid typing:', JSON.stringify(first));

// Ещё одна серия смен запросов и явное обновление.
for (const query of ['tol', 'tolk', 'tolkie', 'tolkien']) {
  await input.fill(query);
  await page.waitForTimeout(240);
}
await page.waitForSelector('.catalog-list .catalog-card', { timeout: 90_000 }).catch(() => {});
await page.waitForTimeout(2500);
const retry = page.getByRole('button', { name: 'Обновить' }).first();
if ((await retry.count()) > 0) await retry.click();
await page.waitForTimeout(6000);

const second = await page.evaluate(() => ({
  cards: document.querySelectorAll('.catalog-list .catalog-card').length,
  skipped: /временно пропущен/i.test(document.body.innerText),
  retryButton: Boolean(document.querySelector('.source-errors__retry')),
}));
console.log('after second burst + refresh:', JSON.stringify(second));
console.log('page errors:', errors.slice(0, 5));
await page.screenshot({ path: 'screenshots/71-rapid-search.png' });
await browser.close();

const ok = first.cards > 0 && !first.skipped && second.cards > 0 && !second.skipped;
console.log(ok ? 'RESULT: OK' : 'RESULT: FAIL');
if (!ok) process.exitCode = 1;
