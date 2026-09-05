import { describe, expect, it } from 'vitest';
import {
  accessLabel, auditColumn, formatStamp, grantableProfiles, hasPermission, isAdmin, isFixedProfile, canSeePlatform,
  type AuditTable, type MeUser, type ProfileSummary, type UserSummary,
} from './access';

const me = (permissions: string[]): MeUser => ({
  id: 'u1', email: 'a@tmjsistemas.com.br', display_name: null, active: true, profiles: [], permissions,
});

const user = (overrides: Partial<UserSummary> = {}): UserSummary => ({
  id: 'u2', email: 'b@tmjsistemas.com.br', display_name: 'B', active: true,
  last_login_at: '2026-09-04 17:56:02:709', profiles: [], ...overrides,
});

const profile = (name: string): ProfileSummary => ({
  id: `p-${name}`, name, description: null, permissions: [],
});

describe('who counts as admin', () => {
  it('requires the admin permission itself, not merely many others', () => {
    expect(isAdmin(me(['admin']))).toBe(true);
    expect(isAdmin(me(['view', 'edit-yaml', 'delete-workloads']))).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });
});

describe('what the web identity may do', () => {
  it('treats a missing identity as desktop: everything is offered', () => {
    expect(hasPermission(null, 'delete-workloads')).toBe(true);
  });

  it('lets a developer see the overview, workloads, logs and restart', () => {
    const developer = me(['overview', 'view', 'view-logs', 'restart-workloads']);
    expect(hasPermission(developer, 'overview')).toBe(true);
    expect(hasPermission(developer, 'view')).toBe(true);
    expect(hasPermission(developer, 'view-logs')).toBe(true);
    expect(hasPermission(developer, 'restart-workloads')).toBe(true);
    expect(hasPermission(developer, 'scale-workloads')).toBe(false);
    expect(hasPermission(developer, 'delete-workloads')).toBe(false);
    expect(hasPermission(developer, 'port-forward')).toBe(false);
  });

  it('lets a guest see only the overview', () => {
    const guest = me(['overview']);
    expect(hasPermission(guest, 'overview')).toBe(true);
    expect(hasPermission(guest, 'view')).toBe(false);
    expect(hasPermission(guest, 'view-logs')).toBe(false);
  });

  it('treats view as including the overview', () => {
    expect(hasPermission(me(['view']), 'overview')).toBe(true);
  });
});

describe('who sees platform screens', () => {
  it('shows them on desktop, where there is no identity', () => {
    expect(canSeePlatform(null)).toBe(true);
  });

  it('shows them to an admin and hides them from a developer', () => {
    expect(canSeePlatform(me(['admin']))).toBe(true);
    expect(canSeePlatform(me(['overview', 'view', 'view-logs', 'restart-workloads']))).toBe(false);
  });
});

describe('timestamps', () => {
  it('trims the engine stamp to the minute', () => {
    expect(formatStamp('2026-09-04 17:56:02:709')).toBe('2026-09-04 17:56');
  });

  it('says never rather than showing an empty cell', () => {
    expect(formatStamp(null)).toBe('never');
  });

  it('shows an unrecognised stamp as-is instead of hiding it', () => {
    expect(formatStamp('yesterday-ish')).toBe('yesterday-ish');
  });
});

describe('audit table plumbing', () => {
  it('finds columns by name so reordering cannot mislabel cells', () => {
    const table: AuditTable = { columns: ['at', 'user_email', 'allowed'], rows: [] };
    expect(auditColumn(table, 'user_email')).toBe(1);
    expect(auditColumn(table, 'missing')).toBe(-1);
  });
});

describe('granting', () => {
  it('offers only the three fixed profiles the user does not already hold', () => {
    const all = [profile('admin'), profile('developer'), profile('guest'), profile('operators')];
    const holder = user({ profiles: ['guest'] });
    expect(grantableProfiles(holder, all).map((entry) => entry.name)).toEqual(['admin', 'developer']);
  });

  it('does not treat a leftover custom profile as grantable', () => {
    expect(isFixedProfile('operators')).toBe(false);
    expect(isFixedProfile('developer')).toBe(true);
  });
});

describe('how a row describes access', () => {
  it('names the empty-profile state instead of showing nothing', () => {
    expect(accessLabel(user())).toBe('no access');
  });

  it('lists held profiles', () => {
    expect(accessLabel(user({ profiles: ['developer'] }))).toBe('developer');
  });

  it('says deactivated even when profiles remain attached', () => {
    expect(accessLabel(user({ active: false, profiles: ['admin'] }))).toBe('deactivated');
  });
});
