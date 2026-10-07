import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './detail-popup.css';

type Props = {
  /** Accessible name of the dialog, e.g. "Deployment checkout-api". */
  label: string;
  onClose: () => void;
  children: React.ReactNode;
};

/**
 * A detail panel shown over the list it came from, instead of below it where
 * the reader has to know to scroll. Escape and a click on the scrim close it.
 * Only the topmost popup reacts to Escape: a YAML editor or log viewer opened
 * from inside stays on top and must not take its parent down with it.
 */
export function DetailPopup({ label, onClose, children }: Props) {
  const scrim = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const open = document.querySelectorAll('.yaml-scrim');
      if (open[open.length - 1] === scrim.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="yaml-scrim" ref={scrim} onClick={onClose}>
      <section
        className="detail-popup"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </section>
    </div>,
    document.body,
  );
}
