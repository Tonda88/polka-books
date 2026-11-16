import { useState } from 'react';
import type { CatalogBook } from '../catalog/types';

interface NetworkCoverProps {
  book: Pick<CatalogBook, 'title' | 'authors' | 'coverUrl'>;
  size?: 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const SIZES: Record<string, number> = { xxs: 30, xs: 44, sm: 62, md: 116, lg: 98, xl: 132 };

/** Обложка книги из сети: картинка источника или аккуратная заглушка с инициалами. */
export function NetworkCover({ book, size = 'md', className = '' }: NetworkCoverProps) {
  const [failed, setFailed] = useState(false);
  const width = SIZES[size] ?? 116;
  const showImage = Boolean(book.coverUrl) && !failed;

  return (
    <div
      className={`net-cover net-cover--${size} ${className}`}
      style={{ width }}
      aria-hidden="true"
      data-cover-for={book.title}
    >
      {showImage ? (
        <img
          src={book.coverUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="net-cover__fallback">
          <span className="net-cover__letter">{(book.title || '?').trim().charAt(0).toUpperCase()}</span>
          <span className="net-cover__title">{book.title}</span>
          <span className="net-cover__author">{book.authors[0] ?? ''}</span>
        </div>
      )}
    </div>
  );
}
