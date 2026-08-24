import { useState } from 'react';
import { Package, RefreshCw, ShieldAlert, Terminal } from 'lucide-react';
import { SeverityBadge, StatTile } from '../cluster/charts';
import { isStuck, type HelmOverview, type ReleaseDetail, type ReleaseRow } from '../../types/helm';
import { ReleaseDetailPanel } from './ReleaseDetailPanel';
import './helm.css';

type Props = {
  data: HelmOverview | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  /** Fetches one release in full. Called only when a row is opened. */
  onOpenDetail: (row: ReleaseRow) => Promise<ReleaseDetail>;
  /** Runs `helm uninstall`. The app-level destructive confirmation happens above. */
  onUninstall: (row: ReleaseRow) => Promise<void>;
  onRollback: (detail: ReleaseDetail, revision: number) => Promise<void>;
  notify: (text: string, detail: string | undefined, tone: 'good' | 'bad') => void;
};

export function HelmPage({ data, loading, error, onRefresh, onOpenDetail, onUninstall, onRollback, notify }: Props) {
  const [filter, setFilter] = useState('');
  const [detail, setDetail] = useState<ReleaseDetail | null>(null);
  const [detailRow, setDetailRow] = useState<ReleaseRow | null>(null);
  const [opening, setOpening] = useState('');

  if (error && !data) {
    return (
      <div className="viz-callout viz-callout-critical">
        <ShieldAlert size={18} aria-hidden />
        <div>
          <strong>Helm releases could not be read.</strong>
          <p>{error}</p>
          <button type="button" className="viz-toggle" onClick={onRefresh}>Try again</button>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="viz-empty viz-empty-page">{loading ? 'Reading releases…' : 'Select Refresh to load.'}</div>;
  }

  const needle = filter.trim().toLowerCase();
  const releases = needle
    ? data.releases.filter(
        (row) => row.name.toLowerCase().includes(needle) || row.namespace.toLowerCase().includes(needle),
      )
    : data.releases;

  const failed = data.releases.filter((row) => row.health === 'critical').length;
  const stuck = data.releases.filter((row) => isStuck(row.status)).length;
  const namespaces = new Set(data.releases.map((row) => row.namespace)).size;
  const cli = data.cli_version;

  const open = async (row: ReleaseRow) => {
    setOpening(row.name);
    try {
      setDetail(await onOpenDetail(row));
      setDetailRow(row);
    } catch (cause) {
      notify('The release could not be read', String(cause), 'bad');
    } finally {
      setOpening('');
    }
  };

  return (
    <div className={`helm-page ${loading ? 'is-refreshing' : ''}`}>
      <p className="wl-lead">
        Read from Helm's own release records in the cluster — the same source as <code>helm list</code>, no
        helm binary needed. Uninstall and rollback are helm's operations, so those run through your CLI.
      </p>

      <div className="helm-kpis">
        <StatTile
          label="Releases"
          value={String(data.releases.length)}
          note={`Across ${namespaces} namespace${namespaces === 1 ? '' : 's'}`}
        />
        <StatTile
          label="Failed"
          value={failed > 0 ? String(failed) : 'none'}
          note={failed > 0 ? 'Last operation failed' : 'Every release is healthy'}
          severity={failed > 0 ? 'critical' : 'good'}
        />
        <StatTile
          label="Stuck pending"
          value={stuck > 0 ? String(stuck) : 'none'}
          note={stuck > 0 ? "Helm's lock is held" : 'No lock is held'}
          severity={stuck > 0 ? 'serious' : 'good'}
        />
        <StatTile
          label="helm CLI"
          value={cli ?? 'not found'}
          note={cli ? 'Uninstall and rollback available' : 'Read-only until helm is on PATH'}
          severity={cli ? 'good' : 'warning'}
        />
      </div>

      <div className="helm-toolbar">
        <div className="helm-toolbar-right">
          <input
            className="wl-search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by release or namespace…"
            aria-label="Filter releases"
          />
          <button type="button" className="viz-toggle" onClick={onRefresh}>
            <RefreshCw size={13} aria-hidden /> Refresh
          </button>
        </div>
      </div>

      <table className="viz-table">
        <thead>
          <tr><th>Release</th><th>Namespace</th><th>State</th><th>Revision</th><th>Updated</th><th aria-label="Actions" /></tr>
        </thead>
        <tbody>
          {releases.map((row) => (
            <tr key={`${row.namespace}/${row.name}`} className="helm-row" onClick={() => void open(row)}>
              <td>
                <button type="button" className="cfg-link mono">{row.name}</button>
              </td>
              <td className="mono viz-dim">{row.namespace}</td>
              <td>
                <SeverityBadge severity={row.health} label={row.status} />
                {row.health !== 'good' && <div className="helm-reason">{row.reason}</div>}
              </td>
              <td>
                {row.revision}
                {row.revisions > 1 && <span className="viz-dim helm-history-count"> · {row.revisions} revisions</span>}
              </td>
              <td>{row.updated}</td>
              <td onClick={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  className="viz-toggle viz-danger"
                  disabled={!cli}
                  title={
                    cli
                      ? `Run helm uninstall for ${row.name}`
                      : 'The helm CLI is not on PATH, and a fake uninstall would skip the chart’s delete hooks.'
                  }
                  onClick={() => void onUninstall(row)}
                >
                  <Package size={13} aria-hidden /> Uninstall
                </button>
              </td>
            </tr>
          ))}
          {releases.length === 0 && (
            <tr>
              <td colSpan={6} className="viz-empty">
                {needle ? 'No release matches.' : 'Nothing in this cluster was installed by Helm.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {opening && <p className="viz-dim helm-opening"><Terminal size={13} aria-hidden /> Reading {opening}…</p>}

      {detail && detailRow && (
        <ReleaseDetailPanel
          detail={detail}
          canRollback={Boolean(cli)}
          onClose={() => { setDetail(null); setDetailRow(null); }}
          onRollback={async (revision) => {
            await onRollback(detail, revision);
            setDetail(null);
            setDetailRow(null);
          }}
        />
      )}
    </div>
  );
}
