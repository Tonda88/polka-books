import type { BookMeta } from '../types';
import { openBook } from '../lib/router';
import { useApp } from '../lib/store';
import { formatMinutesShort } from '../lib/format';
import { BookCover } from './Cover';
import { Icon } from './Icons';
import { Stars } from './Stars';

interface BookRowProps {
  book: BookMeta;
  reason?: string;
  showStats?: boolean;
}

export function BookRow({ book, reason, showStats = true }: BookRowProps) {
  const { state } = useApp();
  const progress = state.progress[book.id];
  const downloaded = Boolean(state.downloads[book.id]);

  return (
    <button type="button" className="book-row" onClick={() => openBook(book.id)}>
      <BookCover book={book} size="sm" progress={progress && !progress.finishedAt ? progress.percent : undefined} />
      <div className="book-row__body">
        <div className="book-row__title">{book.title}</div>
        <div className="book-row__author">{book.author}</div>
        {showStats && (
          <div className="book-row__meta">
            <Stars value={book.rating} size={11} />
            <span className="book-row__rating">{book.rating.toFixed(1)}</span>
            <span className="book-row__dot">·</span>
            <span>{book.pages} стр.</span>
            <span className="book-row__dot">·</span>
            <span>{formatMinutesShort(book.minutes)} аудио</span>
          </div>
        )}
        {reason && <div className="book-row__reason">{reason}</div>}
        {progress && (
          <div className="book-row__progress">
            {progress.finishedAt ? 'Прочитано' : `Прочитано ${Math.round(progress.percent)}%`}
          </div>
        )}
      </div>
      <div className="book-row__side">
        {downloaded && (
          <span className="offline-mark" title="Скачано — доступно офлайн">
            <Icon name="check" size={12} />
          </span>
        )}
        <Icon name="right" size={18} className="muted" />
      </div>
    </button>
  );
}
