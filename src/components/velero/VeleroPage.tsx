import { useMemo, useState } from 'react';
import { Archive, DatabaseBackup, HardDriveDownload, PauseCircle, RefreshCw, ShieldAlert, Undo2 } from 'lucide-react';
import { SeverityBadge, StatTile } from '../cluster/charts';
import {
  VELERO_VIEWS, backupDuration, expiresSoon, formatStamp, isExpired, isRestorable, veleroViewCount,
  type BackupRow, type VeleroStatus, type VeleroView,
} from '../../types/velero';
import { BackupDialog } from './BackupDialog';
import { RestoreDialog } from './RestoreDialog';
import './velero.css';

type Props = {
  status: VeleroStatus | null;
  loading: boolean;
  error: string;
  namespaces: string[];
  canBackup: boolean;
  canRestore: boolean;
  onRefresh: () => void;
  onCreateBackup: (request: {
    name: string;
    includedNamespaces: string[];
    ttlHours: number;
    storageLocation: string | null;
    includeVolumes: boolean;
  }) => Promise<void>;
  onCreateRestore: (request: { name: string; backupName: string; includedNamespaces: string[] }) => Promise<void>;
};

export function VeleroPage({
  status, loading, error, namespaces, canBackup, canRestore, onRefresh, onCreateBackup, onCreateRestore,
}: Props) {
  const [view, setView] = useState<VeleroView>('Backups');
  const [filter, setFilter] = useState('');
  const [backupOpen, setBackupOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupRow | null>(null);

  // Read once per render rather than per row, so every "expires soon" on screen is
  // judged against the same instant.
  const now = Date.now();
  const needle = filter.trim().toLowerCase();
  const matches = <T extends { name: string }>(items: T[]): T[] =>
    needle ? items.filter((item) => item.name.toLowerCase().includes(needle)) : items;

  const lastGood = useMemo(
    () => status?.backups.find((backup) => backup.phase === 'Completed') ?? null,
    [status],
  );

  if (error && !status) {
    return (
      <div className="viz-callout viz-callout-critical">
        <ShieldAlert size={18} aria-hidden />
        <div>
          <strong>Velero could not be read.</strong>
          <p>{error}</p>
          <button type="button" className="viz-toggle" onClick={onRefresh}>Try again</button>
        </div>
      </div>
    );
  }

  if (!status) {
    return <div className="viz-empty viz-empty-page">{loading ? 'Reading Velero…' : 'Select Refresh to load.'}</div>;
  }

  if (!status.installed) {
    return (
      <div className="vel-page">
        <div className="viz-callout viz-callout-warning">
          <Archive size={18} aria-hidden />
          <div>
            <strong>No Velero in this cluster.</strong>
            <p>{status.reason}</p>
            <p className="viz-dim">
              tmjLens reads Velero's own custom resources, so it shows what <code>velero backup get</code> would show.
              It needs no bucket credential of its own — object storage is reached by Velero, not by this app.
            </p>
            <button type="button" className="viz-toggle" onClick={onRefresh}>Check again</button>
          </div>
        </div>
      </div>
    );
  }

  const failing = status.backups.filter((backup) => backup.health === 'critical' || backup.health === 'serious').length;
  const unhealthyLocations = status.locations.filter((location) => location.phase !== 'Available');
  const pausedSchedules = status.schedules.filter((schedule) => schedule.paused);

  return (
    <div className={`vel-page ${loading ? 'is-refreshing' : ''}`}>
      <p className="wl-lead">
        Read from Velero's custom resources in namespace <code>{status.namespace}</code> — the same source
        as <code>velero backup get</code>. Backup archives live in the bucket, and Velero is what reaches it.
      </p>

      {status.degraded_collectors.length > 0 && (
        <div className="viz-callout viz-callout-warning">
          <ShieldAlert size={16} aria-hidden />
          <div>
            <strong>Part of this screen is missing.</strong>
            <ul className="vel-degraded">
              {status.degraded_collectors.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>
        </div>
      )}

      <div className="vel-kpis">
        <StatTile
          label="Last completed backup"
          value={lastGood ? lastGood.age : 'none'}
          note={lastGood ? `${lastGood.name} · ${formatStamp(lastGood.completed)}` : 'No backup has completed in this cluster.'}
          severity={lastGood ? 'good' : 'critical'}
        />
        <StatTile
          label="Backups held"
          value={String(status.backups.length)}
          note={failing > 0 ? `${failing} failed or incomplete` : 'None failed'}
          severity={failing > 0 ? 'serious' : 'good'}
        />
        <StatTile
          label="Schedules"
          value={String(status.schedules.length)}
          note={pausedSchedules.length > 0 ? `${pausedSchedules.length} paused` : status.schedules.length ? 'All running' : 'Nothing scheduled'}
          severity={status.schedules.length === 0 || pausedSchedules.length > 0 ? 'warning' : 'good'}
        />
        <StatTile
          label="Storage locations"
          value={String(status.locations.length)}
          note={unhealthyLocations.length > 0 ? `${unhealthyLocations.length} not available` : 'All available'}
          severity={unhealthyLocations.length > 0 ? 'critical' : 'good'}
        />
      </div>

      <div className="vel-toolbar">
        <div className="wl-switch" role="tablist" aria-label="Velero resources">
          {VELERO_VIEWS.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={view === entry}
              className={view === entry ? 'active' : ''}
              onClick={() => setView(entry)}
            >
              {entry} <span className="wl-count">{veleroViewCount(status, entry)}</span>
            </button>
          ))}
        </div>

        <div className="vel-toolbar-right">
          <input
            className="wl-search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={`Filter ${view.toLowerCase()}…`}
            aria-label={`Filter ${view}`}
          />
          <button type="button" className="viz-toggle" onClick={onRefresh}>
            <RefreshCw size={13} aria-hidden /> Refresh
          </button>
          <button
            type="button"
            className="viz-primary"
            onClick={() => setBackupOpen(true)}
            disabled={!canBackup}
            title={canBackup ? 'Ask Velero to take a backup now' : 'This identity may not create Velero backups.'}
          >
            <DatabaseBackup size={14} aria-hidden /> Back up now
          </button>
        </div>
      </div>

      {view === 'Backups' && (
        <table className="viz-table">
          <thead>
            <tr>
              <th>Backup</th><th>Phase</th><th>Scope</th><th>Started</th>
              <th>Took</th><th>Items</th><th>Expires</th><th>Location</th><th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {matches(status.backups).map((backup) => {
              const expired = isExpired(backup.expires, now);
              const soon = expiresSoon(backup.expires, now);
              return (
                <tr key={backup.name} className={backup.caveat ? 'vel-flagged' : ''}>
                  <td>
                    <span className="mono">{backup.name}</span>
                    {backup.caveat && <div className="vel-caveat">{backup.caveat}</div>}
                  </td>
                  <td><SeverityBadge severity={backup.health} label={backup.phase} /></td>
                  <td className="vel-scope">{backup.included_namespaces.join(', ')}</td>
                  <td>{formatStamp(backup.started)}</td>
                  <td>{backupDuration(backup)}</td>
                  <td>{backup.items_backed_up ?? '—'}</td>
                  <td className={expired ? 'vel-expired' : soon ? 'vel-soon' : ''}>
                    {expired ? 'expired' : formatStamp(backup.expires)}
                    {soon && <span className="vel-soon-note"> · within 24h</span>}
                  </td>
                  <td className="viz-dim">{backup.storage_location ?? 'default'}</td>
                  <td>
                    <button
                      type="button"
                      className="viz-toggle"
                      disabled={!canRestore || !isRestorable(backup)}
                      title={
                        !isRestorable(backup)
                          ? 'This backup did not complete, so there is nothing to restore from it.'
                          : !canRestore
                            ? 'This identity may not create Velero restores.'
                            : `Restore from ${backup.name}`
                      }
                      onClick={() => setRestoreTarget(backup)}
                    >
                      <Undo2 size={13} aria-hidden /> Restore
                    </button>
                  </td>
                </tr>
              );
            })}
            {matches(status.backups).length === 0 && (
              <tr><td colSpan={9} className="viz-empty">No backup matches.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {view === 'Restores' && (
        <table className="viz-table">
          <thead>
            <tr><th>Restore</th><th>Phase</th><th>From backup</th><th>Started</th><th>Took</th><th>Errors</th><th>Warnings</th></tr>
          </thead>
          <tbody>
            {matches(status.restores).map((restore) => (
              <tr key={restore.name}>
                <td className="mono">{restore.name}</td>
                <td><SeverityBadge severity={restore.health} label={restore.phase} /></td>
                <td className="mono viz-dim">{restore.backup ?? '—'}</td>
                <td>{formatStamp(restore.started)}</td>
                <td>{backupDuration(restore)}</td>
                <td className={restore.errors > 0 ? 'vel-expired' : ''}>{restore.errors}</td>
                <td>{restore.warnings}</td>
              </tr>
            ))}
            {matches(status.restores).length === 0 && (
              <tr><td colSpan={7} className="viz-empty">Nothing has been restored in this cluster.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {view === 'Schedules' && (
        <table className="viz-table">
          <thead><tr><th>Schedule</th><th>State</th><th>Cron</th><th>Last backup</th><th>Age</th></tr></thead>
          <tbody>
            {matches(status.schedules).map((schedule) => (
              <tr key={schedule.name}>
                <td className="mono">{schedule.name}</td>
                <td>
                  <SeverityBadge severity={schedule.health} label={schedule.paused ? 'Paused' : schedule.phase} />
                  {schedule.paused && (
                    <span className="vel-paused" title="A paused schedule takes no backups.">
                      <PauseCircle size={12} aria-hidden /> taking no backups
                    </span>
                  )}
                </td>
                <td className="mono">{schedule.cron}</td>
                <td>{formatStamp(schedule.last_backup)}</td>
                <td>{schedule.age}</td>
              </tr>
            ))}
            {matches(status.schedules).length === 0 && (
              <tr>
                <td colSpan={5} className="viz-empty">
                  No schedule exists. Every backup in this cluster is a manual one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {view === 'Storage' && (
        <table className="viz-table">
          <thead><tr><th>Location</th><th>State</th><th>Provider</th><th>Bucket</th><th>Prefix</th><th>Access</th><th>Last synced</th></tr></thead>
          <tbody>
            {matches(status.locations).map((location) => (
              <tr key={location.name}>
                <td>
                  <span className="mono">{location.name}</span>
                  {location.is_default && <span className="vel-default">default</span>}
                </td>
                <td><SeverityBadge severity={location.health} label={location.phase} /></td>
                <td>{location.provider}</td>
                <td className="mono vel-bucket">{location.bucket ?? '—'}</td>
                <td className="mono viz-dim">{location.prefix ?? '—'}</td>
                <td className="viz-dim">{location.access_mode ?? 'ReadWrite'}</td>
                <td>{formatStamp(location.last_synced)}</td>
              </tr>
            ))}
            {matches(status.locations).length === 0 && (
              <tr>
                <td colSpan={7} className="viz-empty">
                  No storage location is configured, so Velero has nowhere to write.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <p className="vel-note">
        <HardDriveDownload size={13} aria-hidden />
        Velero reconciles what is in the bucket into these resources. A backup taken from another cluster appears
        here only after its storage location has synced.
      </p>

      {backupOpen && (
        <BackupDialog
          namespaces={namespaces}
          locations={status.locations}
          onClose={() => setBackupOpen(false)}
          onSubmit={onCreateBackup}
        />
      )}

      {restoreTarget && (
        <RestoreDialog
          backup={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onSubmit={onCreateRestore}
        />
      )}
    </div>
  );
}
