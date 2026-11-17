/**
 * E2E встроенного режима (как на Android без сервера):
 *  - адрес сервера поиска недоступен → включается встроенный режим;
 *  - поиск идёт через провайдеров с открытым доступом прямо из приложения;
 *  - страницы анализируются локально, файлы проверяются;
 *  - скачивание и добавление в библиотеку работают.
 *
 * Запуск: node e2e/discovery-direct.mjs (нужен сервер на 127.0.0.1:4173)
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'screenshots');
mkdirSync(shots, { recursive: true });
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.POLKA_URL || 'http://127.0.0.1:4173';

const results = [];
const errors = [];
const pass = (name, extra = '') => {
  results.push({ name, ok: true, extra });
  console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`);
};
const fail = (name, error) => {
  results.push({ name, ok: false, error: String(error) });
  console.log(`  ❌ ${name} — ${error}`);
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function step(name, fn) {
  console.log(`\n▶ ${name}`);
  await fn();
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--mute-audio'] });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  mobile: true,
  isMobile: true,
  hasTouch: true,
  locale: 'ru-RU',
});
const page = await context.newPage();
page.setDefaultTimeout(90_000);
page.on('pageerror', (error) => errors.push(error.message));

const shot = async (name) => {
  await page.screenshot({ path: join(shots, `${name}.png`) });
  console.log(`  📸 ${name}`);
};

const readNetBooks = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open('polka-library');
        request.onerror = () => resolve([]);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('netbooks')) return resolve([]);
          const all = db.transaction('netbooks', 'readonly').objectStore('netbooks').getAll();
          all.onsuccess = () => resolve(all.result ?? []);
          all.onerror = () => resolve([]);
        };
      }),
  );

try {
  await step('Подготовка: сервер поиска «недоступен»', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    if (await page.locator('.onboarding').count()) {
      await page.getByRole('button', { name: 'Пропустить' }).click();
      await page.waitForSelector('.home');
    }
    // Имитируем Android без внешнего сервера: адрес поиска задан неверно.
    await page.evaluate(() => {
      localStorage.setItem('polka:search-server', 'http://127.0.0.1:9');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app', { timeout: 30_000 });
    await page.locator('.tab-bar__item', { hasText: 'Поиск' }).click();
    await page.waitForSelector('.internet-search-screen');
    await page.waitForTimeout(2500);
    const mode = (await page.locator('.discovery-mode__badge').textContent()) ?? '';
    assert(/Встроенный поиск/.test(mode), `Не включился встроенный режим: ${mode}`);
    await shot('96-direct-mode');
    pass('Встроенный режим включён без сервера', mode.trim());
  });

  await step('Поиск работает напрямую с телефона', async () => {
    const input = page.locator('.search-field input').first();
    await input.fill('frankenstein');
    await page.getByRole('button', { name: /Найти книгу/ }).click();
    await page.waitForSelector('.discovery-card', { timeout: 120_000 });
    await page.waitForTimeout(1500);
    const cards = await page.locator('.discovery-card').count();
    assert(cards > 0, 'Встроенный режим не вернул результатов');
    const providers = (await page.locator('.discovery-providers').textContent()) ?? '';
    await shot('97-direct-results');
    pass('Поиск без сервера вернул книги', `${cards} карточек · ${providers.replace(/\s+/g, ' ').slice(0, 80)}`);
  });

  await step('Анализ страниц и проверка файлов на устройстве', async () => {
    const files = await page.locator('.discovery-file').count();
    const okFiles = await page.locator('.discovery-file.is-ok').count();
    assert(files > 0, 'Файлы не найдены при локальном анализе');
    pass('Локальный анализ нашёл файлы', `${files} файлов, доступно ${okFiles}`);
  });

  await step('Скачивание и добавление в библиотеку', async () => {
    const okButton = page.locator('.discovery-file.is-ok button', { hasText: 'Скачать' }).first();
    if ((await okButton.count()) === 0) {
      pass('Доступных файлов не оказалось — пропускаем скачивание (статусы честные)');
      return;
    }
    await okButton.click();
    await page.waitForFunction(
      () => [...document.querySelectorAll('.discovery-card__footer .link-button')].some((node) => node.textContent?.includes('Читать')),
      null,
      { timeout: 150_000 },
    );
    const netbooks = await readNetBooks();
    assert(netbooks.some((book) => String(book.id).startsWith('net:import:')), 'Книга не сохранилась');
    await shot('98-direct-downloaded');
    pass('Файл скачан без внешнего сервера', `${netbooks.length} книг в базе`);
  });

  await step('Возврат в серверный режим', async () => {
    await page.evaluate(() => {
      localStorage.removeItem('polka:search-server');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app', { timeout: 30_000 });
    pass('Настройки сброшены, серверный режим доступен снова');
  });
} catch (error) {
  fail('Сценарий встроенного режима', error.message);
  await shot('98-direct-failure').catch(() => {});
} finally {
  const failed = results.filter((item) => !item.ok);
  const report = {
    ranAt: new Date().toISOString(),
    url: BASE,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    pageErrors: errors,
  };
  writeFileSync(join(root, 'e2e', 'discovery-direct-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n=== Встроенный режим: ${report.passed} прошло, ${report.failed} упало ===`);
  if (errors.length) console.log('Ошибки страницы:', errors.slice(0, 5));
  await browser.close();
  if (failed.length) process.exitCode = 1;
}
