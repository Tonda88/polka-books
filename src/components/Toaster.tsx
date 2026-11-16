import { useApp } from '../lib/store';
import { usePlayer } from '../lib/player';
import { Icon } from './Icons';

export function Toaster() {
  const { toasts, dismissToast } = useApp();
  const { snapshot } = usePlayer();
  if (toasts.length === 0) return null;
  return (
    <div
      className="toaster"
      role="status"
      aria-live="polite"
      style={{ bottom: `calc(${snapshot ? 148 : 84}px + env(safe-area-inset-bottom))` }}
    >
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`toast toast--${toast.kind}`}
          onClick={() => dismissToast(toast.id)}
        >
          <span className="toast__icon">
            <Icon name={toast.kind === 'success' ? 'check' : toast.kind === 'error' ? 'x' : 'sparkles'} size={16} />
          </span>
          <span>{toast.message}</span>
        </button>
      ))}
    </div>
  );
}
