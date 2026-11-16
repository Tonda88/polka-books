import { useEffect, useMemo, useState } from 'react';
import { getBook, BOOKS } from '../data/books';
import type { DownloadProgress } from '../types';
import { useApp } from '../lib/store';
import { usePlayer } from '../lib/player';
import { navigate, openReader } from '../lib/router';
import { similarTo } from '../lib/recommend';
import { formatMinutes, formatNumber, hashCode, humanBytes } from '../lib/format';
import { BookCover } from '../components/Cover';
import { BookCard } from '../components/BookCard';
import { Icon } from '../components/Icons';
import { ProgressBar } from '../components/Progress';
import { Sheet } from '../components/Sheet';
import { Stars } from '../components/Stars';
import { RatingWidget } from '../components/RatingWidget';
import { recordView } from '../prefs/repository';

const REVIEW_NAMES = ['Марина К.', 'Алексей Плещеев', 'Дарья Соколова', 'Никита Орлов', 'Полина Ветрова'];
const REVIEW_TEXTS = [
  'Читается на одном дыхании. Слог такой, что не хочется торопиться — каждая фраза на месте.',
  'Взяла в поездку — не оторваться. Теперь слушаю в дороге. Отдельное спасибо за общую позицию текста и аудио.',
  'Классика, которая внезапно заходит. Понравилось, что можно скачать и читать без интернета.',
  'Слушал ночью в озвучке — атмосфера передаётся полностью. Обязательно вернусь перечитать.',
  'Короткая, но остаётся с тобой надолго. Закрываю этой книгой недельную цель по страницам.',
];

const REVIEW_DAYS = [2, 4, 7, 12, 18];

