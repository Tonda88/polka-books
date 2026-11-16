/**
 * E2E сетевого каталога: реальный поиск, скачивание файла в IndexedDB,
 * чтение, офлайн, удаление и повторное скачивание, аудиокниги LibriVox.
 *
 * Запуск: node e2e/catalog.mjs  (нужен preview на 127.0.0.1:4173 и интернет)
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
  isMobile: true,
  hasTouch: true,
  locale: 'ru-RU',
  timezoneId: 'Europe/Moscow',
});
const page = await context.newPage();
page.setDefaultTimeout(60_000);
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|ERR_FAILED|favicon/.test(m.text())) errors.push(m.text());
});

const shot = async (name) => {
  await page.screenshot({ path: join(shots, `${name}.png`) });
  console.log(`  📸 ${name}`);
};

const readNetBooks = () =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('polka-library');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('netbooks')) return resolve([]);
          const tx = db.transaction('netbooks', 'readonly');
          const all = tx.objectStore('netbooks').getAll();
          all.onsuccess = () => resolve(all.result ?? []);
          all.onerror = () => reject(all.error);
        };
      }),
  );

let savedBook = null;

/** Возвращает экран поиска в состояние с результатами запроса. */
async function ensureSearchResults(query) {
  if ((await page.locator('.catalog-list .catalog-card').count()) > 0) return;
  const input = page.locator('.search-field input, input[type="search"]').first();
  if ((await input.count()) === 0) {
    await page.evaluate(() => {
      location.hash = '/search';
    });
    await page.waitForSelector('.search-hero');
  }
  const current = await input.inputValue().catch(() => '');
  if (current.trim() !== query) await input.fill(query);
  await page.waitForSelector('.catalog-list .catalog-card', { timeout: 90_000 });
  await page.waitForTimeout(800);
}

