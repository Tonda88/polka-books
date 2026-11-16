import type { BookMeta } from '../types';
import { coverStyle } from './Icons';

interface CoverProps {
  book: BookMeta;
  size?: 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  progress?: number;
}

export function BookCover({ book, size = 'md', className = '', progress }: CoverProps) {
  return (
    <div
      className={`cover cover--${size} cover--${book.cover.pattern} ${className}`}
      style={coverStyle(book.cover.bg, book.cover.ink, book.cover.accent)}
      aria-hidden="true"
    >
      <span className="cover__grain" />
      <span className="cover__author">{book.author.split(' ').slice(-1)[0]}</span>
      <span className="cover__title">{book.title}</span>
      <span className="cover__rule" />
      <span className="cover__brand">ПОЛКА</span>
      {progress !== undefined && (
        <span className="cover__progress">
          <span style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
        </span>
      )}
    </div>
  );
}
