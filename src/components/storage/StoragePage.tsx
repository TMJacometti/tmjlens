import { useMemo, useState } from 'react';
import { HardDrive, RefreshCw, ShieldAlert } from 'lucide-react';
import { SeverityBadge, StatTile } from '../cluster/charts';
import {
  STORAGE_VIEWS, describeMounts, formatStorage, shortHandle, storageViewCount, summariseCapacity,
  type StorageOverview, type StorageView,
} from '../../types/storage';
import '../configuration/configuration.css';
import './storage.css';

type Props = {
  data: StorageOverview | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
};

export function StoragePage({ data, loading, error, onRefresh }: Props) {
  const [view, setView] = useState<StorageView>('Volume Claims');
  const [filter, setFilter] = useState('');

  const needle = filter.trim().toLowerCase();
  const matches = <T extends { name: string }>(items: T[]): T[] =>
    needle ? items.filter((item) => item.name.toLowerCase().includes(needle)) : items;

  const capacity = useMemo(() => (data ? summariseCapacity(data) : null), [data]);

  if (error && !data) {
    return (
      <div className="viz-callout viz-callout-critical">
        <ShieldAlert size={18} aria-hidden />
        <div>
          <strong>Storage could not be read.</strong>
          <p>{error}</p>
          <button type="button" className="viz-toggle" onClick={onRefresh}>Try again</button>
        </div>
      </div>
    );
  }

  if (!data || !capacity) {
    return <div className="viz-empty viz-empty-page">{loading ? 'Reading storage…' : 'Select Refresh to load.'}</div>;
  }

  const wasted = capacity.idle + capacity.stranded;
  const wastedShare = capacity.total > 0 ? (wasted / capacity.total) * 100 : 0;

  return (
    <div className={`stg-page ${loading ? 'is-refreshing' : ''}`}>
      {data.degraded_collectors.length > 0 && (
        <div className="viz-callout viz-callout-warning">
          <ShieldAlert size={16} aria-hidden />
          <div>
            <strong>Part of this screen is missing.</strong>
            <ul className="stg-degraded">
              {data.degraded_collectors.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>
        </div>
      )}

      <div className="stg-kpis">
        <StatTile
          label="Provisioned"
          value={formatStorage(capacity.total)}
          note={capacity.unmeasured > 0 ? `${capacity.unmeasured} of unknown size, excluded` : 'Across claims and released volumes'}
        />
        <StatTile
          label="Doing work"
          value={formatStorage(capacity.inUse)}
          note="Mounted by a running pod"
          severity="good"
        />
        <StatTile
          label="Bound, not mounted"
          value={formatStorage(capacity.idle)}
          note={capacity.idle > 0 ? 'Provisioned and billed' : 'Every bound claim is mounted'}
          severity={capacity.idle > 0 ? 'warning' : 'good'}
        />
        <StatTile
          label="Released, not reclaimed"
          value={formatStorage(capacity.stranded)}
          note={capacity.stranded > 0 ? 'Never reused, still billed' : 'Nothing stranded'}
          severity={capacity.stranded > 0 ? 'serious' : 'good'}
        />
      </div>

      {/* Stated as a share as well as a size: 200Gi idle means nothing without the total. */}
      {wasted > 0 && capacity.total > 0 && (
        <div className="stg-waste">
          <div className="stg-waste-bar" role="img" aria-label={`${wastedShare.toFixed(0)} percent of provisioned storage is not doing work`}>
            <span className="stg-waste-in-use" style={{ flex: capacity.inUse || 0.0001 }} />
            <span className="stg-waste-idle" style={{ flex: capacity.idle || 0.0001 }} />
            <span className="stg-waste-stranded" style={{ flex: capacity.stranded || 0.0001 }} />
          </div>
          {/* Each segment is named, so the bar is not the only thing carrying the split. */}
          <ul className="stg-legend">
            <li><span className="stg-swatch stg-waste-in-use" aria-hidden /> Doing work {formatStorage(capacity.inUse)}</li>
            <li><span className="stg-swatch stg-waste-idle" aria-hidden /> Bound, not mounted {formatStorage(capacity.idle)}</li>
            <li><span className="stg-swatch stg-waste-stranded" aria-hidden /> Released, not reclaimed {formatStorage(capacity.stranded)}</li>
          </ul>
          <p>
            <strong>{formatStorage(wasted)}</strong> of {formatStorage(capacity.total)} provisioned
            ({wastedShare.toFixed(0)}%) is not mounted by anything. The provider bills it the same.
          </p>
        </div>
      )}

      {data.findings.length > 0 && (
        <div className="cfg-findings">
          {data.findings.map((finding) => (
            <details key={finding.title} className={`cfg-finding cfg-finding-${finding.severity}`}>
              <summary>
                <SeverityBadge severity={finding.severity} />
                <strong>{finding.title}</strong>
                <span className="mono cfg-finding-targets">{finding.targets.join(' · ')}</span>
              </summary>
              <p>{finding.detail}</p>
            </details>
          ))}
        </div>
      )}

      <div className="stg-toolbar">
        <div className="wl-switch" role="tablist" aria-label="Storage resources">
          {STORAGE_VIEWS.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={view === entry}
              className={view === entry ? 'is-active' : ''}
              onClick={() => setView(entry)}
            >
              {entry} <span className="viz-count">{storageViewCount(data, entry)}</span>
            </button>
          ))}
        </div>
        <div className="stg-toolbar-right">
          <input
            className="wl-search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by name…"
            aria-label="Filter by name"
          />
          <button type="button" className="viz-toggle" onClick={onRefresh}>
            <RefreshCw size={13} aria-hidden /> Refresh
          </button>
        </div>
      </div>

      {view === 'Volume Claims' && (
        <table className="viz-table">
          <thead>
            <tr><th>Claim</th><th>State</th><th>Size</th><th>Class</th><th>Access</th><th>Mounted by</th><th>Volume</th><th>Age</th></tr>
          </thead>
          <tbody>
            {matches(data.claims).map((claim) => (
              <tr key={claim.name}>
                <td className="mono">{claim.name}</td>
                <td>
                  <SeverityBadge severity={claim.health} label={claim.phase} />
                  <div className="stg-reason">{claim.reason}</div>
                </td>
                <td>
                  <span className="mono">{claim.provisioned ?? claim.requested ?? '—'}</span>
                  {claim.over_provisioned && <div className="stg-note">{claim.over_provisioned}</div>}
                </td>
                <td className="mono viz-dim">{claim.storage_class ?? 'default'}</td>
                <td className="viz-dim stg-modes">{claim.access_modes.join(', ') || '—'}</td>
                <td className={claim.used_by_total === 0 ? 'stg-idle' : 'stg-mounts'}>
                  {describeMounts(claim.used_by, claim.used_by_total)}
                </td>
                <td className="mono viz-dim stg-volume">{claim.volume ?? '—'}</td>
                <td>{claim.age}</td>
              </tr>
            ))}
            {matches(data.claims).length === 0 && (
              <tr><td colSpan={8} className="viz-empty">No claim in this namespace.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {view === 'Volumes' && (
        <>
          <p className="stg-lead">
            <HardDrive size={13} aria-hidden />
            <span>
              Volumes are cluster-wide. The disk column is what the volume actually is in the provider, so a
              released volume can be found and checked before anyone deletes it.
            </span>
          </p>
          <table className="viz-table">
            <thead>
              <tr><th>Volume</th><th>State</th><th>Size</th><th>Reclaim</th><th>Claim</th><th>Disk</th><th>Zone</th><th>Age</th></tr>
            </thead>
            <tbody>
              {matches(data.volumes).map((volume) => (
                <tr key={volume.name}>
                  <td className="mono stg-volume">{volume.name}</td>
                  <td>
                    <SeverityBadge severity={volume.health} label={volume.phase} />
                    <div className="stg-reason">{volume.reason}</div>
                  </td>
                  <td className="mono">{volume.capacity ?? '—'}</td>
                  <td className={volume.reclaim_policy === 'Retain' ? 'stg-retain' : 'viz-dim'}>
                    {volume.reclaim_policy}
                  </td>
                  <td className="mono viz-dim stg-volume">
                    {volume.claim ?? '—'}
                    {volume.claim_exists === false && <div className="stg-idle">no longer exists</div>}
                  </td>
                  <td className="stg-disk">
                    <div className="viz-dim">{volume.source}</div>
                    <div className="mono" title={volume.handle ?? undefined}>{shortHandle(volume.handle)}</div>
                  </td>
                  <td className="viz-dim">{volume.zones.join(', ') || '—'}</td>
                  <td>{volume.age}</td>
                </tr>
              ))}
              {matches(data.volumes).length === 0 && (
                <tr><td colSpan={8} className="viz-empty">No persistent volume exists, or this identity may not read them.</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {view === 'Storage Classes' && (
        <table className="viz-table">
          <thead>
            <tr><th>Class</th><th>Notes</th><th>Provisioner</th><th>Binding</th><th>Reclaim</th><th>Expandable</th><th>Claims</th></tr>
          </thead>
          <tbody>
            {matches(data.classes).map((entry) => (
              <tr key={entry.name}>
                <td>
                  <span className="mono">{entry.name}</span>
                  {entry.is_default && <span className="cfg-tag">default</span>}
                </td>
                <td>
                  <SeverityBadge severity={entry.health} />
                  <div className="stg-reason">{entry.reason}</div>
                </td>
                <td className="mono viz-dim stg-modes">{entry.provisioner}</td>
                <td className={entry.binding_mode === 'Immediate' ? 'stg-retain' : 'viz-dim'}>{entry.binding_mode}</td>
                <td className={entry.reclaim_policy === 'Delete' ? 'stg-retain' : 'viz-dim'}>{entry.reclaim_policy}</td>
                <td>{entry.allow_expansion ? 'yes' : 'no'}</td>
                <td>{entry.claims_using}</td>
              </tr>
            ))}
            {matches(data.classes).length === 0 && (
              <tr><td colSpan={7} className="viz-empty">No storage class is defined, or this identity may not read them.</td></tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