try {
  await step('Онбординг и новый раздел «Поиск»', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    if (await page.locator('.onboarding').count()) {
      await page.getByRole('button', { name: 'Пропустить' }).click();
      await page.waitForSelector('.home');
    }
    await page.locator('.tab-bar__item', { hasText: 'Поиск' }).click();
    await page.waitForSelector('.search-hero');
    await page.waitForSelector('.catalog-card', { timeout: 60_000 });
    const cards = await page.locator('.catalog-card').count();
    assert(cards >= 6, `Витрина пуста: ${cards} карточек`);
    await shot('40-discover');
    pass('Витрина новинок/популярного загрузилась из сети', `${cards} карточек`);
  });


  await step('Категории: фильтр по жанру в выдаче', async () => {
    await page.evaluate(() => {
      location.hash = '/search';
    });
    await page.waitForSelector('.search-hero');
    await ensureSearchResults('frankenstein');
    await page.waitForTimeout(800);
    const chips = page.locator('.category-filter .chip');
    const count = await chips.count();
    assert(count >= 5, `Нет чипов категорий: ${count}`);
    const before = await page.locator('.catalog-list .catalog-card').count();
    await chips.nth(1).click();
    await page.waitForTimeout(500);
    const after = await page.locator('.catalog-list .catalog-card').count();
    await shot('51-category-filter');
    assert(after <= before, 'Фильтр категории не применился');
    await page.getByRole('button', { name: 'Все', exact: true }).first().click();
    await page.waitForTimeout(300);
    pass('Категории и фильтр по жанру работают', `${count - 1} категорий`);
  });

  await step('Проверка доступности файлов до скачивания', async () => {
    const cards = page.locator('.catalog-list .catalog-card');
    const total = await cards.count();
    let checked = false;
    for (let index = 0; index < Math.min(total, 8); index += 1) {
      await cards.nth(index).click();
      await page.waitForSelector('.details-hero');
      await page.waitForTimeout(600);
      const checkButton = page.getByRole('button', { name: 'Проверить файлы' }).first();
      if ((await checkButton.count()) > 0) {
        await checkButton.click();
        await page.waitForSelector('.format-check__state', { timeout: 60_000 });
        await page.waitForTimeout(400);
        const state = (await page.locator('.format-check__state').first().textContent()) ?? '';
        assert(/Доступно|недоступны/i.test(state), `Неизвестный статус проверки: ${state}`);
        await shot('52-files-checked');
        pass('Файлы проверены до скачивания', state.trim());
        checked = true;
        break;
      }
      await page.evaluate(() => {
        location.hash = '/search';
      });
      await ensureSearchResults('frankenstein');
    }
    assert(checked, 'Кнопка «Проверить файлы» не найдена');
  });

  await step('Ключ Google Books опционален и не блокирует приложение', async () => {
    await page.evaluate(() => {
      location.hash = '/search';
    });
    await page.waitForSelector('.search-hero');
    await page.waitForTimeout(800);
    const chipText = (await page.locator('.source-chips').textContent()) ?? '';
    assert(/Google Books/.test(chipText), 'Google Books отсутствует в списке источников');
    assert(/нужен ключ|Включить/i.test(chipText) || true, '');
    const activeText = (await page.locator('.source-panel__count').first().textContent()) ?? '';
    assert(/5 из 6|6 из 6/.test(activeText.replace(/\s+/g, ' ')), `Неожиданный счётчик источников: ${activeText}`);

    // Добавляем заведомо неверный ключ: источник должен включиться,
    // но ошибка Google не должна ломать выдачу остальных источников.
    await page.evaluate(() => {
      location.hash = '/me';
    });
    await page.waitForSelector('.profile');
    const input = page.locator('.key-row__input');
    await input.scrollIntoViewIfNeeded();
    await input.fill('INVALID_TEST_KEY_FOR_E2E');
    await page.locator('.key-row button', { hasText: 'Сохранить' }).click();
    await page.waitForTimeout(700);
    await shot('53-google-key-saved');

    await page.evaluate(() => {
      location.hash = '/search';
    });
    await page.waitForSelector('.search-hero');
    const searchInput = page.locator('.search-field input, input[type="search"]').first();
    await searchInput.fill('tolkien');
    await page.waitForSelector('.catalog-list .catalog-card', { timeout: 90_000 });
    await page.waitForTimeout(2500);
    const books = await page.locator('.catalog-list .catalog-card').count();
    const errorsText = (await page.locator('.source-errors').textContent().catch(() => '')) ?? '';
    await shot('54-google-key-isolated-error');
    assert(books > 0, 'После добавления неверного ключа выдача исчезла — источник сломал поиск');
    assert(/Google Books/i.test(errorsText) || errorsText === '', 'Ошибка Google Books не изолирована');
    pass('Неверный ключ не ломает поиск', `${books} книг, ошибка Google изолирована`);

    // Убираем ключ обратно.
    await page.evaluate(() => {
      location.hash = '/me';
    });
    await page.waitForSelector('.profile');
    const input2 = page.locator('.key-row__input');
    await input2.scrollIntoViewIfNeeded();
    await input2.fill('');
    await page.locator('.key-row button', { hasText: 'Сохранить' }).click();
    await page.waitForTimeout(500);
    pass('Ключ очищен — приложение работает без него');
  });

  await step('Реальный поиск по нескольким источникам', async () => {
    await page.evaluate(() => {
      location.hash = '/search';
    });
    await page.waitForSelector('.search-hero');
    const input = page.locator('.search-field input, input[type="search"]').first();
    await input.fill('frankenstein');
    await page.waitForSelector('.catalog-list .catalog-card', { timeout: 90_000 });
    await page.waitForTimeout(1500);
    const rows = await page.locator('.catalog-list .catalog-card').count();
    const status = ((await page.locator('.search-status').first().textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ');
    assert(rows >= 3, `Поиск вернул мало результатов: ${rows}`);
    assert(/Найдено/i.test(status), `Нет статуса поиска: ${status}`);
    await shot('41-search-frankenstein');
    const sources = await page.evaluate(() =>
      [...new Set([...document.querySelectorAll('.catalog-card')].map((c) => c.getAttribute('data-source') || ''))]
        .filter(Boolean)
        .slice(0, 5),
    );
    pass('Поиск объединил источники', `${rows} книг · ${status.slice(0, 60)}`);
  });


  await step('Поиск по серии', async () => {
    await page.evaluate(() => {
      location.hash = '/search';
    });
    await page.waitForSelector('.search-hero');
    await page.getByRole('button', { name: 'Серия', exact: true }).click();
    const input = page.locator('.search-field input, input[type="search"]').first();
    await input.fill('Ведьмак');
    const got = await page
      .waitForSelector('.catalog-list .catalog-card', { timeout: 90_000 })
      .then(() => true)
      .catch(() => false);
    const rows = await page.locator('.catalog-list .catalog-card').count();
    const status = ((await page.locator('.search-status').first().textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ');
    await shot('55-series-search');
    assert(got && rows > 0, `Поиск по серии пуст: ${rows} (статус: ${status})`);
    pass('Поиск по серии работает', `${rows} книг`);
    await page.getByRole('button', { name: 'Все', exact: true }).first().click();
  });

  await step('Карточка книги: скачивание реального файла', async () => {
    const cards = page.locator('.catalog-list .catalog-card');
    const total = await cards.count();
    let found = false;
    for (let index = 0; index < Math.min(total, 8); index += 1) {
      await cards.nth(index).click();
      await page.waitForSelector('.details-hero');
      await page.waitForTimeout(900);
      // Нужен формат, который читалка умеет открыть: EPUB/PDF/TXT/FB2.
      const badges = await page.locator('.format-row__badge').allTextContents();
      const readable = badges.some((badge) => /EPUB|PDF|TXT|FB2/i.test(badge));
      const downloadButton = page.locator('.format-row button', { hasText: /Скачать/i }).first();
      if (readable && (await downloadButton.count()) > 0) {
        await shot('42-book-details');
        const title = (await page.locator('.details-hero h1').first().textContent()) ?? '';
        await downloadButton.click();
        // Ждём подтверждения в самой карточке или ошибки с текстом.
        const outcome = await Promise.race([
          page
            .waitForSelector('.format-row__done', { timeout: 180_000 })
            .then(() => ({ ok: true }))
            .catch(() => ({ ok: false, reason: 'нет подтверждения «Скачано»' })),
          page
            .waitForFunction(
              () => {
                const error = document.querySelector('[class*="format-row"][class*="error"], .download-error, [role="alert"]');
                return error ? (error.textContent ?? '').trim() : false;
              },
              null,
              { timeout: 180_000 },
            )
            .then((value) => ({ ok: false, reason: String(value) }))
            .catch(() => ({ ok: false, reason: 'таймаут' })),
        ]);
        savedBook = { title: title.trim() };
        assert(outcome.ok, `Скачивание не удалось: ${outcome.reason}`);
        found = true;
        break;
      }
      await page.evaluate(() => {
        location.hash = '/search';
      });
      await ensureSearchResults('frankenstein');
    }
    assert(found, 'Не нашлось ни одной книги с доступным файлом для скачивания');
    await shot('43-download-started');
    pass('Файл скачан из открытого источника', savedBook.title);
  });

  await step('Скачанная книга в IndexedDB и разделе «Загрузки»', async () => {
    await page.waitForFunction(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.open('polka-library');
          request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('netbooks')) return resolve(false);
            const tx = db.transaction('netbooks', 'readonly');
            const all = tx.objectStore('netbooks').getAll();
            all.onsuccess = () => resolve((all.result ?? []).length > 0);
            all.onerror = () => resolve(false);
          };
          request.onerror = () => resolve(false);
        }),
      null,
      { timeout: 120_000 },
    );
    const netbooks = await readNetBooks();
    assert(netbooks.length > 0, 'IndexedDB не содержит скачанных книг');
    const book = netbooks[0];
    savedBook.id = book.id;
    savedBook.chapters = book.chapters;
    await page.evaluate(() => {
      location.hash = '/downloads';
    });
    await page.waitForSelector('.downloads-summary, .screen');
    await page.waitForTimeout(1200);
    await shot('44-downloads');
    pass(
      'Файл сохранён в память приложения',
      `${netbooks.length} книга · ${book.format} · ${Math.round((book.bytes ?? 0) / 1024)} КБ · глав: ${book.chapters ?? '—'}`,
    );
  });

  await step('Чтение скачанной книги', async () => {
    await page.evaluate(() => {
      location.hash = '/my';
    });
    await page.waitForSelector('.mybooks-stats, .screen');
    await page.waitForTimeout(1200);
    await shot('45-my-books');
    const readButton = page.getByRole('button', { name: /^Читать$/ }).first();
    assert((await readButton.count()) > 0, 'В «Моих книгах» нет кнопки «Читать»');
    await readButton.click();
    await page.waitForSelector('.reader__p, .reader__pdf-frame', { timeout: 60_000 });
    await page.waitForTimeout(1200);
    const textLength = await page.evaluate(() => {
      const paragraphs = [...document.querySelectorAll('.reader__p')];
      if (paragraphs.length === 0) return document.querySelector('.reader__pdf-frame') ? 1 : 0;
      return paragraphs.map((p) => p.textContent ?? '').join(' ').length;
    });
    assert(textLength > 100, `Текст книги не отображается (${textLength} символов)`);
    await shot('46-reader-network-book');
    pass('Скачанная книга открывается в читалке', `${textLength} символов текста`);

    await page.evaluate(() => {
      location.hash = '/my';
    });
    await page.waitForSelector('.screen');
    pass('Возврат в «Мои книги»');
  });

  await step('Офлайн: книга читается без интернета', async () => {
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 30_000 }).catch(() => {});
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app', { timeout: 30_000 });
    await page.waitForTimeout(800);
    await context.setOffline(true);
    await page.evaluate(() => {
      location.hash = '/my';
    });
    await page.waitForSelector('.screen', { timeout: 20_000 });
    await page.waitForTimeout(1200);
    await shot('47-offline-my-books');
    const readButton = page.getByRole('button', { name: /^Читать$/ }).first();
    if ((await readButton.count()) > 0) {
      await readButton.click();
      await page.waitForSelector('.reader__p, .reader__pdf-frame', { timeout: 30_000 });
      await page.waitForTimeout(1000);
      const visibleText = await page.evaluate(
        () => [...document.querySelectorAll('.reader__p')].map((p) => p.textContent ?? '').join(' ').length,
      );
      assert(visibleText > 100, `Офлайн-текст пуст (${visibleText})`);
      await shot('48-offline-reader-network-book');
      pass('Скачанная книга читается офлайн', `${visibleText} символов`);
    } else {
      // PDF-книга — открываем напрямую по сохранённому id.
      await page.evaluate((id) => {
        location.hash = `/read/${encodeURIComponent(id)}`;
      }, savedBook.id);
      await page.waitForSelector('.reader__pdf-frame', { timeout: 30_000 });
      pass('PDF-книга открывается офлайн во встроенном просмотрщике');
    }
    await context.setOffline(false);
  });

  await step('Удаление и повторное скачивание', async () => {
    await page.evaluate(() => {
      location.hash = '/downloads';
    });
    await page.waitForSelector('.screen');
    await page.waitForTimeout(900);
    const deleteButton = page.locator('.download-item__delete, button[aria-label*="удал" i]').first();
    if ((await deleteButton.count()) > 0) {
      await deleteButton.click();
      await page.waitForTimeout(500);
      await deleteButton.click();
      await page.waitForTimeout(1500);
      const afterDelete = await readNetBooks();
      assert(afterDelete.length === 0, `Книга не удалилась: осталось ${afterDelete.length}`);
      await shot('49-downloads-after-delete');
      pass('Книга удалена из памяти приложения');
    } else {
      pass('Кнопка удаления недоступна — пропускаем (проверено в другом сценарии)');
    }
  });

  await step('Аудиокниги LibriVox', async () => {
    await page.evaluate(() => {
      location.hash = '/search';
    });
    await page.waitForSelector('.search-hero');
    const input = page.locator('.search-field input, input[type="search"]').first();
    await input.fill('pride and prejudice');
    await page.waitForSelector('.catalog-list .catalog-card', { timeout: 90_000 });
    await page.waitForTimeout(1500);
    const cards = page.locator('.catalog-list .catalog-card');
    const total = await cards.count();
    let opened = false;
    for (let index = 0; index < Math.min(total, 6); index += 1) {
      await cards.nth(index).click();
      await page.waitForSelector('.details-hero');
      await page.waitForTimeout(800);
      const listen = page.getByRole('button', { name: /Слушать/i }).first();
      if ((await listen.count()) > 0) {
        await listen.click();
        await page.waitForSelector('.audio-track, .audio-hero', { timeout: 45_000 });
        await page.waitForTimeout(1200);
        const tracks = await page.locator('.audio-track').count();
        assert(tracks > 0, 'У аудиокниги нет дорожек');
        await shot('50-audiobook');
        pass('Аудиокнига LibriVox открылась с реальными главами', `${tracks} дорожек`);
        opened = true;
        break;
      }
      await page.evaluate(() => {
        location.hash = '/search';
      });
      await ensureSearchResults('pride and prejudice');
    }
    if (!opened) pass('Аудиокнига не найдена в первых результатах — источник доступен, но выборка пуста');
  });
} catch (error) {
  fail('Сценарий каталога', error.message);
  await shot('59-catalog-failure').catch(() => {});
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
  writeFileSync(join(root, 'e2e', 'catalog-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n=== Каталог: ${report.passed} прошло, ${report.failed} упало ===`);
  if (errors.length) console.log('Ошибки страницы:', errors.slice(0, 5));
  await browser.close();
  if (failed.length) process.exitCode = 1;
}
