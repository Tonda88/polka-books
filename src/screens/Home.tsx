import { BOOKS, BOOK_MAP } from '../data/books';
import type { BookMeta, Locator } from '../types';
import { useApp } from '../lib/store';
import { usePlayer } from '../lib/player';
import { navigate } from '../lib/router';
import {
  becauseBook,
  continueReading,
  favoriteGenres,
  recommend,
  similarTo,
} from '../lib/recommend';
import { currentStreak, goalProgress, goalTitle, todayTotals } from '../lib/goals';
import { formatDate, formatMinutes, greeting, initials, plural, weekdayShort } from '../lib/format';
import { BookCover } from '../components/Cover';
import { BookCard } from '../components/BookCard';
import { BookRow } from '../components/BookRow';
import { Ring } from '../components/Ring';
import { Icon } from '../components/Icons';

export function HomeScreen() {
  const { state, pushToast } = useApp();
  const player = usePlayer();
  const now = Date.now();

  const continueItem = continueReading(state);
  const because = becauseBook(state);
  const recs = recommend(state, { limit: 10 });
  const similar = because ? similarTo(state, because.book.id, 8) : [];
  const tasteGenres = favoriteGenres(state);
  const streak = currentStreak(state.sessions);
  const today = todayTotals(state.sessions);
  const weekGoal = state.goals.find((goal) => goal.period === 'week');
  const weekProgress = weekGoal ? goalProgress(weekGoal, state) : null;
  const downloaded = Object.keys(state.downloads)
    .map((id) => BOOK_MAP.get(id))
    .filter((book): book is BookMeta => Boolean(book));

  const popular = [...BOOKS].sort((a, b) => b.reviews - a.reviews).slice(0, 3);
  const featured = BOOKS.find((book) => book.id === 'anna-karenina') ?? BOOKS[0];
  const similarFiltered = similar
    .filter((item) => !recs.slice(0, 6).some((other) => other.book.id === item.book.id))
    .slice(0, 6);

  const startReading = (book: BookMeta, locator?: Locator) => {
    if (locator) navigate(`/read/${book.id}/${locator.chapter}/${locator.paragraph}`);
    else navigate(`/read/${book.id}`);
  };

  const startListening = async (book: BookMeta, locator?: Locator) => {
    try {
      await player.open(book.id, locator, true);
      navigate(`/listen/${book.id}`);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Не удалось включить аудиокнигу', 'error');
    }
  };

  return (
    <div className="screen home">
      <header className="home-head">
        <div>
          <div className="home-head__brand">ПОЛКА</div>
          <h1 className="home-head__hello">
            {greeting()}
            {state.profile.name ? `, ${state.profile.name.split(' ')[0]}` : ''}
          </h1>
          <div className="home-head__date">
            {formatDate(now)}, {weekdayShort((new Date(now).getDay() + 6) % 7).toLowerCase()}
          </div>
        </div>
        <button type="button" className="avatar" onClick={() => navigate('/me')} aria-label="Профиль">
          {state.profile.name ? initials(state.profile.name) : 'П'}
        </button>
      </header>

      <div className="stat-pills">
        <span className="pill pill--flame">
          <Icon name="flame" size={16} />
          {streak} {plural(streak, 'день', 'дня', 'дней')} подряд
        </span>
        <span className="pill">
          <Icon name="clock" size={16} />
          {formatMinutes(today.minutes)} сегодня
        </span>
        {tasteGenres[0] && (
          <span className="pill pill--soft">
            <Icon name="sparkles" size={15} />
            {tasteGenres[0]}
          </span>
        )}
      </div>

      {continueItem ? (
        <section className="continue-card">
          <div className="continue-card__label">
            <span className="live-dot" />
            Продолжить
          </div>
          <div className="continue-card__row">
            <BookCover book={continueItem.book} size="lg" progress={continueItem.entry.percent} />
            <div className="continue-card__info">
              <div className="continue-card__title">{continueItem.book.title}</div>
              <div className="continue-card__author">{continueItem.book.author}</div>
              <div className="continue-card__chapter">
                {continueItem.book.chapters[continueItem.entry.chapter] ?? 'Глава'} ·{' '}
                {Math.round(continueItem.entry.percent)}%
              </div>
              <div className="continue-card__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() =>
                    startReading(continueItem.book, {
                      chapter: continueItem.entry.chapter,
                      paragraph: continueItem.entry.paragraph,
                    })
                  }
                >
                  <Icon name="book" size={17} />
                  Читать
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() =>
                    startListening(continueItem.book, {
                      chapter: continueItem.entry.chapter,
                      paragraph: continueItem.entry.paragraph,
                    })
                  }
                >
                  <Icon name="headphones" size={17} />
                  Слушать
                </button>
              </div>
            </div>
          </div>
          <p className="continue-card__hint">
            Позиция у текста и аудио общая: начните слушать с той же страницы, где остановились.
          </p>
        </section>
      ) : (
        <section className="first-book">
          <div className="first-book__row">
            <BookCover book={featured} size="lg" />
            <div className="first-book__info">
              <div className="eyebrow">Начните здесь</div>
              <div className="first-book__title">{featured.title}</div>
              <div className="first-book__author">{featured.author}</div>
              <p className="first-book__desc">{featured.description.slice(0, 130)}…</p>
              <div className="first-book__actions">
                <button type="button" className="btn btn--primary btn--sm" onClick={() => startReading(featured)}>
                  <Icon name="book" size={17} />
                  Читать
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => startListening(featured)}
                >
                  <Icon name="headphones" size={17} />
                  Слушать
                </button>
              </div>
            </div>
          </div>
          <p className="first-book__hint">
            Скачайте книгу — и она будет доступна без интернета. Рекомендации подстроятся под то, что вы прочитаете.
          </p>
        </section>
      )}

      {weekGoal && weekProgress ? (
        <button type="button" className="goal-strip" onClick={() => navigate('/goals')}>
          <Ring percent={weekProgress.percent} size={62} stroke={6}>
            <span className="ring__label">{Math.round(weekProgress.percent)}%</span>
          </Ring>
          <div className="goal-strip__body">
            <div className="goal-strip__title">{goalTitle(weekGoal)}</div>
            <div className="goal-strip__hint">
              {weekProgress.statusLabel} · осталось {weekProgress.daysLeft}{' '}
              {plural(weekProgress.daysLeft, 'день', 'дня', 'дней')}
            </div>
          </div>
          <Icon name="right" size={18} className="muted" />
        </button>
      ) : (
        <button type="button" className="goal-strip goal-strip--empty" onClick={() => navigate('/goals')}>
          <span className="goal-strip__icon">
            <Icon name="target" size={24} />
          </span>
          <div className="goal-strip__body">
            <div className="goal-strip__title">Поставьте цель на неделю, месяц или год</div>
            <div className="goal-strip__hint">Цели помогают читать регулярно — прогресс считается сам</div>
          </div>
          <Icon name="right" size={18} className="muted" />
        </button>
      )}

      <section className="section">
        <div className="section__head">
          <div>
            <h2 className="section__title">{tasteGenres.length > 0 ? 'Для вас' : 'С чего начать'}</h2>
            <p className="section__sub">
              {tasteGenres.length > 0
                ? `Подстроено под ваш вкус: ${tasteGenres.slice(0, 2).join(', ')}`
                : 'Классика, которую стоит попробовать'}
            </p>
          </div>
          <button type="button" className="link-button" onClick={() => navigate('/catalog')}>
            Все
          </button>
        </div>
        <div className="h-scroll">
          {recs.map((rec) => (
            <BookCard key={rec.book.id} book={rec.book} reason={rec.reasons[0]} />
          ))}
        </div>
      </section>

      {because && similarFiltered.length > 0 && (
        <section className="section">
          <div className="section__head">
            <div>
              <h2 className="section__title">
                Потому что вы {because.mode === 'listen' ? 'слушали' : 'читали'} «{because.book.title}»
              </h2>
              <p className="section__sub">Похожие книги по жанру и атмосфере</p>
            </div>
          </div>
          <div className="h-scroll">
            {similarFiltered.map((item) => (
              <BookCard key={item.book.id} book={item.book} reason={item.reasons[0]} />
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="section__head">
          <div>
            <h2 className="section__title">Офлайн-полка</h2>
            <p className="section__sub">
              {downloaded.length > 0
                ? `${downloaded.length} ${plural(downloaded.length, 'книга', 'книги', 'книг')} доступны без интернета`
                : 'Скачивайте книги — читайте в метро и самолёте'}
            </p>
          </div>
          {downloaded.length > 0 && (
            <button type="button" className="link-button" onClick={() => navigate('/library')}>
              Полка
            </button>
          )}
        </div>
        {downloaded.length > 0 ? (
          <div className="h-scroll">
            {downloaded.slice(0, 6).map((book) => (
              <BookCard key={book.id} book={book} reason="Скачано" />
            ))}
          </div>
        ) : (
          <button
            type="button"
            className="offline-promo"
            onClick={() => navigate(`/book/${BOOKS[0].id}`)}
          >
            <span className="offline-promo__icon">
              <Icon name="download" size={22} />
            </span>
            <span className="offline-promo__text">
              <strong>Скачать книгу</strong>
              <span>Один раз — и читайте где угодно. Аудио тоже доступно офлайн.</span>
            </span>
            <Icon name="right" size={18} className="muted" />
          </button>
        )}
      </section>

      <section className="section">
        <div className="section__head">
          <div>
            <h2 className="section__title">Популярно сейчас</h2>
            <p className="section__sub">Выбор читателей «Полки»</p>
          </div>
          <button type="button" className="link-button" onClick={() => navigate('/catalog')}>
            Каталог
          </button>
        </div>
        <div className="list">
          {popular.map((book) => (
            <BookRow key={book.id} book={book} />
          ))}
        </div>
      </section>

      <p className="home-foot">
        Полные тексты книг — общественное достояние. Источник: Викитека (ru.wikisource.org).
      </p>
    </div>
  );
}
