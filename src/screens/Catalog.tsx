import { useMemo, useState } from 'react';
import { BOOKS, GENRES, searchBooks } from '../data/books';
import { BookRow } from '../components/BookRow';
import { Icon } from '../components/Icons';
import { formatMinutes } from '../lib/format';

type SortMode = 'popular' | 'rating' | 'short';

const SORTS: Array<{ id: SortMode; label: string }> = [
  { id: 'popular', label: 'Популярное' },
  { id: 'rating', label: 'Высокий рейтинг' },
  { id: 'short', label: 'Короткие' },
];

export function CatalogScreen() {
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>('popular');

  const books = useMemo(() => {
    let result = query.trim() ? searchBooks(query) : [...BOOKS];
    if (genre) result = result.filter((book) => book.genres.includes(genre));
    result.sort((a, b) => {
      if (sort === 'rating') return b.rating - a.rating;
      if (sort === 'short') return a.pages - b.pages;
      return b.reviews - a.reviews;
    });
    return result;
  }, [query, genre, sort]);

  const totalMinutes = useMemo(() => BOOKS.reduce((sum, book) => sum + book.minutes, 0), []);

  return (
    <div className="screen catalog">
      <header className="page-head">
        <h1 className="page-title">Каталог</h1>
        <p className="page-sub">
          {BOOKS.length} книг · {Math.round(totalMinutes / 60)} ч аудио · всё можно скачать
        </p>
      </header>

      <div className="search">
        <Icon name="search" size={19} className="search__icon" />
        <input
          type="search"
          className="search__input"
          placeholder="Название, автор или жанр"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Поиск по каталогу"
        />
        {query && (
          <button type="button" className="search__clear" onClick={() => setQuery('')} aria-label="Очистить">
            <Icon name="x" size={16} />
          </button>
        )}
      </div>

      <div className="chips-row" role="list">
        <button
          type="button"
          className={`chip ${genre === null ? 'is-active' : ''}`}
          onClick={() => setGenre(null)}
        >
          Все
        </button>
        {GENRES.map((item) => (
          <button
            key={item}
            type="button"
            className={`chip ${genre === item ? 'is-active' : ''}`}
            onClick={() => setGenre(genre === item ? null : item)}
          >
            {item}
          </button>
        ))}
      </div>

      <div className="catalog-toolbar">
        <div className="segmented segmented--small">
          {SORTS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`segmented__item ${sort === item.id ? 'is-active' : ''}`}
              onClick={() => setSort(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="catalog-count">{books.length}</span>
      </div>

      {books.length > 0 ? (
        <div className="list">
          {books.map((book) => (
            <BookRow key={book.id} book={book} />
          ))}
        </div>
      ) : (
        <div className="empty">
          <div className="empty__icon">
            <Icon name="search" size={26} />
          </div>
          <h2 className="empty__title">Ничего не нашлось</h2>
          <p className="empty__text">Попробуйте другое название, автора или жанр.</p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setQuery('');
              setGenre(null);
            }}
          >
            Сбросить фильтры
          </button>
        </div>
      )}

      <div className="catalog-foot">
        <Icon name="download" size={16} />
        <span>
          Скачайте книгу кнопкой на её странице — текст и аудио останутся на устройстве. Средняя аудиокнига:{' '}
          {formatMinutes(240)}.
        </span>
      </div>
    </div>
  );
}
