import type { ReactNode } from 'react';

interface RingProps {
  percent: number;
  size?: number;
  stroke?: number;
  color?: string;
  track?: string;
  children?: ReactNode;
  className?: string;
}

export function Ring({
  percent,
  size = 64,
  stroke = 6,
  color = 'var(--accent)',
  track = 'var(--surface-3)',
  children,
  className = '',
}: RingProps) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, percent));
  const dash = (clamped / 100) * circumference;
  return (
    <div className={`ring ${className}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={track}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="ring__value"
        />
      </svg>
      {children && <div className="ring__center">{children}</div>}
    </div>
  );
}
