import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, X, XCircle } from 'lucide-react';
import './toast.css';

export type ToastMessage = { text: string; detail?: string; tone: 'good' | 'bad' };

/**
 * Feedback for actions that complete without changing the screen — exporting logs
 * writes a file and otherwise looks like nothing happened.
 */
export function Toast({ message, onDismiss }: { message: ToastMessage | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(onDismiss, message.tone === 'bad' ? 9000 : 6000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) return null;

  const Icon = message.tone === 'good' ? CheckCircle2 : XCircle;
  return createPortal(
    <div className={`tmj-toast tmj-toast-${message.tone}`} role="status" aria-live="polite">
      <Icon size={16} aria-hidden />
      <div>
        <strong>{message.text}</strong>
        {message.detail && <span>{message.detail}</span>}
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>,
    document.body,
  );
}
