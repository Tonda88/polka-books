import { chromium } from 'playwright-core';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://127.0.0.1:4181/index.html', { waitUntil: 'networkidle' });
const boot = await page.evaluate(() => ({ title: document.title, hasOnboarding: Boolean(document.querySelector('.onboarding')), hasRoot: Boolean(document.getElementById('root')?.children.length) }));
console.log('boot:', JSON.stringify(boot));
if (boot.hasOnboarding) {
  await page.getByRole('button', { name: 'Пропустить' }).click();
  await page.waitForSelector('.home');
}
const idb = await page.evaluate(() => new Promise((resolve) => {
  const r = indexedDB.open('polka-check', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('t');
  r.onsuccess = () => { const db = r.result; const tx = db.transaction('t', 'readwrite'); tx.objectStore('t').put('ok', 'k'); tx.oncomplete = () => resolve('IndexedDB работает'); };
  r.onerror = () => resolve('IndexedDB ОШИБКА');
}));
console.log('idb:', idb);
await page.evaluate(() => { location.hash = '/search'; });
await page.waitForSelector('.search-hero');
await page.waitForTimeout(6000);
const search = await page.evaluate(() => ({ cards: document.querySelectorAll('.catalog-card').length, sources: document.querySelector('.source-chips')?.textContent?.replace(/\s+/g, ' ').slice(0, 120) ?? '' }));
console.log('search:', JSON.stringify(search));
const builtin = await page.evaluate(async () => {
  const r = await fetch('./library/mcyri.json');
  if (!r.ok) return 'fail ' + r.status;
  const d = await r.json();
  return 'ok, глав: ' + d.chapters.length;
});
console.log('builtin library fetch:', builtin);
await page.screenshot({ path: 'screenshots/70-apk-webview-check.png' });
console.log('errors:', errors.slice(0, 5));
await browser.close();
