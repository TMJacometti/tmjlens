import { useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Undo2, X } from 'lucide-react';
import { formatStamp, suggestBackupName, type BackupRow } from '../../types/velero';

type Props = {
  backup: BackupRow;
  onClose: () => void;
  onSubmit: (request: { name: string; backupName: string; includedNamespaces: string[] }) => Promise<void>;
};

/**
 * Restore writes into a live cluster. Unlike every other dialog in the app, the thing
 * being changed is not named in the title bar — it is whatever the backup contains — so
 * the dialog spells out what will happen, and what will not, before it offers a button.
 */
export function RestoreDialog({ backup, onClose, onSubmit }: Props) {
  const scope = backup.included_namespaces;
  const wholeCluster = scope.length === 1 && scope[0] === 'all namespaces';

  const [name, setName] = useState(() => suggestBackupName(`restore-${backup.name}`, new Date()));
  const [limitTo, setLimitTo] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = (entry: string) =>
    setLimitTo((current) =>
      current.includes(entry) ? current.filter((item) => item !== entry) : [...current, entry],
    );

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await onSubmit({ name: name.trim(), backupName: backup.name, includedNamespaces: limitTo });
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="yaml-scrim" onClick={onClose}>
      <section
        className="vel-dialog vel-dialog-danger"
        role="dialog"
        aria-modal="true"
        aria-label={`Restore from ${backup.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="yaml-head">
          <div>
            <h2>Restore from <span className="mono">{backup.name}</span></h2>
            <p>
              Taken {formatStamp(backup.started)} · {backup.phase}
              {backup.items_backed_up !== null ? ` · ${backup.items_backed_up} items` : ''}
            </p>
          </div>
          <button type="button" className="viz-toggle" onClick={onClose} aria-label="Close">
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="vel-dialog-body">
          <div className="viz-callout viz-callout-critical">
            <AlertTriangle size={17} aria-hidden />
            <div>
              <strong>This writes into the running cluster.</strong>
              <p>
                Velero recreates resources from the backup. By default it <em>skips</em> anything that already
                exists — it does not roll a running Deployment back to the backed-up version. To actually replace
                what is running, the existing resource has to be deleted first.
              </p>
              <p>
                Persistent volume data comes back only if the backup captured volume snapshots.
              </p>
            </div>
          </div>

          {backup.caveat && (
            <div className="viz-callout viz-callout-warning">
              <AlertTriangle size={16} aria-hidden />
              <div>
                <strong>This backup is not complete.</strong>
                <p>{backup.caveat}</p>
              </div>
            </div>
          )}

          {error && <div className="pf-error">{error}</div>}

          <label className="vel-field">
            <span>Restore name</span>
            <input className="mono" value={name} onChange={(event) => setName(event.target.value)} />
          </label>

          <fieldset className="vel-field">
            <legend>What comes back</legend>
            <p className="viz-dim vel-scope-note">
              The backup covers {wholeCluster ? 'every namespace in the cluster' : scope.join(', ')}.
            </p>
            {!wholeCluster && scope.length > 1 && (
              <>
                <p className="viz-dim">Restore only some of them, or leave every box clear for all of them:</p>
                <div className="vel-ns-grid">
                  {scope.map((entry) => (
                    <label key={entry} className="vel-check">
                      <input type="checkbox" checked={limitTo.includes(entry)} onChange={() => toggle(entry)} />
                      <span className="mono">{entry}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </fieldset>

          <label className="vel-check vel-acknowledge">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>
              I understand this creates resources in{' '}
              {wholeCluster ? 'this cluster' : (limitTo.length ? limitTo : scope).join(', ')} and that it does not
              replace what is already running.
            </span>
          </label>
        </div>

        <footer className="vel-dialog-foot">
          <button type="button" className="viz-toggle" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="viz-primary viz-danger"
            onClick={() => void submit()}
            disabled={busy || !acknowledged || !name.trim()}
          >
            <Undo2 size={14} aria-hidden /> {busy ? 'Requesting…' : 'Restore'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
