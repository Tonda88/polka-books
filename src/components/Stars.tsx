import { IconStar } from './Icons';

interface StarsProps {
  value: number;
  onChange?: (value: number) => void;
  size?: number;
  className?: string;
  label?: string;
}

export function Stars({ value, onChange, size = 18, className = '', label }: StarsProps) {
  if (!onChange) {
    return (
      <span className={`stars ${className}`} aria-label={label ?? `Рейтинг ${value} из 5`}>
        {[1, 2, 3, 4, 5].map((star) => (
          <IconStar key={star} size={size} filled={star <= Math.round(value)} className={star <= Math.round(value) ? 'star is-on' : 'star'} />
        ))}
      </span>
    );
  }
  return (
    <div className={`stars stars--interactive ${className}`} role="radiogroup" aria-label={label ?? 'Ваша оценка'}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          className={`star-button ${star <= Math.round(value) ? 'is-on' : ''}`}
          onClick={() => onChange(star)}
          aria-label={`${star} из 5`}
          aria-checked={star === Math.round(value)}
          role="radio"
        >
          <IconStar size={size} filled={star <= Math.round(value)} />
        </button>
      ))}
    </div>
  );
}
