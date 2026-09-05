import { useState } from 'react';
import { Plus, RefreshCw, ShieldAlert, Trash2, Unlock } from 'lucide-react';
import { SeverityBadge, StatTile } from '../cluster/charts';
import type { NamespaceOverview } from '../../types/reports';
import './namespaces.css';

type Props = {
  data: NamespaceOverview | null;
  loading: boolean;
  error: string;
  current: string;
  /** Whether this identity may create and delete namespaces. */
  canManage: boolean;
  onRefresh: () => void;
  /** Switching namespace here changes it for every other screen. */
  onSelect: (name: string) => void;
  onCreate: (name: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  /** Clears the finalizers of a namespace stuck Terminating; resolves to what was removed. */
  onForceFinalize: (name: string) => Promise<string>;
  notify: (text: string, detail: string | undefined, tone: 'good' | 'bad') => void;
};

export function NamespacesPage({
  data, loading, error, current, canManage, onRefresh, onSelect, onCreate, onDelete, onForceFinalize, notify,
}: Props) {
  const [filter, setFilter] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState('');

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy('create');
    try {
      await onCreate(name);
      setNewName('');
      notify('Namespace created', name, 'good');
    } catch (cause) {
      notify('The namespace was not created', String(cause), 'bad');
    } finally {
      setBusy('');
    }
  };

  const remove = async (name: string) => {
    // Deleting a namespace deletes everything inside it; typing the name is
    // the same bar the app sets for destructive production actions.
    const typed = window.prompt(
      `Deleting ${name} deletes every workload, config and claim inside it.

Type the namespace name to confirm:`,
    );
    if (typed === null) return;
    if (typed.trim() !== name) {
      notify('Confirmation did not match', 'The namespace name was not typed exactly, so nothing was deleted.', 'bad');
      return;
    }
    setBusy(name);
    try {
      await onDelete(name);
      notify('Deletion requested', `${name} is now Terminating; its resources are being torn down.`, 'good');
    } catch (cause) {
      notify('The namespace was not deleted', String(cause), 'bad');
    } finally {
      setBusy('');
    }
  };

  const release = async (name: string) => {
    setBusy(name);
    try {
      notify('Finalizers cleared', await onForceFinalize(name), 'good');
    } catch (cause) {
      notify('The namespace is still held', String(cause), 'bad');
    } finally {
      setBusy('');
    }
  };

  if (error && !data) {
    return (
      <div className="viz-callout viz-callout-critical">
        <ShieldAlert size={18} aria-hidden />
        <div>
          <strong>Namespaces could not be read.</strong>
          <p>{error}</p>
          <button type="button" className="viz-toggle" onClick={onRefresh}>Try again</button>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="viz-empty viz-empty-page">{loading ? 'Reading namespaces…' : 'Select Refresh to load.'}</div>;
  }

  const needle = filter.trim().toLowerCase();
  const items = needle ? data.items.filter((entry) => entry.name.toLowerCase().includes(needle)) : data.items;
  const terminating = data.items.filter((entry) => entry.phase !== 'Active');
  const stuck = terminating.filter((entry) => entry.finalizers.length > 0);
  const withQuota = data.items.filter((entry) => entry.has_quota).length;
  const totalPods = data.items.reduce((sum, entry) => sum + entry.pods, 0);

  return (
    <div className={`ns-page ${loading ? 'is-refreshing' : ''}`}>
      {data.degraded_collectors.length > 0 && (
        <div className="viz-callout viz-callout-warning">
          <ShieldAlert size={16} aria-hidden />
          <div>
            <strong>Part of this screen is missing.</strong>
            <ul className="ns-degraded">
              {data.degraded_collectors.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>
        </div>
      )}

      <div className="ns-kpis">
        <StatTile label="Namespaces" value={String(data.items.length)} note={`${totalPods} pods in total`} />
        <StatTile
          label="Terminating"
          value={terminating.length > 0 ? String(terminating.length) : 'none'}
          note={stuck.length > 0 ? `${stuck.length} held open by a finalizer` : 'Nothing is being deleted'}
          severity={stuck.length > 0 ? 'serious' : terminating.length > 0 ? 'warning' : 'good'}
        />
        <StatTile
          label="Under quota"
          value={String(withQuota)}
          note={withQuota === data.items.length ? 'Every namespace is bounded' : `${data.items.length - withQuota} with no quota`}
        />
        <StatTile
          label="Pods not running"
          value={String(data.items.reduce((sum, entry) => sum + entry.pods_not_running, 0))}
          note="Across every namespace"
        />
      </div>

      <div className="ns-toolbar">
        <p className="ns-lead">
          Selecting a namespace here changes it for every other screen, the same as the picker in the toolbar.
        </p>
        <div className="ns-toolbar-right">
          {canManage && (
            <span className="ns-create">
              <input
                className="wl-search"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void create(); }}
                placeholder="new-namespace-name"
                aria-label="New namespace name"
              />
              <button type="button" className="viz-toggle" disabled={busy !== '' || newName.trim() === ''} onClick={() => void create()}>
                <Plus size={13} aria-hidden /> Create
              </button>
            </span>
          )}
          <input
            className="wl-search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter namespaces…"
            aria-label="Filter namespaces"
          />
          <button type="button" className="viz-toggle" onClick={onRefresh}>
            <RefreshCw size={13} aria-hidden /> Refresh
          </button>
        </div>
      </div>

      <table className="viz-table">
        <thead>
          <tr><th>Namespace</th><th>State</th><th>Pods</th><th>Quota</th><th>Labels</th><th>Age</th>{canManage && <th aria-label="Actions" />}</tr>
        </thead>
        <tbody>
          {items.map((entry) => (
            <tr
              key={entry.name}
              className={`ns-row ${entry.name === current ? 'is-current' : ''}`}
              onClick={() => onSelect(entry.name)}
            >
              <td>
                <button type="button" className="cfg-link mono">{entry.name}</button>
                {entry.name === current && <span className="cfg-tag">selected</span>}
              </td>
              <td>
                <SeverityBadge severity={entry.health} label={entry.phase} />
                {entry.phase !== 'Active' && <div className="ns-reason">{entry.reason}</div>}
              </td>
              <td>
                {entry.pods}
                {entry.pods_not_running > 0 && (
                  <span className="ns-not-running"> · {entry.pods_not_running} not running</span>
                )}
              </td>
              <td className={entry.has_quota ? '' : 'viz-dim'}>{entry.has_quota ? 'yes' : 'none'}</td>
              <td className="ns-labels">
                {entry.labels.length === 0 ? <span className="viz-dim">—</span> : entry.labels.map((label) => (
                  <span key={label} className="cfg-tag mono">{label}</span>
                ))}
              </td>
              <td>{entry.age}</td>
              {canManage && (
                <td className="ns-actions" onClick={(event) => event.stopPropagation()}>
                  {entry.phase === 'Active' ? (
                    <button
                      type="button"
                      className="viz-toggle viz-danger"
                      disabled={busy !== ''}
                      title={`Delete ${entry.name} and everything inside it`}
                      onClick={() => void remove(entry.name)}
                    >
                      <Trash2 size={13} aria-hidden /> Delete
                    </button>
                  ) : entry.finalizers.length > 0 ? (
                    <button
                      type="button"
                      className="viz-toggle viz-danger"
                      disabled={busy !== ''}
                      title={`Stuck on: ${entry.finalizers.join(', ')}. Clearing finalizers skips whatever cleanup their owner never ran.`}
                      onClick={() => void release(entry.name)}
                    >
                      <Unlock size={13} aria-hidden /> Force finalize
                    </button>
                  ) : (
                    <span className="viz-dim">terminating…</span>
                  )}
                </td>
              )}
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={canManage ? 7 : 6} className="viz-empty">No namespace matches.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
