import type { BookMeta } from '../types';
import { openBook } from '../lib/router';
import { useApp } from '../lib/store';
import { BookCover } from './Cover';

interface BookCardProps {
  book: BookMeta;
  reason?: string;
}

export function BookCard({ book, reason }: BookCardProps) {
  const { state } = useApp();
  const progress = state.progress[book.id];
  const downloaded = Boolean(state.downloads[book.id]);

  return (
    <button type="button" className="book-card" onClick={() => openBook(book.id)}>
      <div className="book-card__cover-wrap">
        <BookCover book={book} size="md" progress={progress && !progress.finishedAt ? progress.percent : undefined} />
        {downloaded && <span className="book-card__offline">офлайн</span>}
      </div>
      <div className="book-card__title">{book.title}</div>
      <div className="book-card__author">{book.author}</div>
      {reason && <span className="book-card__reason">{reason}</span>}
    </button>
  );
}
