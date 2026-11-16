import { useMemo, useState } from 'react';
import type { CatalogBook } from '../catalog/types';
import type { BookMeta } from '../types';
import { useBookRating } from '../prefs/usePreferences';
import { REACTIONS, reactionLabel, type Reaction } from '../prefs/types';
import { formatNumber } from '../lib/format';
import { Icon } from './Icons';
import { Stars } from './Stars';

interface RatingWidgetProps {
  book: CatalogBook | BookMeta;
  /** Общий рейтинг источника — показываем отдельно от пользовательского. */
  externalRating?: number;
  externalRatingsCount?: number;
  compact?: boolean;
}

/**
 * Оценка книги: 5 звёзд + быстрые реакции. Пользовательская оценка
 * никогда не смешивается с рейтингом источника — они подписаны раздельно.
 */
export function RatingWidget({ book, externalRating, externalRatingsCount, compact = false }: RatingWidgetProps) {
  const { rating, setRating, setReaction, reset, loading } = useBookRating(book);
  const [busy, setBusy] = useState(false);

  const stars = rating?.stars ?? 0;
  const reaction = rating?.reaction;

  const handleStars = async (value: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await setRating(value);
    } finally {
      setBusy(false);
    }
  };

  const handleReaction = async (value: Reaction) => {
    if (busy) return;
    setBusy(true);
    try {
      await setReaction(value);
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await reset();
    } finally {
      setBusy(false);
    }
  };

  const external = useMemo(() => {
    if (!externalRating) return null;
    return `${externalRating.toFixed(1)}${externalRatingsCount ? ` · ${formatNumber(externalRatingsCount)} оценок` : ''}`;
  }, [externalRating, externalRatingsCount]);

  return (
    <section className={`rating-widget ${compact ? 'rating-widget--compact' : ''}`} aria-label="Ваша оценка книги">
      <div className="rating-widget__head">
        <span className="rating-widget__title">Ваша оценка</span>
        {external && <span className="rating-widget__external">Источник: {external}</span>}
      </div>

      <div className="rating-widget__stars">
        <Stars value={stars} onChange={(value) => void handleStars(value)} size={compact ? 22 : 28} label="Ваша оценка от 1 до 5" />
        <span className={`rating-widget__value ${stars === 0 ? 'is-empty' : ''}`}>
          {loading ? '…' : stars > 0 ? `${stars} из 5` : 'не оценено'}
        </span>
        {stars > 0 && (
          <button type="button" className="link-button rating-widget__reset" onClick={() => void handleReset()} disabled={busy}>
            Сбросить
          </button>
        )}
      </div>

      <div className="rating-widget__reactions" role="group" aria-label="Быстрая реакция">
        {REACTIONS.map((item) => {
          const active = reaction === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`reaction ${active ? 'is-active' : ''}`}
              aria-pressed={active}
              onClick={() => void handleReaction(item.id)}
              disabled={busy}
              title={reactionLabel(item.id)}
            >
              <span className="reaction__emoji" aria-hidden="true">
                {item.emoji}
              </span>
              <span className="reaction__label">{item.label}</span>
            </button>
          );
        })}
      </div>

      {rating && rating.history.length > 1 && (
        <p className="rating-widget__hint">
          <Icon name="check" size={13} /> Оценка менялась {rating.history.length} раз(а) — история сохраняется
        </p>
      )}
      {rating && (rating.reaction === 'dislike' || rating.reaction === 'hate') && (
        <p className="rating-widget__hint rating-widget__hint--warn">
          Учли отрицательный опыт: похожие книги будут реже попадаться в рекомендациях.
        </p>
      )}
    </section>
  );
}
