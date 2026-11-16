import type { CatalogBook } from '../catalog/types';
import { useDownloadedBook } from '../catalog/hooks';
import { openCatalogBook, openReader } from '../lib/router';
import type { ShelfBook } from '../prefs/types';
import { Icon } from './Icons';
import { NetworkCover } from './NetworkCover';

/** Приводит сохранённый профиль к минимальной карточке каталога для обложки. */
function asCatalog(book: ShelfBook): CatalogBook | undefined {
  if (book.catalogBook) return book.catalogBook as CatalogBook;
  return undefined;
}

function openShelfBook(book: ShelfBook): void {
  if (book.catalogBook) {
    openCatalogBook((book.catalogBook as CatalogBook).id);
    return;
  }
  if (book.book.sourceId === 'local') {
    openReader(book.book.id);
    return;
  }
  openCatalogBook(book.book.id);
}

function ShelfCard({ item }: { item: ShelfBook }) {
  const catalog = asCatalog(item);
  const downloaded = useDownloadedBook(catalog?.id ?? item.book.id);
  const label = item.book.authors[0] ? `${item.book.title}, ${item.book.authors[0]}` : item.book.title;

  return (
    <button
      type="button"
      className="shelf-card"
      onClick={() => openShelfBook(item)}
      aria-label={`Открыть книгу «${label}»`}
    >
      <span className="shelf-card__cover">
        <NetworkCover
          book={catalog ?? { title: item.book.title, authors: item.book.authors, coverUrl: item.book.coverUrl }}
          size="md"
        />
        {downloaded && (
          <span className="shelf-card__done" aria-hidden="true">
            <Icon name="check" size={12} />
          </span>
        )}
      </span>
      <span className="shelf-card__title">{item.book.title}</span>
      <span className="shelf-card__author">{item.book.authors[0] ?? 'Автор неизвестен'}</span>
      {item.book.series && <span className="shelf-card__series">{item.book.series}</span>}
      {item.reasons[0] && <span className="shelf-card__reason">{item.reasons[0]}</span>}
    </button>
  );
}

interface ShelfRowProps {
  title: string;
  subtitle?: string;
  note?: string;
  books: ShelfBook[];
  actionLabel?: string;
  onAction?: () => void;
}

/** Горизонтальная полка рекомендаций (оформление в стиле первой версии). */
export function ShelfRow({ title, subtitle, note, books, actionLabel, onAction }: ShelfRowProps) {
  if (books.length === 0) return null;
  return (
    <section className="section shelf-section">
      <div className="section__head">
        <div>
          <h2 className="section__title">{title}</h2>
          {subtitle && <p className="section__sub">{subtitle}</p>}
        </div>
        {actionLabel && onAction && (
          <button type="button" className="link-button" onClick={onAction}>
            {actionLabel}
          </button>
        )}
      </div>
      {note && <p className="shelf-section__note">{note}</p>}
      <div className="h-scroll h-scroll--edge shelf-row">
        {books.map((item) => (
          <ShelfCard key={`${item.book.id}:${item.source}`} item={item} />
        ))}
      </div>
    </section>
  );
}

/** Сетка рекомендаций для экрана предпочтений. */
export function ShelfGrid({ books }: { books: ShelfBook[] }) {
  if (books.length === 0) return null;
  return (
    <div className="shelf-grid">
      {books.map((item) => (
        <ShelfCard key={`${item.book.id}:${item.source}`} item={item} />
      ))}
    </div>
  );
}
