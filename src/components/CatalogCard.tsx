import type { CSSProperties } from 'react';
import type { BookFormat, CatalogBook } from '../catalog/types';
import { useDownloadedBook } from '../catalog/hooks';
import { bookLanguageLabel, primaryCategory } from '../catalog/classify';
import { shortText } from '../lib/format';
import { openCatalogBook } from '../lib/router';
import { Icon } from './Icons';
import { NetworkCover } from './NetworkCover';

const FORMAT_LABELS: Record<BookFormat, string> = {
  epub: 'EPUB',
  pdf: 'PDF',
  txt: 'TXT',
  fb2: 'FB2',
  mobi: 'MOBI',
  azw3: 'AZW3',
  audio: 'Аудио',
  html: 'HTML',
  djvu: 'DJVU',
  unknown: 'Файл',
};

/** Стабильный оттенок обложки/бейджа для источника — вместо картинки-заглушки. */
export function sourceHue(sourceId: string): number {
  let hash = 0;
  for (let index = 0; index < sourceId.length; index += 1) {
    hash = (hash * 31 + sourceId.charCodeAt(index)) % 360;
  }
  return (hash + 18) % 360;
}

/** CSS-переменная оттенка источника для обложки, бейджа и героя карточки. */
export function sourceVariables(sourceId: string): CSSProperties {
  return { '--source-hue': String(sourceHue(sourceId)) } as unknown as CSSProperties;
}

export function formatLabel(format: BookFormat): string {
  return FORMAT_LABELS[format] ?? 'Файл';
}

/** Основной формат для бейджа: сначала свободный файл, затем аудио. */
export function primaryFormat(book: CatalogBook): string | null {
  const file = book.files.find((item) => !item.requiresAuth) ?? book.files[0];
  if (file) return formatLabel(file.format);
  if (book.audio && book.audio.tracks.length > 0) return 'Аудио';
  return null;
}

interface CatalogCardProps {
  book: CatalogBook;
  /** row — вертикальный список, tile — горизонтальная полка. */
  variant?: 'row' | 'tile';
  className?: string;
}

/**
 * Карточка книги из сети. Сама решает, как показать источник и формат,
 * и подписывается на менеджер загрузок, чтобы вовремя показать «Скачано».
 */
export function CatalogCard({ book, variant = 'row', className = '' }: CatalogCardProps) {
  const downloaded = useDownloadedBook(book.id);
  const format = primaryFormat(book);
  const author = book.authors.length > 0 ? book.authors.slice(0, 2).join(', ') : 'Автор неизвестен';
  const year = book.year ? String(book.year) : '';
  const label = `${book.title}${book.authors.length > 0 ? `, ${book.authors[0]}` : ''}`;
  const language = bookLanguageLabel(book);
  const category = primaryCategory(book)?.label;

  if (variant === 'tile') {
    return (
      <button
        type="button"
        className={`catalog-card catalog-card--tile ${className}`.trim()}
        style={sourceVariables(book.sourceId)}
        data-book-id={book.id}
        data-source={book.sourceId}
        onClick={() => openCatalogBook(book.id)}
        aria-label={`Открыть книгу «${label}»`}
      >
        <span className="catalog-card__cover">
          <NetworkCover book={book} size="md" />
          {downloaded && (
            <span className="catalog-card__done" aria-hidden="true">
              <Icon name="check" size={12} />
            </span>
          )}
        </span>
        <span className="catalog-card__title">{book.title}</span>
        <span className="catalog-card__author">{author}</span>
        <span className="catalog-card__tile-meta">
          {format && <span className="format-badge">{format}</span>}
          {language && <span className="meta-badge">{language}</span>}
        </span>
        {downloaded && <span className="downloaded-badge">Скачано</span>}
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`catalog-card catalog-card--row ${className}`.trim()}
      style={sourceVariables(book.sourceId)}
      data-book-id={book.id}
      data-source={book.sourceId}
      onClick={() => openCatalogBook(book.id)}
      aria-label={`Открыть книгу «${label}»`}
    >
      <span className="catalog-card__cover">
        <NetworkCover book={book} size="sm" />
        {downloaded && (
          <span className="catalog-card__done" aria-hidden="true">
            <Icon name="check" size={12} />
          </span>
        )}
      </span>
      <span className="catalog-card__body">
        <span className="catalog-card__title">{book.title}</span>
        <span className="catalog-card__author">
          {author}
          {year ? ` · ${year}` : ''}
        </span>
        <span className="catalog-card__meta">
          {format && <span className="format-badge">{format}</span>}
          <span className="source-badge">{book.source.sourceName}</span>
          {language && <span className="meta-badge">{language}</span>}
          {category && <span className="meta-badge meta-badge--muted">{category}</span>}
          {downloaded && (
            <span className="downloaded-badge">
              <Icon name="check" size={11} />
              Скачано
            </span>
          )}
        </span>
        {book.description && (
          <span className="catalog-card__desc">{shortText(book.description, 110)}</span>
        )}
      </span>
      <Icon name="right" size={16} className="catalog-card__chevron" />
    </button>
  );
}
