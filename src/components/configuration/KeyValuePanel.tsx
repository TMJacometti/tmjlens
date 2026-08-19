import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Eye, EyeOff, KeyRound, Pencil, ShieldAlert, Trash2, X } from 'lucide-react';
import { SECRET_MASK, formatBytes, type KeyInfo, type RevealedValue } from '../../types/configuration';

type Props = {
  kind: 'ConfigMap' | 'Secret';
  name: string;
  namespace: string;
  keys: KeyInfo[];
  immutable: boolean;
  managedBy: string | null;
  canEdit: boolean;
  onClose: () => void;
  /** Fetches one value. Called per key, only when asked for. */
  onRead: (key: string) => Promise<RevealedValue>;
  onSave: (key: string, value: string) => Promise<void>;
  onDelete: (key: string) => Promise<void>;
  notify: (text: string, detail: string | undefined, tone: 'good' | 'bad') => void;
};

/**
 * Reads and edits the keys of a ConfigMap or Secret.
 *
 * Two things shape this panel. First, a Secret's values never arrive with the list —
 * each one is fetched only when the operator asks for that key, so opening the screen
 * does not pull every credential in the namespace into the app. Second, edits are made
 * against the decoded value: base64 is Kubernetes' storage format, not something an
 * operator should have to get right by hand, and a stray newline in hand-written
 * base64 produces a value that looks correct and is not.
 */
