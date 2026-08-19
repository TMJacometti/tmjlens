import { describe, expect, it } from 'vitest';
import {
  backupDuration, expiresSoon, isExpired, isRestorable, suggestBackupName, veleroViewCount,
  type BackupRow, type VeleroStatus,
} from './velero';

const backup = (overrides: Partial<BackupRow> = {}): BackupRow => ({
  name: 'nightly',
  phase: 'Completed',
  health: 'good',
  included_namespaces: ['payments'],
  storage_location: 'default',
  started: '2026-08-19T02:00:00Z',
  completed: '2026-08-19T02:04:30Z',
  expires: '2026-09-18T02:00:00Z',
  age: '6h',
  items_backed_up: 812,
  errors: 0,
  warnings: 0,
  caveat: null,
  ...overrides,
});

describe('what may be restored', () => {
  it('offers completed backups', () => {
    expect(isRestorable(backup())).toBe(true);
  });

  it('offers a partially failed backup, which holds something even if not everything', () => {
    expect(isRestorable(backup({ phase: 'PartiallyFailed' }))).toBe(true);
  });

  it('refuses a failed backup rather than offering it with a warning', () => {
    expect(isRestorable(backup({ phase: 'Failed' }))).toBe(false);
    expect(isRestorable(backup({ phase: 'FailedValidation' }))).toBe(false);
    expect(isRestorable(backup({ phase: 'InProgress' }))).toBe(false);
  });
});

describe('expiry', () => {
  const now = Date.parse('2026-08-19T12:00:00Z');

  it('flags a backup that stops being a recovery option within a day', () => {
    expect(expiresSoon('2026-08-20T06:00:00Z', now)).toBe(true);
  });

  it('does not flag one that is safe for a week', () => {
    expect(expiresSoon('2026-08-26T12:00:00Z', now)).toBe(false);
  });

  it('does not double-report an already expired backup as expiring soon', () => {
    expect(expiresSoon('2026-08-19T11:00:00Z', now)).toBe(false);
    expect(isExpired('2026-08-19T11:00:00Z', now)).toBe(true);
  });

  it('treats a backup with no TTL as neither expiring nor expired', () => {
    expect(expiresSoon(null, now)).toBe(false);
    expect(isExpired(null, now)).toBe(false);
  });

  it('does not claim anything about a timestamp it cannot parse', () => {
    expect(expiresSoon('soon', now)).toBe(false);
    expect(isExpired('soon', now)).toBe(false);
  });
});

describe('how long a backup took', () => {
  it('reports seconds, minutes and hours', () => {
    expect(backupDuration({ started: '2026-08-19T02:00:00Z', completed: '2026-08-19T02:00:42Z' })).toBe('42s');
    expect(backupDuration({ started: '2026-08-19T02:00:00Z', completed: '2026-08-19T02:04:30Z' })).toBe('4m 30s');
    expect(backupDuration({ started: '2026-08-19T02:00:00Z', completed: '2026-08-19T04:15:00Z' })).toBe('2h 15m');
  });

  it('says nothing for a backup still running', () => {
    expect(backupDuration({ started: '2026-08-19T02:00:00Z', completed: null })).toBe('—');
  });

  it('refuses to render a negative duration from clock skew', () => {
    expect(backupDuration({ started: '2026-08-19T02:00:00Z', completed: '2026-08-19T01:00:00Z' })).toBe('—');
  });
});

describe('suggested names', () => {
  const at = new Date('2026-08-19T14:05:09');

  it('matches the DNS-1123 shape Velero requires', () => {
    const name = suggestBackupName('payments', at);
    expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });

  it('replaces characters a Kubernetes name may not hold', () => {
    expect(suggestBackupName('My Namespace!', at)).toMatch(/^my-namespace-\d{8}-\d{6}$/);
  });

  it('falls back rather than producing a name that starts with a dash', () => {
    expect(suggestBackupName('---', at)).toMatch(/^manual-/);
    expect(suggestBackupName('', at)).toMatch(/^manual-/);
  });

  it('truncates a long prefix instead of leaving the server to reject it', () => {
    expect(suggestBackupName('a'.repeat(120), at)).toMatch(/^a{40}-\d{8}-\d{6}$/);
  });
});

describe('tab counts', () => {
  it('counts each collection separately', () => {
    const status: VeleroStatus = {
      installed: true,
      namespace: 'velero',
      reason: null,
      backups: [backup(), backup({ name: 'other' })],
      restores: [],
      schedules: [{ name: 'nightly', cron: '0 2 * * *', paused: false, last_backup: null, phase: 'Enabled', health: 'good', age: '30d' }],
      locations: [],
      degraded_collectors: [],
    };
    expect(veleroViewCount(status, 'Backups')).toBe(2);
    expect(veleroViewCount(status, 'Restores')).toBe(0);
    expect(veleroViewCount(status, 'Schedules')).toBe(1);
    expect(veleroViewCount(status, 'Storage')).toBe(0);
  });
});
