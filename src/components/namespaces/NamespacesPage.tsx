import { useState } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { SeverityBadge, StatTile } from '../cluster/charts';
import type { NamespaceOverview } from '../../types/reports';
import './namespaces.css';

type Props = {
  data: NamespaceOverview | null;
  loading: boolean;
  error: string;
  current: string;
  onRefresh: () => void;
  /** Switching namespace here changes it for every other screen. */
  onSelect: (name: string) => void;
};

export function NamespacesPage({ data, loading, error, current, onRefresh, onSelect }: Props) {
  const [filter, setFilter] = useState('');

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
          <tr><th>Namespace</th><th>State</th><th>Pods</th><th>Quota</th><th>Labels</th><th>Age</th></tr>
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
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={6} className="viz-empty">No namespace matches.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
