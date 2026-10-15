import { useEffect, useRef, useState } from 'react';
import { Database, X } from 'lucide-react';
import { DetailPopup } from '../DetailPopup';
import { formatBytes } from '../../lib/format';
import type { CollectedData, PurgeMode, PurgeOutcome } from '../../types/rightsizing';

type Props = {
  load: () => Promise<CollectedData>;
  purge: (mode: PurgeMode) => Promise<PurgeOutcome>;
  /** The list behind the popup must reload: its rows just changed. */
  onPurged: () => void;
  onClose: () => void;
};

const count = (n: number) => n.toLocaleString('en-US');
const stamp = (raw: string | null) => (raw ? `${raw.slice(0, 16).replace('T', ' ')} UTC` : 'nothing yet');

/**
 * What the collector has written so far, tier by tier, and the two ways to
 * make it smaller: run retention now, or start over. Admin only — the server
 * refuses everyone else, this is only the door.
 */
export function CollectedDataPopup({ load, purge, onPurged, onClose }: Props) {
  const [data, setData] = useState<CollectedData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [outcome, setOutcome] = useState<PurgeOutcome | null>(null);

  // Load once on open; the callback identity changes with every parent render.
  const loader = useRef(load);
  loader.current = load;
  const refresh = () => {
    setError('');
    loader.current().then(setData).catch((cause) => setError(String(cause)));
  };
  useEffect(refresh, []);

  const run = async (mode: PurgeMode) => {
    setBusy(true);
    setError('');
    try {
      setOutcome(await purge(mode));
      setConfirmAll(false);
      refresh();
      onPurged();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const deleted = outcome ? outcome.deleted.reduce((sum, entry) => sum + entry.rows, 0) : 0;

  return (
    <DetailPopup label="Collected data" onClose={onClose}>
      <div className="detail">
        <div className="detail-head">
          <div>
            <h2><Database size={15} aria-hidden /> Collected data</h2>
            <span className="muted">What the collector has written to the database, and how to make it smaller</span>
          </div>
          <button className="icon-btn" title="Close" aria-label="Close collected data" onClick={onClose}><X size={17} /></button>
        </div>

        <div className="rs-collected">
          {error && <div className="viz-callout viz-callout-critical"><p>{error}</p></div>}
          {!data && !error && <div className="viz-empty">Counting…</div>}
          {data && (
            <>
              <table className="viz-table">
                <thead>
                  <tr><th>Tier</th><th>Rows</th><th>Oldest window</th><th>Newest window</th></tr>
                </thead>
                <tbody>
                  {data.tables.map((tier) => (
                    <tr key={tier.table}>
                      <td>{tier.label}<div className="muted mono">{tier.table}</div></td>
                      <td className="mono">{count(tier.rows)}</td>
                      <td className="mono">{stamp(tier.oldest)}</td>
                      <td className="mono">{stamp(tier.newest)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="rs-facts">
                <div><span>Collector nodes seen</span><strong>{count(data.collector_nodes)}</strong></div>
                <div>
                  <span>Database file</span>
                  <strong>{data.database_bytes == null ? 'not readable from this process' : formatBytes(data.database_bytes)}</strong>
                  <small className="mono">{data.database_path}{data.wal_bytes != null ? ` · WAL ${formatBytes(data.wal_bytes)}` : ''}</small>
                </div>
                <div><span>Retention</span><strong>{data.retention_raw} raw · {data.retention_rollup} rollups</strong></div>
                <div>
                  <span>Last retention run</span>
                  <strong>{data.last_purge_minutes_ago == null ? 'not yet in this process' : `${data.last_purge_minutes_ago} min ago`}</strong>
                </div>
              </div>

              {data.last_purge_error && (
                <div className="viz-callout viz-callout-critical">
                  <p>The last retention run failed and will be retried in five minutes: {data.last_purge_error}</p>
                </div>
              )}

              {outcome && (
                <div className="viz-callout viz-callout-good">
                  <p>
                    Deleted {count(deleted)} row(s)
                    {outcome.mode === 'all' ? ' — the collector starts over on its next window.' : ' past the retention cut.'}
                    {' '}{outcome.deleted.filter((e) => e.rows > 0).map((e) => `${e.table}: ${count(e.rows)}`).join(' · ')}
                  </p>
                </div>
              )}

              {!confirmAll ? (
                <div className="rs-actions">
                  <button type="button" className="viz-toggle" disabled={busy} onClick={() => void run('retention')}>
                    Run retention now
                  </button>
                  <button type="button" className="viz-toggle rs-danger" disabled={busy} onClick={() => setConfirmAll(true)}>
                    Delete all collected data
                  </button>
                </div>
              ) : (
                <div className="viz-callout viz-callout-critical">
                  <p>
                    This deletes every rollup and every collector heartbeat. Rightsizing goes empty and its
                    confidence restarts from zero; recommendations come back as data accumulates. HPAs and
                    resources already applied are not touched.
                  </p>
                  <div className="rs-actions">
                    <button type="button" className="primary rs-danger" disabled={busy} onClick={() => void run('all')}>
                      Yes, delete everything
                    </button>
                    <button type="button" className="viz-toggle" disabled={busy} onClick={() => setConfirmAll(false)}>Keep it</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </DetailPopup>
  );
}
