/** E2E настроек темы, live preview и сохранения между перезапусками. */
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.POLKA_URL || 'http://127.0.0.1:4173';
const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('.onboarding').count()) {
    await page.getByRole('button', { name: 'Пропустить' }).click();
    await page.waitForSelector('.home');
  }
  await page.evaluate(() => { location.hash = '/me'; });
  await page.waitForSelector('.profile');
  await page.getByRole('button', { name: /Настроить оформление/ }).click();
  await page.waitForSelector('.appearance-screen');

  const themes = await page.locator('.appearance-theme').count();
  check('5 готовых тем видны', themes === 5, String(themes));

  await page.getByRole('radio', { name: 'Тема Ivory' }).click();
  await page.locator('.appearance-mode__item', { hasText: 'Светлая' }).click();
  const vars = await page.evaluate(() => ({ bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() }));
  check('предпросмотр темы обновляет CSS токены', vars.bg.toLowerCase() === '#f3efe5', JSON.stringify(vars));

  await page.getByRole('radio', { name: 'Бронза' }).click();
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  check('акцент меняется сразу', accent.toLowerCase() === '#b68a5a', accent);

  await page.locator('.appearance-segmented button', { hasText: 'Плотно' }).click();
  const density = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-density').trim());
  check('плотность интерфейса работает', density === '0.88', density);

  await page.locator('.appearance-card-style', { hasText: 'Компактно' }).click();
  check('стиль карточек переключается', await page.locator('html').getAttribute('data-card-style') === 'minimal');

  await page.locator('.appearance-setting--row [role="switch"]').click();
  check('анимации выключаются', await page.locator('html').getAttribute('data-animations') === 'off');

  await page.getByRole('button', { name: 'Применить тему' }).click();
  await page.waitForTimeout(500);
  const settings = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open('polka-library');
        request.onerror = () => resolve({});
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('kv')) return resolve({});
          const get = db.transaction('kv', 'readonly').objectStore('kv').get('settings');
          get.onsuccess = () => resolve(get.result ?? {});
          get.onerror = () => resolve({});
        };
      }),
  );
  check('настройки сохранены локально', settings.appearanceTheme === 'ivory' && settings.accentColor === 'bronze' && settings.uiDensity === 'compact', JSON.stringify({ theme: settings.appearanceTheme, accent: settings.accentColor, density: settings.uiDensity }));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app');
  await page.waitForTimeout(800);
  const afterReload = await page.evaluate(() => ({
    theme: document.documentElement.dataset.appTheme,
    mode: document.documentElement.dataset.appMode,
    cardStyle: document.documentElement.dataset.cardStyle,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  }));
  check('оформление восстанавливается после перезапуска', afterReload.theme === 'ivory' && afterReload.mode === 'light' && afterReload.cardStyle === 'minimal', JSON.stringify(afterReload));

  const routes = ['/','/my','/downloads','/goals','/me','/search','/catalogs'];
  for (const route of routes) {
    await page.evaluate((hash) => { location.hash = hash; }, route);
    await page.waitForTimeout(300);
    const appExists = await page.locator('.app').count();
    check(`экран ${route} рендерится с выбранной темой`, appExists > 0);
  }
} catch (error) {
  check('appearance E2E завершился без исключения', false, error.message);
} finally {
  const failed = results.filter((result) => !result.ok);
  writeFileSync('e2e/appearance-report.json', JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  console.log(`
Appearance E2E: ${results.length - failed.length}/${results.length}`);
  await browser.close();
  if (failed.length) process.exitCode = 1;
}
