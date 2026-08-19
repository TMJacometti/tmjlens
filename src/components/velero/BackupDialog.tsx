import { useState } from 'react';
import { createPortal } from 'react-dom';
import { DatabaseBackup, X } from 'lucide-react';
import { suggestBackupName, type StorageLocation } from '../../types/velero';

type Props = {
  namespaces: string[];
  locations: StorageLocation[];
  onClose: () => void;
  onSubmit: (request: {
    name: string;
    includedNamespaces: string[];
    ttlHours: number;
    storageLocation: string | null;
    includeVolumes: boolean;
  }) => Promise<void>;
};

/** Common retentions, in hours, phrased the way an operator thinks about them. */
const RETENTIONS: Array<{ label: string; hours: number }> = [
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
  { label: '90 days', hours: 24 * 90 },
  { label: '1 year', hours: 24 * 365 },
];

export function BackupDialog({ namespaces, locations, onClose, onSubmit }: Props) {
  const [name, setName] = useState(() => suggestBackupName('manual', new Date()));
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [ttlHours, setTtlHours] = useState(24 * 30);
  const [location, setLocation] = useState('');
  const [includeVolumes, setIncludeVolumes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = (entry: string) =>
    setSelected((current) =>
      current.includes(entry) ? current.filter((item) => item !== entry) : [...current, entry],
    );

  const submit = async () => {
    const trimmed = name.trim();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(trimmed)) {
      setError('A backup name may hold only lowercase letters, digits and dashes, and must start and end with one of those.');
      return;
    }
    if (scope === 'selected' && selected.length === 0) {
      setError('Pick at least one namespace, or back up the whole cluster.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        name: trimmed,
        includedNamespaces: scope === 'all' ? [] : selected,
        ttlHours,
        storageLocation: location || null,
        includeVolumes,
      });
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
        className="vel-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Take a backup"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="yaml-head">
          <div>
            <h2>Take a backup</h2>
            <p>Velero does the work. This creates the request and returns; the backup runs in the cluster.</p>
          </div>
          <button type="button" className="viz-toggle" onClick={onClose} aria-label="Close">
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="vel-dialog-body">
          {error && <div className="pf-error">{error}</div>}

          <label className="vel-field">
            <span>Name</span>
            <input className="mono" value={name} onChange={(event) => setName(event.target.value)} />
            <small>Must be unique. Velero will not overwrite an existing backup of the same name.</small>
          </label>

          <fieldset className="vel-field">
            <legend>Scope</legend>
            <label className="vel-radio">
              <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} />
              <span>Whole cluster — every namespace Velero is allowed to read</span>
            </label>
            <label className="vel-radio">
              <input type="radio" checked={scope === 'selected'} onChange={() => setScope('selected')} />
              <span>Only the namespaces I pick</span>
            </label>

            {scope === 'selected' && (
              <div className="vel-ns-grid">
                {namespaces.map((entry) => (
                  <label key={entry} className="vel-check">
                    <input type="checkbox" checked={selected.includes(entry)} onChange={() => toggle(entry)} />
                    <span className="mono">{entry}</span>
                  </label>
                ))}
                {namespaces.length === 0 && <p className="viz-dim">No namespace list is loaded.</p>}
              </div>
            )}
          </fieldset>

          <label className="vel-field">
            <span>Keep for</span>
            <select value={ttlHours} onChange={(event) => setTtlHours(Number(event.target.value))}>
              {RETENTIONS.map((entry) => (
                <option key={entry.hours} value={entry.hours}>{entry.label}</option>
              ))}
            </select>
            <small>Velero deletes the backup and its archive once this elapses.</small>
          </label>

          {locations.length > 1 && (
            <label className="vel-field">
              <span>Storage location</span>
              <select value={location} onChange={(event) => setLocation(event.target.value)}>
                <option value="">Velero's default</option>
                {locations.map((entry) => (
                  <option key={entry.name} value={entry.name} disabled={entry.phase !== 'Available'}>
                    {entry.name} · {entry.provider}
                    {entry.phase !== 'Available' ? ` (${entry.phase})` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="vel-check vel-check-block">
            <input type="checkbox" checked={includeVolumes} onChange={(event) => setIncludeVolumes(event.target.checked)} />
            <span>
              Snapshot persistent volumes
              <small>
                Off by default. Volume snapshots need a working volume plugin in this cluster and are billed by the
                cloud provider. Without this, the backup covers Kubernetes objects but not the data inside volumes.
              </small>
            </span>
          </label>
        </div>

        <footer className="vel-dialog-foot">
          <button type="button" className="viz-toggle" onClick={onClose}>Cancel</button>
          <button type="button" className="viz-primary" onClick={() => void submit()} disabled={busy}>
            <DatabaseBackup size={14} aria-hidden /> {busy ? 'Requesting…' : 'Take backup'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
