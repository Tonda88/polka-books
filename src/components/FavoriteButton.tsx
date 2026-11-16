import { useFavorites } from '../catalog/hooks';
import { Icon } from './Icons';

interface FavoriteButtonProps {
  bookId: string;
  /** icon — круглая кнопка в шапке, wide — кнопка в блоке действий. */
  variant?: 'icon' | 'wide';
  className?: string;
}

/** Сердечко «В избранное» для сетевой книги (localStorage + событие синхронизации). */
export function FavoriteButton({ bookId, variant = 'icon', className = '' }: FavoriteButtonProps) {
  const { isFavorite, toggle } = useFavorites();
  const active = isFavorite(bookId);

  if (variant === 'wide') {
    return (
      <button
        type="button"
        className={`favorite-btn favorite-btn--wide ${active ? 'is-active' : ''} ${className}`.trim()}
        onClick={() => toggle(bookId)}
        aria-pressed={active}
        aria-label={active ? 'Убрать из избранного' : 'В избранное'}
      >
        <Icon name="heart" size={18} filled={active} />
        <span>{active ? 'В избранном' : 'В избранное'}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`favorite-btn favorite-btn--icon ${active ? 'is-active' : ''} ${className}`.trim()}
      onClick={() => toggle(bookId)}
      aria-pressed={active}
      aria-label={active ? 'Убрать из избранного' : 'В избранное'}
      title={active ? 'В избранном' : 'В избранное'}
    >
      <Icon name="heart" size={19} filled={active} />
    </button>
  );
}
