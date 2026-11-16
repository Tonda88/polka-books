import { chromium } from 'playwright-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--mute-audio'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', deviceScaleFactor: 2 });
const page = await context.newPage();
page.setDefaultTimeout(45_000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|favicon|CORS/.test(m.text())) errors.push(m.text());
});

await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });
if (await page.locator('.onboarding').count()) {
  await page.getByRole('button', { name: 'Пропустить' }).click();
  await page.waitForSelector('.home');
}

const audit = async (route, name, waitFor) => {
  await page.evaluate((hash) => {
    location.hash = hash;
  }, route);
  await page.waitForSelector(waitFor ?? '.screen', { timeout: 45_000 });
  await page.waitForTimeout(1200);
  const info = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    screen: document.querySelector('.screen')?.className ?? '',
    buttons: document.querySelectorAll('button').length,
    text: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 180),
  }));
  await page.screenshot({ path: `screenshots/6${name}.png` });
  console.log(
    `${route.padEnd(12)} overflow=${info.scrollWidth > info.clientWidth ? 'YES ' + info.scrollWidth : 'no'} buttons=${info.buttons} :: ${info.text}`,
  );
};

await audit('/my', '0-mybooks', '.screen');
await audit('/downloads', '1-downloads', '.screen');
await audit('/search', '2-search', '.search-hero');
await audit('/goals', '3-goals', '.goals');
await audit('/me', '4-profile', '.profile');
await audit('/', '5-home', '.home');

// Аудио: найдём книгу с аудио и откроем экран
await page.evaluate(() => {
  location.hash = '/search';
});
await page.waitForSelector('.search-hero');
await page.locator('.search-field input, input[type="search"]').first().fill('sherlock holmes');
await page.waitForSelector('.catalog-list .catalog-card', { timeout: 60_000 });
await page.waitForTimeout(1500);
const cards = page.locator('.catalog-list .catalog-card');
const total = await cards.count();
for (let i = 0; i < Math.min(total, 5); i += 1) {
  await cards.nth(i).click();
  await page.waitForSelector('.details-hero');
  await page.waitForTimeout(700);
  const listen = page.getByRole('button', { name: /Слушать/i }).first();
  if ((await listen.count()) > 0) {
    await listen.click();
    await page.waitForSelector('.audio-hero, .audio-track', { timeout: 45_000 });
    await page.waitForTimeout(1500);
    const audio = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      tracks: document.querySelectorAll('.audio-track').length,
      text: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 200),
    }));
    await page.screenshot({ path: 'screenshots/67-audiobook.png' });
    console.log(`/audio       overflow=${audio.overflow ? 'YES' : 'no'} tracks=${audio.tracks} :: ${audio.text}`);
    break;
  }
  await page.goBack();
  await page.waitForSelector('.catalog-list .catalog-card');
  await page.waitForTimeout(400);
}

console.log('\nОшибки:', errors.length ? errors.slice(0, 6) : 'нет');
await browser.close();
