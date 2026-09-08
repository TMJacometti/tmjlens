/** Who the server says is sitting at this browser. Desktop has no such notion. */
export type MeUser = {
  id: string;
  email: string;
  display_name: string | null;
  active: boolean;
  profiles: string[];
  permissions: string[];
};

export type UserSummary = {
  id: string;
  email: string;
  display_name: string | null;
  active: boolean;
  last_login_at: string | null;
  profiles: string[];
};

export type ProfileSummary = {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
};

export type PermissionInfo = {
  name: string;
  description: string;
};

/** The audit trail exactly as the database returns it: columns plus rows. */
export type AuditTable = {
  columns: string[];
  rows: (string | null)[][];
};

/** The only three profiles the product grants. Anything else is leftover. */
export const FIXED_PROFILES = ['admin', 'developer', 'guest'] as const;

export function isFixedProfile(name: string): boolean {
  return (FIXED_PROFILES as readonly string[]).includes(name);
}

export function isAdmin(me: MeUser | null): boolean {
  return Boolean(me?.permissions.includes('admin'));
}

/**
 * Nodes, reports, cloud and plugins are the platform console. Desktop has no
 * identity, so they stay. On the web only an admin sees them — a developer
 * works workloads, not the fleet.
 */
export function canSeePlatform(me: MeUser | null): boolean {
  return !me || isAdmin(me);
}

/**
 * Desktop has no identity: Kubernetes RBAC is the authority, so every action
 * is offered and the API server decides. On the web, `me` is the gate.
 */
export function hasPermission(me: MeUser | null, permission: string): boolean {
  if (!me) return true;
  if (!me.active) return false;
  if (me.permissions.includes('admin')) return true;
  if (me.permissions.includes(permission)) return true;
  return permission === 'overview' && me.permissions.includes('view');
}

/**
 * tmjLite stamps `yyyy-MM-dd HH:mm:ss:ms`. Down to the minute is what a person
 * scanning "who was here" needs; seconds and milliseconds are noise.
 */
export function formatStamp(stamp: string | null): string {
  if (!stamp) return 'never';
  const match = stamp.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]}` : stamp;
}

/** Column lookup by name, so the audit table survives column reordering. */
export function auditColumn(table: AuditTable, name: string): number {
  return table.columns.indexOf(name);
}

/** The profiles a user could still be granted — what the grant menu offers. */
export function grantableProfiles(user: UserSummary, profiles: ProfileSummary[]): ProfileSummary[] {
  return profiles.filter((profile) => isFixedProfile(profile.name) && !user.profiles.includes(profile.name));
}

/**
 * A user with no profile has no access at all — that only happens after every
 * profile is revoked. Fresh SSO registrations land as guest.
 */
export function accessLabel(user: UserSummary): string {
  if (!user.active) return 'deactivated';
  if (user.profiles.length === 0) return 'no access';
  return user.profiles.join(', ');
}
