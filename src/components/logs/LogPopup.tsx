import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { invoke } from '../../lib/transport';
import { LogViewer } from './LogViewer';
import './logs.css';

type Props = {
  context: string;
  namespace: string;
  podName: string;
  onExport: (container?: string) => void;
  onClose: () => void;
};

/**
 * The log viewer in a modal, opened straight from a pod row. Same viewer as
 * the detail panel's Logs tab — follow, filter, export — but big, and without
 * losing the list behind it.
 */
export function LogPopup({ context, namespace, podName, onExport, onClose }: Props) {
  const [containers, setContainers] = useState<string[]>([]);
  const [selectedContainer, setSelectedContainer] = useState('');

  useEffect(() => {
    void invoke<string[]>('list_pod_containers', { context, namespace, podName })
      .then((next) => {
        setContainers(next);
        setSelectedContainer(next[0] || '');
      })
      .catch(() => setContainers([]));
  }, [context, namespace, podName]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="yaml-scrim" onClick={onClose}>
      <section
        className="log-popup"
        role="dialog"
        aria-modal="true"
        aria-label={`Logs of ${podName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="yaml-head">
          <div>
            <h2 className="mono">{podName}</h2>
            <p>Logs · namespace {namespace}</p>
          </div>
          <button type="button" className="viz-toggle" onClick={onClose} aria-label="Close">
            <X size={14} aria-hidden />
          </button>
        </header>
        <div className="log-popup-body">
          <LogViewer
            context={context}
            namespace={namespace}
            podName={podName}
            containers={containers}
            selectedContainer={selectedContainer}
            onSelectContainer={setSelectedContainer}
            onExport={() => onExport(selectedContainer || undefined)}
          />
        </div>
      </section>
    </div>,
    document.body,
  );
}
