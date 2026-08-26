import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Pencil, X } from 'lucide-react';
import { slotLabel, type ImageSlot } from '../../types/argo';

type Props = {
  kind: 'WorkflowTemplate' | 'CronWorkflow';
  name: string;
  namespace: string;
  slots: ImageSlot[];
  canEdit: boolean;
  onClose: () => void;
  /** Sends the image the operator saw along with the new one, so a concurrent edit is
   * refused with both values named instead of being overwritten. */
  onSave: (slot: ImageSlot, newImage: string) => Promise<void>;
};

/**
 * The maintenance Argo operators actually do: change the image a workflow runs,
 * without hand-editing YAML. One slot per template step, edited in place; the backend
 * verifies the current value and replaces with the resourceVersion, so nothing is
 * silently overwritten.
 */
export function ImageEditorPanel({ kind, name, namespace, slots, canEdit, onClose, onSave }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const keyOf = (slot: ImageSlot) => `${slot.template}/${slot.container}`;

  const save = async (slot: ImageSlot) => {
    const next = draft.trim();
    if (!next) {
      setError('An image reference cannot be empty.');
      return;
    }
    if (next === slot.image) {
      setEditing(null);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave(slot, next);
      setEditing(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="yaml-scrim" onClick={onClose}>
      <section
        className="argo-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Images of ${name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="yaml-head">
          <div>
            <h2 className="mono">{name}</h2>
            <p>{kind} · namespace {namespace} · {slots.length} image{slots.length === 1 ? '' : 's'}</p>
          </div>
          <button type="button" className="viz-toggle" onClick={onClose} aria-label="Close">
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="argo-panel-body">
          <p className="viz-dim argo-note">
            Editing changes what the <em>next</em> run uses. Runs already in flight keep the image they started
            with{kind === 'CronWorkflow' ? ', and the schedule itself is untouched' : ''}.
          </p>

          {error && <div className="pf-error">{error}</div>}

          <ul className="argo-slots">
            {slots.map((slot) => {
              const key = keyOf(slot);
              const isEditing = editing === key;
              return (
                <li key={key} className={isEditing ? 'argo-slot is-editing' : 'argo-slot'}>
                  <span className="argo-slot-name mono">{slotLabel(slot)}</span>
                  {isEditing ? (
                    <span className="argo-slot-edit">
                      <input
                        className="mono"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        aria-label={`Image for ${slotLabel(slot)}`}
                        spellCheck={false}
                        autoFocus
                      />
                      <button type="button" className="viz-toggle" onClick={() => setEditing(null)} disabled={busy}>
                        Cancel
                      </button>
                      <button type="button" className="viz-primary" onClick={() => void save(slot)} disabled={busy}>
                        <Check size={13} aria-hidden /> {busy ? 'Saving…' : 'Save'}
                      </button>
                    </span>
                  ) : (
                    <span className="argo-slot-view">
                      <span className="mono argo-slot-image" title={slot.image}>{slot.image}</span>
                      <button
                        type="button"
                        className="viz-toggle"
                        disabled={!canEdit}
                        title={canEdit ? `Change the image of ${slotLabel(slot)}` : `This identity may not patch ${kind === 'CronWorkflow' ? 'cron workflows' : 'workflow templates'}.`}
                        onClick={() => {
                          setEditing(key);
                          setDraft(slot.image);
                          setError('');
                        }}
                      >
                        <Pencil size={13} aria-hidden /> Edit
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
            {slots.length === 0 && (
              <li className="viz-empty">This definition runs no container image of its own — its steps reference other templates.</li>
            )}
          </ul>
        </div>
      </section>
    </div>,
    document.body,
  );
}
