import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Pencil, X } from 'lucide-react';
import { CalendarClock, SlidersHorizontal } from 'lucide-react';
import { slotLabel, summariseResources, type ImageSlot, type ResourcesSpec } from '../../types/argo';

type Props = {
  kind: 'WorkflowTemplate' | 'CronWorkflow';
  name: string;
  namespace: string;
  slots: ImageSlot[];
  /** The cron expression, for CronWorkflows with a single schedule; null hides the section. */
  schedule: string | null;
  canEdit: boolean;
  onClose: () => void;
  /** Every save sends what the operator saw along with the new value, so a concurrent
   * edit is refused with both named instead of being overwritten. */
  onSave: (slot: ImageSlot, newImage: string) => Promise<void>;
  onSaveResources: (slot: ImageSlot, next: ResourcesSpec) => Promise<void>;
  onSaveSchedule: (expected: string, next: string) => Promise<void>;
};

/**
 * The maintenance Argo operators actually do: change the image a workflow runs,
 * without hand-editing YAML. One slot per template step, edited in place; the backend
 * verifies the current value and replaces with the resourceVersion, so nothing is
 * silently overwritten.
 */
export function ImageEditorPanel({ kind, name, namespace, slots, schedule, canEdit, onClose, onSave, onSaveResources, onSaveSchedule }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [resourcesFor, setResourcesFor] = useState<string | null>(null);
  const [resourcesDraft, setResourcesDraft] = useState<ResourcesSpec>({ cpu_request: null, cpu_limit: null, memory_request: null, memory_limit: null });
  const [scheduleDraft, setScheduleDraft] = useState<string | null>(null);
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

  const saveResources = async (slot: ImageSlot) => {
    setBusy(true);
    setError('');
    try {
      // Blank input means unset; whitespace is not a quantity.
      const clean = (value: string | null) => (value && value.trim() ? value.trim() : null);
      await onSaveResources(slot, {
        cpu_request: clean(resourcesDraft.cpu_request),
        cpu_limit: clean(resourcesDraft.cpu_limit),
        memory_request: clean(resourcesDraft.memory_request),
        memory_limit: clean(resourcesDraft.memory_limit),
      });
      setResourcesFor(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveSchedule = async () => {
    if (schedule === null || scheduleDraft === null) return;
    setBusy(true);
    setError('');
    try {
      await onSaveSchedule(schedule, scheduleDraft.trim());
      setScheduleDraft(null);
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
            <p>{kind} · namespace {namespace} · {slots.length} step{slots.length === 1 ? '' : 's'} with images</p>
          </div>
          <button type="button" className="viz-toggle" onClick={onClose} aria-label="Close">
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="argo-panel-body">
          <p className="viz-dim argo-note">
            Editing changes what the <em>next</em> run uses. Runs already in flight keep what they started with.
          </p>

          {error && <div className="pf-error">{error}</div>}

          {kind === 'CronWorkflow' && schedule !== null && (
            <div className="argo-slot argo-schedule">
              <span className="argo-slot-name"><CalendarClock size={14} aria-hidden /> Schedule</span>
              {scheduleDraft !== null ? (
                <span className="argo-slot-edit">
                  <input
                    className="mono"
                    value={scheduleDraft}
                    onChange={(event) => setScheduleDraft(event.target.value)}
                    aria-label="Cron schedule"
                    spellCheck={false}
                    autoFocus
                  />
                  <button type="button" className="viz-toggle" onClick={() => setScheduleDraft(null)} disabled={busy}>Cancel</button>
                  <button type="button" className="viz-primary" onClick={() => void saveSchedule()} disabled={busy}>
                    <Check size={13} aria-hidden /> {busy ? 'Saving…' : 'Save'}
                  </button>
                </span>
              ) : (
                <span className="argo-slot-view">
                  <span className="mono argo-slot-image">{schedule}</span>
                  <button
                    type="button"
                    className="viz-toggle"
                    disabled={!canEdit}
                    title={canEdit ? 'Change when this fires — five cron fields, or @daily and friends' : 'This identity may not patch cron workflows.'}
                    onClick={() => { setScheduleDraft(schedule); setError(''); }}
                  >
                    <Pencil size={13} aria-hidden /> Edit
                  </button>
                </span>
              )}
            </div>
          )}

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

                  {resourcesFor === key ? (
                    <div className="argo-resources-edit">
                      {([
                        ['cpu_request', 'CPU request', 'e.g. 200m'],
                        ['cpu_limit', 'CPU limit', 'e.g. 1'],
                        ['memory_request', 'Memory request', 'e.g. 256Mi'],
                        ['memory_limit', 'Memory limit', 'e.g. 1Gi'],
                      ] as const).map(([field, label, hint]) => (
                        <label key={field} className="argo-resource-field">
                          <span>{label}</span>
                          <input
                            className="mono"
                            value={resourcesDraft[field] ?? ''}
                            placeholder={`unset · ${hint}`}
                            onChange={(event) =>
                              setResourcesDraft((current) => ({ ...current, [field]: event.target.value }))
                            }
                            spellCheck={false}
                          />
                        </label>
                      ))}
                      <div className="argo-resources-actions">
                        <span className="viz-dim">Blank means unset. Memory limit is the OOMKill point.</span>
                        <button type="button" className="viz-toggle" onClick={() => setResourcesFor(null)} disabled={busy}>Cancel</button>
                        <button type="button" className="viz-primary" onClick={() => void saveResources(slot)} disabled={busy}>
                          <Check size={13} aria-hidden /> {busy ? 'Saving…' : 'Save resources'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="argo-resources-line">
                      <span className="viz-dim">{summariseResources(slot.resources)}</span>
                      <button
                        type="button"
                        className="viz-toggle"
                        disabled={!canEdit}
                        title={canEdit ? `Change the requests and limits of ${slotLabel(slot)}` : 'This identity may not patch this kind.'}
                        onClick={() => {
                          setResourcesFor(key);
                          setResourcesDraft({ ...slot.resources });
                          setError('');
                        }}
                      >
                        <SlidersHorizontal size={13} aria-hidden /> Resources
                      </button>
                    </div>
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
