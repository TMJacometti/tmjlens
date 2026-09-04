import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '../lib/transport';
import { ArrowLeft, Download, GitCompare, RotateCcw, Save, X } from 'lucide-react';
import { DiffReview } from './DiffReview';
import { textToBase64 } from '../lib/encoding';
import './yaml-editor.css';

type Props = {
  context: string;
  namespace: string;
  kind: string;
  name: string;
  /** False when Kubernetes denied patch access; the editor stays read-only. */
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
  notify: (text: string, detail: string | undefined, tone: 'good' | 'bad') => void;
  confirmSave: (message: string) => boolean;
};

export function YamlEditor({ context, namespace, kind, name, canEdit, onClose, onSaved, notify, confirmSave }: Props) {
  const [loaded, setLoaded] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const dirty = loaded !== '' && draft !== loaded;

  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const body = await invoke<string>('get_resource_yaml', {
        context,
        namespace,
        resourceKind: kind,
        resourceName: name,
      });
      setLoaded(body);
      setDraft(body);
      setReviewing(false);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, namespace, kind, name]);

  // Escape closes, but never silently: an unsaved edit has to be dismissed on purpose.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (dirty && !window.confirm('Discard the unsaved changes to this document?')) return;
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dirty, onClose]);

  const save = async () => {
    if (!confirmSave(`Apply the edited ${kind} ${name} to the cluster?`)) return;
    setBusy(true);
    setError('');
    try {
      const updated = await invoke<string>('apply_resource_yaml', {
        context,
        namespace,
        resourceKind: kind,
        resourceName: name,
        yaml: draft,
      });
      // The server returns the stored object, which carries the new resourceVersion —
      // adopting it is what lets a second save in a row succeed.
      setLoaded(updated);
      setDraft(updated);
      setReviewing(false);
      notify(`${kind} ${name} updated`, 'The cluster accepted the document.', 'good');
      onSaved();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    try {
      const path = await invoke<string>('save_bytes_to_downloads', {
        fileName: `${name}-${kind.toLowerCase()}`,
        extension: 'yaml',
        base64Contents: textToBase64(draft),
      });
      notify('YAML saved', path, 'good');
    } catch (cause) {
      notify('Could not save the file', String(cause), 'bad');
    }
  };

  return createPortal(
    <div
      className="yaml-scrim"
      onClick={() => {
        if (dirty && !window.confirm('Discard the unsaved changes to this document?')) return;
        onClose();
      }}
    >
      <section className="yaml-panel" role="dialog" aria-modal="true" aria-label={`${kind} ${name}`} onClick={(event) => event.stopPropagation()}>
        <header className="yaml-head">
          <div>
            <h2 className="mono">{name}</h2>
            <p>
              {kind} · namespace {namespace}
              {dirty && <span className="yaml-dirty">unsaved changes</span>}
            </p>
          </div>
          <div className="yaml-actions">
            <button type="button" className="viz-toggle" onClick={download} disabled={!draft}>
              <Download size={14} aria-hidden /> Download
            </button>
            <button type="button" className="viz-toggle" onClick={() => void load()} disabled={busy}>
              <RotateCcw size={14} aria-hidden /> Reload
            </button>
            {canEdit ? (
              reviewing ? (
                <>
                  <button type="button" className="viz-toggle" onClick={() => setReviewing(false)} disabled={busy}>
                    <ArrowLeft size={14} aria-hidden /> Back to editing
                  </button>
                  <button type="button" className="viz-primary" onClick={() => void save()} disabled={busy}>
                    <Save size={14} aria-hidden /> {busy ? 'Applying…' : 'Apply to cluster'}
                  </button>
                </>
              ) : (
                <button type="button" className="viz-primary" onClick={() => setReviewing(true)} disabled={busy || !dirty}>
                  <GitCompare size={14} aria-hidden /> Review changes
                </button>
              )
            ) : (
              <span className="viz-dim">Kubernetes denied patch access</span>
            )}
            <button type="button" className="viz-icon" onClick={onClose} aria-label="Close editor">
              <X size={16} />
            </button>
          </div>
        </header>

        {error && <div className="yaml-error">{error}</div>}

        <p className="yaml-lead">
          {reviewing
            ? 'Only what you changed, with a few lines of context either side. Nothing has been written to the cluster yet.'
            : 'This is the stored document, including status and managedFields. Applying replaces it using the resourceVersion it was loaded with, so a change made by someone else in the meantime is reported as a conflict rather than overwritten.'}
        </p>

        {reviewing ? (
          <DiffReview before={loaded} after={draft} />
        ) : (
          <textarea
            ref={area}
            className="yaml-area"
            value={draft}
            spellCheck={false}
            readOnly={!canEdit}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={`YAML for ${kind} ${name}`}
          />
        )}
      </section>
    </div>,
    document.body,
  );
}
