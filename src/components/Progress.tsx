export function ProgressBar({
  value,
  className = '',
  color,
  height = 6,
}: {
  value: number;
  className?: string;
  color?: string;
  height?: number;
}) {
  return (
    <div className={`progress-bar ${className}`} style={{ height }}>
      <span
        className="progress-bar__fill"
        style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: color }}
      />
    </div>
  );
}