export function KeyValuePanel({
  kind, name, namespace, keys, immutable, managedBy, canEdit, onClose, onRead, onSave, onDelete, notify,
}: Props) {
  const isSecret = kind === 'Secret';
  const [revealed, setRevealed] = useState<Record<string, RevealedValue>>({});
  const [busyKey, setBusyKey] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  // A ConfigMap holds no secrets, so its values are shown without asking.
  useEffect(() => {
    if (isSecret) return;
    let cancelled = false;
    void Promise.all(
      keys.filter((entry) => !entry.binary).map((entry) => onRead(entry.key).catch(() => null)),
    ).then((values) => {
      if (cancelled) return;
      const next: Record<string, RevealedValue> = {};
      for (const value of values) if (value) next[value.key] = value;
      setRevealed(next);
    });
    return () => {
      cancelled = true;
    };
  }, [isSecret, name, namespace]);

  const reveal = async (key: string) => {
    setBusyKey(key);
    setError('');
    try {
      const value = await onRead(key);
      setRevealed((current) => ({ ...current, [key]: value }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusyKey('');
    }
  };

  const hide = (key: string) =>
    setRevealed((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });

  const startEdit = async (key: string) => {
    const known = revealed[key];
    if (known?.value !== undefined && known?.value !== null) {
      setEditing(key);
      setDraft(known.value);
      return;
    }
    setBusyKey(key);
    try {
      const value = await onRead(key);
      setRevealed((current) => ({ ...current, [key]: value }));
      if (value.value === null) {
        setError(`${key} is not valid text, so it cannot be edited here.`);
        return;
      }
      setEditing(key);
      setDraft(value.value);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusyKey('');
    }
  };

  const save = async () => {
    if (editing === null) return;
    setBusyKey(editing);
    setError('');
    try {
      await onSave(editing, draft);
      setRevealed((current) => ({
        ...current,
        [editing]: { key: editing, value: draft, bytes: new TextEncoder().encode(draft).length, binary: false },
      }));
      notify(`${editing} saved`, `${kind} ${name} updated in the cluster.`, 'good');
      setEditing(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusyKey('');
    }
  };

  const remove = async (key: string) => {
    if (!window.confirm(`Remove the key ${key} from ${kind.toLowerCase()} ${name}?`)) return;
    setBusyKey(key);
    try {
      await onDelete(key);
      notify(`${key} removed`, `${kind} ${name} updated in the cluster.`, 'good');
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusyKey('');
    }
  };

  const locked = immutable || !canEdit;

  return createPortal(
    <div className="yaml-scrim" onClick={onClose}>
      <section
        className={`cfg-panel ${isSecret ? 'cfg-panel-secret' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={`${kind} ${name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="yaml-head">
          <div>
            <h2 className="mono">{name}</h2>
            <p>
              {kind} · namespace {namespace} · {keys.length} key{keys.length === 1 ? '' : 's'}
              {immutable && <span className="cfg-tag">immutable</span>}
              {managedBy && <span className="cfg-tag">managed by {managedBy}</span>}
            </p>
          </div>
          <button type="button" className="viz-toggle" onClick={onClose} aria-label="Close">
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="cfg-panel-body">
          {isSecret && (
            <p className="cfg-secret-note">
              <KeyRound size={13} aria-hidden />
              Values are fetched one key at a time, only when you ask. Nothing here is written to disk, and this
              screen has no export — a Secret exported to a file is a credential in the clear.
            </p>
          )}

          {managedBy && (
            <div className="viz-callout viz-callout-warning">
              <ShieldAlert size={16} aria-hidden />
              <div>
                <strong>{managedBy} owns this object.</strong>
                <p>An edit made here will be reverted the next time {managedBy} syncs. Change it at the source.</p>
              </div>
            </div>
          )}

          {immutable && (
            <div className="viz-callout viz-callout-warning">
              <ShieldAlert size={16} aria-hidden />
              <div>
                <strong>This object is immutable.</strong>
                <p>Kubernetes rejects any change to its data. It has to be replaced rather than edited.</p>
              </div>
            </div>
          )}

          {error && <div className="pf-error">{error}</div>}

          <ul className="cfg-keys">
            {keys.map((entry) => {
              const value = revealed[entry.key];
              const shown = value?.value ?? null;
              const isEditing = editing === entry.key;
              const busy = busyKey === entry.key;

              return (
                <li key={entry.key} className={isEditing ? 'cfg-key is-editing' : 'cfg-key'}>
                  <div className="cfg-key-head">
                    <span className="mono cfg-key-name">{entry.key}</span>
                    <span className="viz-dim cfg-key-size">{formatBytes(value?.bytes ?? entry.bytes)}</span>
                    <div className="cfg-key-actions">
                      {entry.binary || value?.binary ? (
                        <span className="viz-dim cfg-binary">binary — not text</span>
                      ) : isSecret && !isEditing ? (
                        <button
                          type="button"
                          className="viz-toggle"
                          disabled={busy}
                          onClick={() => (shown === null ? void reveal(entry.key) : hide(entry.key))}
                        >
                          {shown === null ? <Eye size={13} aria-hidden /> : <EyeOff size={13} aria-hidden />}
                          {busy ? 'Reading…' : shown === null ? 'Reveal' : 'Hide'}
                        </button>
                      ) : null}

                      {shown !== null && !isEditing && (
                        <button
                          type="button"
                          className="viz-toggle"
                          onClick={() => {
                            void navigator.clipboard?.writeText(shown);
                            notify('Copied to clipboard', `${entry.key} from ${name}`, 'good');
                          }}
                        >
                          <Copy size={13} aria-hidden /> Copy
                        </button>
                      )}

                      {!entry.binary && !isEditing && (
                        <button
                          type="button"
                          className="viz-toggle"
                          disabled={locked || busy}
                          title={
                            immutable
                              ? 'This object is immutable.'
                              : !canEdit
                                ? `This identity may not change ${kind === 'Secret' ? 'secrets' : 'config maps'} here.`
                                : `Edit ${entry.key}`
                          }
                          onClick={() => void startEdit(entry.key)}
                        >
                          <Pencil size={13} aria-hidden /> Edit
                        </button>
                      )}

                      {!isEditing && (
                        <button
                          type="button"
                          className="viz-toggle viz-danger"
                          disabled={locked || busy}
                          onClick={() => void remove(entry.key)}
                          title={locked ? 'This object cannot be changed.' : `Remove ${entry.key}`}
                        >
                          <Trash2 size={13} aria-hidden /> Remove
                        </button>
                      )}
                    </div>
                  </div>

                  {isEditing ? (
                    <>
                      <textarea
                        className="cfg-editor mono"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        spellCheck={false}
                        aria-label={`Value of ${entry.key}`}
                        rows={Math.min(16, Math.max(3, draft.split('\n').length + 1))}
                      />
                      <p className="cfg-encode-note">
                        {isSecret
                          ? 'Saved as you typed it. tmjLens does the base64 encoding Kubernetes stores it in.'
                          : 'Saved as you typed it.'}
                      </p>
                      <div className="cfg-edit-actions">
                        <button type="button" className="viz-toggle" onClick={() => setEditing(null)}>Cancel</button>
                        <button type="button" className="viz-primary" onClick={() => void save()} disabled={busy}>
                          {busy ? 'Saving…' : 'Save to cluster'}
                        </button>
                      </div>
                    </>
                  ) : (
                    <pre className={`cfg-value mono ${shown === null ? 'is-masked' : ''}`}>
                      {entry.binary || value?.binary
                        ? `${formatBytes(value?.bytes ?? entry.bytes)} of binary data`
                        : shown === null
                          ? SECRET_MASK
                          : shown}
                    </pre>
                  )}
                </li>
              );
            })}
            {keys.length === 0 && <li className="viz-empty">This {kind.toLowerCase()} holds no keys.</li>}
          </ul>
        </div>
      </section>
    </div>,
    document.body,
  );
}