export function BookScreen({ bookId }: { bookId: string }) {
  const { state, download, removeDownload, rateBook, pushToast } = useApp();
  const player = usePlayer();
  const book = getBook(bookId);

  // Просмотр карточки — сигнал интереса для рекомендаций.
  useEffect(() => {
    if (book) void recordView(book);
  }, [book?.id]);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);

  const similar = useMemo(
    () => (book ? similarTo(state, book.id, 6).filter((item) => item.book.id !== book.id) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [book?.id, state.progress, state.ratings, state.profile.interests],
  );

  const reviews = useMemo(() => {
    if (!book) return [];
    const seed = hashCode(book.id);
    return [0, 1, 2].map((offset) => ({
      name: REVIEW_NAMES[(seed + offset * 3) % REVIEW_NAMES.length],
      text: REVIEW_TEXTS[(seed + offset * 2) % REVIEW_TEXTS.length],
      stars: offset === 2 ? 4 : 5,
      days: REVIEW_DAYS[(seed + offset) % REVIEW_DAYS.length],
      likes: 4 + ((seed + offset * 7) % 40),
    }));
  }, [book]);

  if (!book) {
    return (
      <div className="screen">
        <header className="simple-head">
          <button type="button" className="icon-button" onClick={() => navigate('/catalog')} aria-label="Назад">
            <Icon name="left" size={22} />
          </button>
          <span />
        </header>
        <div className="empty">
          <div className="empty__icon">
            <Icon name="book" size={26} />
          </div>
          <h2 className="empty__title">Книга не найдена</h2>
          <button type="button" className="btn btn--ghost" onClick={() => navigate('/catalog')}>
            В каталог
          </button>
        </div>
      </div>
    );
  }

  const entry = state.progress[book.id];
  const rating = state.ratings[book.id];
  const downloadMeta = state.downloads[book.id];
  const isDownloaded = Boolean(downloadMeta);
  const finished = Boolean(entry?.finishedAt);
  const inProgress = Boolean(entry && !finished);
  const resumeLocator = entry && !finished ? { chapter: entry.chapter, paragraph: entry.paragraph } : undefined;

  const read = () => {
    if (resumeLocator) openReader(book.id, resumeLocator.chapter, resumeLocator.paragraph);
    else openReader(book.id, 0, 0);
  };

  const listen = async () => {
    try {
      await player.open(book.id, resumeLocator, true);
      navigate(`/listen/${book.id}`);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Не удалось включить аудио', 'error');
    }
  };

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setProgress(0);
    try {
      await download(book.id, (state_: DownloadProgress) => setProgress(state_.percent));
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Не удалось скачать книгу', 'error');
    } finally {
      setDownloading(false);
    }
  };

  const handleRemove = async () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      window.setTimeout(() => setConfirmRemove(false), 3200);
      return;
    }
    await removeDownload(book.id);
    setConfirmRemove(false);
  };

  const toggleLike = () => {
    rateBook(book.id, rating?.stars ?? 5, !rating?.liked);
  };

  const estimatedKb = Math.max(8, Math.round(book.bytes / 1024));
  const chapterPreview = book.chapters.length > 12 ? book.chapters.slice(0, 12) : book.chapters;

  return (
    <div className="screen book-screen">
      <div
        className="book-hero"
        style={{
          background: `radial-gradient(120% 90% at 50% -10%, ${book.cover.accent}44 0%, transparent 60%), linear-gradient(165deg, ${book.cover.bg[0]}, ${book.cover.bg[1]})`,
        }}
      >
        <div className="book-hero__bar">
          <button type="button" className="icon-button icon-button--glass" onClick={() => navigate('/')} aria-label="Назад">
            <Icon name="left" size={22} />
          </button>
          <button
            type="button"
            className={`icon-button icon-button--glass ${isDownloaded ? 'is-downloaded' : ''}`}
            onClick={() => (isDownloaded ? navigate('/library') : void handleDownload())}
            aria-label={isDownloaded ? 'Скачано' : 'Скачать'}
          >
            <Icon name={isDownloaded ? 'check' : 'download'} size={20} />
          </button>
        </div>
        <div className="book-hero__content">
          <div className="book-hero__cover">
            <BookCover book={book} size="xl" progress={inProgress ? entry?.percent : undefined} />
          </div>
          <div className="book-hero__text">
            <div className="book-hero__genres">{book.genres.slice(0, 2).join(' · ')}</div>
            <h1 className="book-hero__title">{book.title}</h1>
            <p className="book-hero__author">{book.author}</p>
            <div className="book-hero__rating">
              <Stars value={book.rating} size={14} />
              <strong>{book.rating.toFixed(1)}</strong>
              <span>· {formatNumber(book.reviews)} оценок</span>
            </div>
            <div className="book-hero__facts">
              {book.year} · {book.pages} стр. · {formatMinutes(book.minutes)} аудио
            </div>
            <div className="book-hero__source">
              {book.source?.name ?? 'Викитека'} · полный текст
            </div>
          </div>
        </div>
      </div>

      <div className="book-body">
        {inProgress && (
          <button type="button" className="resume-note" onClick={read}>
            <span className="resume-note__icon">
              <Icon name="book" size={17} />
            </span>
            <span>
              Вы остановились на {Math.round(entry?.percent ?? 0)}% — продолжите чтение или слушайте с этого же места
            </span>
          </button>
        )}

        <div className="book-actions">
          <button type="button" className="btn btn--primary btn--wide" onClick={read}>
            <Icon name="book" size={19} />
            {finished ? 'Читать заново' : inProgress ? 'Продолжить читать' : 'Читать'}
          </button>
          <button type="button" className="btn btn--ghost btn--wide" onClick={() => void listen()}>
            <Icon name="headphones" size={19} />
            {inProgress ? 'Слушать с этого места' : 'Слушать'}
          </button>
        </div>

        <div className={`download-card ${isDownloaded ? 'is-done' : ''}`}>
          <div className="download-card__main">
            <span className="download-card__icon">
              <Icon name={isDownloaded ? 'check' : 'download'} size={20} />
            </span>
            <div className="download-card__text">
              <strong>{isDownloaded ? 'Скачано — хранится в базе приложения' : 'Скачать книгу в приложение'}</strong>
              <span>
                {isDownloaded
                  ? `${humanBytes(downloadMeta?.bytes ?? 0)} · доступно офлайн, без интернета`
                  : `Полный текст · ${estimatedKb} КБ · сохранится в базе приложения (IndexedDB)`}
              </span>
            </div>
            {isDownloaded ? (
              <button type="button" className={`mini-button ${confirmRemove ? 'is-danger' : ''}`} onClick={() => void handleRemove()}>
                {confirmRemove ? 'Удалить?' : 'Удалить'}
              </button>
            ) : (
              <button type="button" className="mini-button" onClick={() => void handleDownload()} disabled={downloading}>
                {downloading ? `${Math.round(progress)}%` : 'Скачать'}
              </button>
            )}
          </div>
          {downloading && (
            <div className="download-card__progress">
              <ProgressBar value={progress} />
              <span>Загружаем полный текст и сохраняем в базу приложения…</span>
            </div>
          )}
        </div>

        <p className="book-description">{book.description}</p>

        <div className="chips-row chips-row--wrap">
          {book.genres.map((genre) => (
            <span key={genre} className="chip chip--static">
              {genre}
            </span>
          ))}
          {book.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="chip chip--static chip--soft">
              {tag}
            </span>
          ))}
        </div>

        <section className="book-section">
          <RatingWidget
            book={book}
            externalRating={book.rating}
            externalRatingsCount={book.reviews}
          />
          <div className="rating-row">
            <button
              type="button"
              className={`like-button ${rating?.liked ? 'is-liked' : ''}`}
              onClick={toggleLike}
              aria-label={rating?.liked ? 'Убрать из избранного' : 'В избранное'}
            >
              <Icon name="heart" size={20} filled={Boolean(rating?.liked)} />
              <span>{rating?.liked ? 'В избранном' : 'В избранное'}</span>
            </button>
          </div>
          <p className="book-section__hint">
            Оценки и реакции влияют на рекомендации: похожие книги поднимаются выше, а то, что не понравилось, — реже.
          </p>
        </section>

        <section className="book-section">
          <div className="book-section__head">
            <h2>Содержание</h2>
            <span className="muted">{book.chapters.length} глав</span>
          </div>
          <div className="chapter-list">
            {chapterPreview.map((title, index) => (
              <button
                key={`${title}-${index}`}
                type="button"
                className="chapter-row"
                onClick={() => openReader(book.id, index, 0)}
              >
                <span className="chapter-row__num">{String(index + 1).padStart(2, '0')}</span>
                <span className="chapter-row__title">{title}</span>
                {entry && entry.chapter === index && !finished && <span className="chapter-row__now">сейчас</span>}
                <Icon name="right" size={16} className="muted" />
              </button>
            ))}
          </div>
          {book.chapters.length > chapterPreview.length && (
            <button type="button" className="add-goal" onClick={() => setChaptersOpen(true)}>
              <Icon name="list" size={17} />
              Все {book.chapters.length} глав
            </button>
          )}
        </section>

        {similar.length > 0 && (
          <section className="book-section">
            <div className="book-section__head">
              <h2>Похожие книги</h2>
              <button type="button" className="link-button" onClick={() => navigate('/catalog')}>
                Все
              </button>
            </div>
            <div className="h-scroll h-scroll--edge">
              {similar.map((item) => (
                <BookCard key={item.book.id} book={item.book} reason={item.reasons[0]} />
              ))}
            </div>
          </section>
        )}

        <section className="book-section">
          <div className="book-section__head">
            <h2>Отзывы</h2>
            <span className="muted">{formatNumber(book.reviews)}</span>
          </div>
          <div className="review-list">
            {reviews.map((review, index) => (
              <article className="review" key={`${review.name}-${index}`}>
                <div className="review__head">
                  <span className="review__avatar">{review.name.slice(0, 1)}</span>
                  <div>
                    <div className="review__name">{review.name}</div>
                    <div className="review__meta">
                      <Stars value={review.stars} size={11} /> · {review.days} дн. назад
                    </div>
                  </div>
                </div>
                <p className="review__text">{review.text}</p>
                <div className="review__likes">Полезно · {review.likes}</div>
              </article>
            ))}
          </div>
        </section>

        <section className="book-section">
          <h2>О книге</h2>
          <dl className="meta-grid">
            <div>
              <dt>Автор</dt>
              <dd>{book.author}</dd>
            </div>
            <div>
              <dt>Год</dt>
              <dd>{book.year}</dd>
            </div>
            <div>
              <dt>Страниц</dt>
              <dd>{book.pages}</dd>
            </div>
            <div>
              <dt>Аудио</dt>
              <dd>{formatMinutes(book.minutes)}</dd>
            </div>
            <div>
              <dt>Диктор</dt>
              <dd>{book.narrator}</dd>
            </div>
            <div>
              <dt>Язык</dt>
              <dd>Русский</dd>
            </div>
            <div>
              <dt>Объём</dt>
              <dd>{formatNumber(book.words)} слов · {book.chapters.length} гл.</dd>
            </div>
            <div>
              <dt>Источник</dt>
              <dd>
                {book.source ? (
                  <a href={book.source.url} target="_blank" rel="noreferrer">
                    {book.source.name}
                  </a>
                ) : (
                  'Викитека'
                )}
              </dd>
            </div>
          </dl>
          <p className="book-note">
            Полный текст книги получен из {book.source?.name ?? 'Викитеки'} ({book.source?.site ?? 'ru.wikisource.org'})
            {book.source?.edition ? `, издание: ${book.source.edition}` : ''}. Текст находится в общественном достоянии.
            Кнопка «Скачать» загружает книгу и сохраняет её в базе приложения (IndexedDB) — после этого текст доступен без
            интернета. Аудиоверсия озвучивается синтезом речи на устройстве.
          </p>
        </section>

        <div className="book-other">
          <span>Ещё из библиотеки</span>
          <div className="h-scroll h-scroll--edge h-scroll--compact">
            {BOOKS.filter((item) => item.id !== book.id)
              .sort((a, b) => b.rating - a.rating)
              .slice(0, 5)
              .map((item) => (
                <BookCard key={item.id} book={item} />
              ))}
          </div>
        </div>
      </div>

      <Sheet
        open={chaptersOpen}
        onClose={() => setChaptersOpen(false)}
        title="Содержание"
        subtitle={`${book.title} · ${book.chapters.length} глав`}
      >
        <div className="chapter-list">
          {book.chapters.map((title, index) => (
            <button
              key={`${title}-${index}`}
              type="button"
              className="chapter-row"
              onClick={() => {
                setChaptersOpen(false);
                openReader(book.id, index, 0);
              }}
            >
              <span className="chapter-row__num">{String(index + 1).padStart(2, '0')}</span>
              <span className="chapter-row__title">{title}</span>
              {entry && entry.chapter === index && !finished && <span className="chapter-row__now">сейчас</span>}
              <Icon name="right" size={16} className="muted" />
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}
