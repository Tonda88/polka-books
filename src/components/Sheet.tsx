import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconX } from './Icons';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  full?: boolean;
}

export function Sheet({ open, onClose, title, subtitle, children, footer, full }: SheetProps) {
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className={`sheet-layer ${full ? 'sheet-layer--full' : ''}`}>
      <button type="button" className="sheet-backdrop" aria-label="Закрыть" onClick={onClose} />
      <div className={`sheet ${full ? 'sheet--full' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet__grabber" />
        {(title || subtitle) && (
          <header className="sheet__header">
            <div>
              {title && <h2 className="sheet__title">{title}</h2>}
              {subtitle && <p className="sheet__subtitle">{subtitle}</p>}
            </div>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть">
              <IconX size={20} />
            </button>
          </header>
        )}
        <div className="sheet__body">{children}</div>
        {footer && <div className="sheet__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
