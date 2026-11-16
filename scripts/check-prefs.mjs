#!/usr/bin/env node
/**
 * Проверка движка предпочтений и рейтинговой системы.
 *
 * Чистые функции: затухание, веса событий и оценок, построение модели,
 * негативные сигналы, ручные настройки, снимок предпочтений.
 *
 * Запуск: node scripts/check-prefs.mjs
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BUNDLE = join(ROOT, 'tmp', 'prefs-bundle');
const ENGINE = new URL(`file:///${BUNDLE.replace(/\\/g, '/')}/engine.js`).href;

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

if (process.env.SKIP_PREFS_BUILD !== '1') {
  execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'scripts/vite.prefs.config.mjs'],
    { cwd: ROOT, stdio: 'inherit' },
  );
}

const engine = await import(ENGINE);

// --- фикстуры ---------------------------------------------------------------
const now = Date.now();
const day = 86_400_000;

const book = (overrides = {}) => ({
  id: 'test:1',
  sourceId: 'openlibrary',
  sourceName: 'Open Library',
  title: 'Ведьмак. Последнее желание',
  authors: ['Анджей Сапковский'],
  genres: ['Фэнтези', 'Рассказы'],
  subgenres: ['fantasy', 'witcher'],
  categories: ['fantasy'],
  series: 'Ведьмак',
  languages: ['ru'],
  year: 1993,
  formats: ['epub'],
  firstSeenAt: now - 10 * day,
  lastSeenAt: now,
  ...overrides,
});

const event = (kind, at, extras = {}) => ({
  id: `${kind}:${at}`,
  kind,
  at,
  ...extras,
});

const rating = (bookId, stars, reaction, at = now) => ({
  bookId,
  stars,
  reaction,
  at,
  history: [{ at, stars, reaction, previousStars: null, previousReaction: null }],
});

// ===========================================================================
section('Затухание и веса');
const fresh = engine.decay(now);
const halfYear = engine.decay(now - 180 * day);
const old = engine.decay(now - 720 * day);
check('свежий сигнал ≈ 1', fresh > 0.99, fresh.toFixed(3));
check('через полгода ≈ 0.5', Math.abs(halfYear - 0.5) < 0.01, halfYear.toFixed(3));
check('два года назад < 0.1', old < 0.1, old.toFixed(4));
check('скачивание весит меньше оценки', engine.eventWeight(event('download', now)) < engine.ratingWeight(5));
check('завершение чтения — дополнительный сигнал', engine.eventWeight(event('finish', now)) > engine.eventWeight(event('read_progress', now, { meta: { percent: 50 } })));
check('оценка 5★ положительная', engine.ratingWeight(5) === 5);
check('оценка 1★ отрицательная', engine.ratingWeight(1) < 0);
check('нейтральная 3★ — ноль', engine.ratingWeight(3) === 0);

// ===========================================================================
section('Модель предпочтений');
const books = [
  book(),
  book({ id: 'test:2', title: 'Ведьмак. Меч Предназначения' }),
  book({
    id: 'test:3',
    title: 'Чужой детектив',
    authors: ['Другой Автор'],
    genres: ['Детектив'],
    subgenres: ['mystery'],
    categories: ['mystery'],
    series: undefined,
  }),
];
const events = [
  event('download', now - 5 * day, { bookId: 'test:1' }),
  event('download', now - 4 * day, { bookId: 'test:2' }),
  event('finish', now - 3 * day, { bookId: 'test:1', meta: { percent: 100 } }),
  event('read_progress', now - 2 * day, { bookId: 'test:2', meta: { percent: 60 } }),
];
const ratings = [rating('test:1', 5, 'love', now - day)];

const model = engine.buildModel(events, ratings, books, { now });
const prefs = model.prefs;

const authorKey = engine.authorKey('Анджей Сапковский');
check('автор запомнен', (prefs.authors[authorKey] ?? 0) > 0, String(Math.round(prefs.authors[authorKey] ?? 0)));
check('жанр запомнен', (prefs.genres['фэнтези'] ?? 0) > 0);
check('категория запомнена', (prefs.categories.fantasy ?? 0) > 0);
check('серия запомнена', (prefs.series['ведьмак'] ?? 0) > 0, String(Math.round(prefs.series['ведьмак'] ?? 0)));
check('язык запомнен', (prefs.languages.ru ?? 0) > 0);
check('сигналов учтено больше 3', prefs.signalCount >= 3, String(prefs.signalCount));

// ===========================================================================
section('Оценка кандидатов и негатив');
const loved = engine.scoreCandidate(prefs, book());
const dislikedAuthor = engine.scoreCandidate(
  prefs,
  book({ id: 'test:9', title: 'Другой роман Сапковского', fandoms: [] }),
);
check('любимый автор/серия поднимают оценку', loved.score > 1, loved.score.toFixed(2));
check('причины объясняют выбор', loved.reasons.length > 0, loved.reasons.join(' | '));

const negBooks = [book(), book({ id: 'test:4', title: 'Ещё фэнтези', categories: ['fantasy'] })];
const negRatings = [rating('test:1', 1, 'hate'), rating('test:4', 2, 'dislike')];
const negModel = engine.buildModel([], negRatings, negBooks, { now });
check('негатив по автору накоплен', (negModel.prefs.negativeAuthors[authorKey] ?? 0) > 0);
const afterNegative = engine.scoreCandidate(negModel.prefs, book({ id: 'test:5', title: 'Новое фэнтези' }));
const positiveSame = engine.scoreCandidate(
  engine.buildModel([], [rating('test:1', 5, 'love')], negBooks, { now }).prefs,
  book({ id: 'test:5', title: 'Новое фэнтези' }),
);
check('после негатива оценка ниже, чем после позитива', afterNegative.score < positiveSame.score, `${afterNegative.score.toFixed(2)} < ${positiveSame.score.toFixed(2)}`);
check('негатив помечен как штраф, но не запрет', afterNegative.penalized === true && afterNegative.score > -50);
check('одна плохая оценка не исключает автора', afterNegative.hidden === false);

// ===========================================================================
section('Ручные настройки и сброс');
const hidden = engine.withManualOverride(prefs, 'author', authorKey, 'hide');
check('автор скрыт вручную', engine.scoreCandidate(hidden, book()).hidden === true);
const unhidden = engine.withManualOverride(hidden, 'author', authorKey, 'unhide');
check('автор возвращён', engine.scoreCandidate(unhidden, book()).hidden === false);

const snapshot = engine.preferenceSnapshot(prefs);
check('снимок содержит авторов', snapshot.topAuthors.length > 0);
check('снимок содержит жанры', snapshot.topGenres.length > 0);
check('снимок содержит серии', snapshot.topSeries.length > 0, snapshot.topSeries.map((item) => item.label).join(', '));

// ===========================================================================
section('Рейтинговая система');
const reactionOf = (stars) => engine.reactionFromStars ? engine.reactionFromStars(stars) : null;
check('5★ → love', reactionOf(5) === 'love');
check('4★ → like', reactionOf(4) === 'like');
check('3★ → neutral', reactionOf(3) === 'neutral');
check('2★ → dislike', reactionOf(2) === 'dislike');
check('1★ → hate', reactionOf(1) === 'hate');
check('обратное преобразование', engine.starsFromReaction('love') === 5 && engine.starsFromReaction('hate') === 1);
check('негативные реакции определены', engine.isNegativeReaction('dislike') && engine.isNegativeReaction('hate') && !engine.isNegativeReaction('like'));

// Оценка в обе стороны: изменение оценки меняет модель.
const afterHate = engine.buildModel([], [rating('test:1', 1, 'hate')], books, { now });
const afterLove = engine.buildModel([], [rating('test:1', 5, 'love')], books, { now });
check(
  'изменение оценки меняет предпочтения',
  (afterLove.prefs.authors[authorKey] ?? 0) > (afterHate.prefs.authors[authorKey] ?? 0),
  `${Math.round(afterLove.prefs.authors[authorKey] ?? 0)} > ${Math.round(afterHate.prefs.authors[authorKey] ?? 0)}`,
);

// ===========================================================================
console.log(`\n${paint('bold', '══ Итог ══')}`);
console.log(`  Проверок успешно: ${passed} · с ошибками: ${failed}`);
if (failed > 0) {
  console.log(`  Провалено: ${failures.join(', ')}`);
  process.exitCode = 1;
}
