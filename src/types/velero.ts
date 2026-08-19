import type { Severity } from '../components/cluster/charts';

export type BackupRow = {
  name: string;
  phase: string;
  health: Severity;
  included_namespaces: string[];
  storage_location: string | null;
  started: string | null;
  completed: string | null;
  expires: string | null;
  age: string;
  items_backed_up: number | null;
  errors: number;
  warnings: number;
  /** Present when the backup finished but should not be trusted blindly. */
  caveat: string | null;
};

export type RestoreRow = {
  name: string;
  backup: string | null;
  phase: string;
  health: Severity;
  started: string | null;
  completed: string | null;
  age: string;
  errors: number;
  warnings: number;
};

export type ScheduleRow = {
  name: string;
  cron: string;
  paused: boolean;
  last_backup: string | null;
  phase: string;
  health: Severity;
  age: string;
};

export type StorageLocation = {
  name: string;
  provider: string;
  bucket: string | null;
  prefix: string | null;
  phase: string;
  health: Severity;
  is_default: boolean;
  last_synced: string | null;
  access_mode: string | null;
};

export type VeleroStatus = {
  installed: boolean;
  namespace: string;
  reason: string | null;
  backups: BackupRow[];
  restores: RestoreRow[];
  schedules: ScheduleRow[];
  locations: StorageLocation[];
  degraded_collectors: string[];
};

export const VELERO_VIEWS = ['Backups', 'Restores', 'Schedules', 'Storage'] as const;
export type VeleroView = (typeof VELERO_VIEWS)[number];

export function veleroViewCount(status: VeleroStatus, view: VeleroView): number {
  if (view === 'Backups') return status.backups.length;
  if (view === 'Restores') return status.restores.length;
  if (view === 'Schedules') return status.schedules.length;
  return status.locations.length;
}

/**
 * A backup is only worth restoring from if Velero finished writing it. Failed and
 * validation-failed backups are excluded from the restore picker entirely rather than
 * offered with a warning, because there is nothing in them to restore.
 */
export function isRestorable(backup: BackupRow): boolean {
  return backup.phase === 'Completed' || backup.phase === 'PartiallyFailed';
}

/**
 * Velero deletes a backup once its TTL elapses. A backup that expires within a day is
 * worth flagging: it is about to stop being a recovery option.
 */
export function expiresSoon(expires: string | null, now: number): boolean {
  if (!expires) return false;
  const at = Date.parse(expires);
  if (Number.isNaN(at)) return false;
  const hoursLeft = (at - now) / 3_600_000;
  return hoursLeft > 0 && hoursLeft <= 24;
}

export function isExpired(expires: string | null, now: number): boolean {
  if (!expires) return false;
  const at = Date.parse(expires);
  return !Number.isNaN(at) && at <= now;
}

/** Local time, so an operator comparing against an incident timeline sees their own clock. */
export function formatStamp(stamp: string | null): string {
  if (!stamp) return '—';
  const at = new Date(stamp);
  if (Number.isNaN(at.getTime())) return stamp;
  return at.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** How long the backup itself took, which is what a schedule window has to accommodate. */
export function backupDuration(row: { started: string | null; completed: string | null }): string {
  if (!row.started || !row.completed) return '—';
  const from = Date.parse(row.started);
  const to = Date.parse(row.completed);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return '—';
  const seconds = Math.round((to - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Matches the Rust side, so a name is never rejected only after the form is filled in. */
export function suggestBackupName(prefix: string, now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const cleaned = prefix.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '');
  // Trimmed again after truncating, so a cut that lands on a dash does not leave one
  // dangling before the timestamp.
  const base = (cleaned || 'manual').slice(0, 40).replace(/-+$/, '') || 'manual';
  return `${base}-${stamp}`;
}
