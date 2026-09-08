import { useState } from 'react';
import { RefreshCw, ShieldAlert, ShieldCheck, UserPlus, UserX } from 'lucide-react';
import { SeverityBadge, StatTile } from '../cluster/charts';
import {
  accessLabel, auditColumn, formatStamp, grantableProfiles, isFixedProfile,
  type AuditTable, type MeUser, type ProfileSummary, type UserSummary,
} from '../../types/access';
import './access.css';

const VIEWS = ['Users', 'Profiles', 'Audit'] as const;
type View = (typeof VIEWS)[number];

type Props = {
  me: MeUser | null;
  users: UserSummary[];
  profiles: ProfileSummary[];
  audit: AuditTable | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onGrant: (user: UserSummary, profile: ProfileSummary) => Promise<void>;
  onRevoke: (user: UserSummary, profileName: string) => Promise<void>;
  onSetActive: (user: UserSummary, active: boolean) => Promise<void>;
  notify: (text: string, detail: string | undefined, tone: 'good' | 'bad') => void;
};

export function AccessPage({
  me, users, profiles, audit, loading, error,
  onRefresh, onGrant, onRevoke, onSetActive, notify,
}: Props) {
  const [view, setView] = useState<View>('Users');
  const [busy, setBusy] = useState('');

  if (error && users.length === 0) {
    return (
      <div className="viz-callout viz-callout-critical">
        <ShieldAlert size={18} aria-hidden />
        <div>
          <strong>Access control could not be read.</strong>
          <p>{error}</p>
          <button type="button" className="viz-toggle" onClick={onRefresh}>Try again</button>
        </div>
      </div>
    );
  }

  const run = async (key: string, action: () => Promise<void>, done: string) => {
    setBusy(key);
    try {
      await action();
      notify(done, undefined, 'good');
    } catch (cause) {
      notify('The change was not applied', String(cause), 'bad');
    } finally {
      setBusy('');
    }
  };

  const guests = users.filter((entry) => entry.active && entry.profiles.includes('guest') && entry.profiles.length === 1).length;
  const developers = users.filter((entry) => entry.active && entry.profiles.includes('developer')).length;
  const deniedCount = audit
    ? audit.rows.filter((row) => row[auditColumn(audit, 'allowed')] === 'false').length
    : 0;

  const fixed = profiles.filter((profile) => isFixedProfile(profile.name));
  const counts: Record<View, number> = {
    Users: users.length,
    Profiles: fixed.length,
    Audit: audit?.rows.length ?? 0,
  };

  return (
    <div className={`access-page ${loading ? 'is-refreshing' : ''}`}>
      <p className="wl-lead">
        New people sign in as <b>guest</b> — Cluster Overview only. Promote them to
        <b>developer</b> or <b>admin</b> here. Everything beyond plain viewing lands in
        the audit trail under the person's own name, which the cluster's log cannot tell you.
      </p>

      <div className="access-kpis">
        <StatTile label="People" value={String(users.length)} note="Registered through SSO" />
        <StatTile
          label="Guests"
          value={guests > 0 ? String(guests) : 'none'}
          note={guests > 0 ? 'Overview only — waiting for a promotion' : 'Nobody left as guest'}
          severity={guests > 0 ? 'warning' : 'good'}
        />
        <StatTile label="Developers" value={String(developers)} note="Logs, workloads, restart" />
        <StatTile
          label="Denied recently"
          value={deniedCount > 0 ? String(deniedCount) : 'none'}
          note={deniedCount > 0 ? 'Attempts the gate refused' : 'In the loaded audit window'}
          severity={deniedCount > 0 ? 'warning' : 'good'}
        />
      </div>

      <div className="access-toolbar">
        <div className="wl-switch" role="tablist" aria-label="Access control">
          {VIEWS.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={view === entry}
              className={view === entry ? 'is-active' : ''}
              onClick={() => setView(entry)}
            >
              {entry} <span className="viz-count">{counts[entry]}</span>
            </button>
          ))}
        </div>
        <div className="access-toolbar-right">
          <button type="button" className="viz-toggle" onClick={onRefresh}>
            <RefreshCw size={13} aria-hidden /> Refresh
          </button>
        </div>
      </div>

      {view === 'Users' && (
        <table className="viz-table">
          <thead>
            <tr><th>Person</th><th>Access</th><th>Last login</th><th>Grant</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {users.map((entry) => {
              const grantable = grantableProfiles(entry, profiles);
              const self = me?.id === entry.id;
              return (
                <tr key={entry.id} className={entry.active ? '' : 'access-inactive'}>
                  <td>
                    <span className="mono">{entry.email}</span>
                    {self && <span className="access-self"> you</span>}
                    {entry.display_name && <div className="viz-dim">{entry.display_name}</div>}
                  </td>
                  <td>
                    {entry.profiles.length === 0 || !entry.active ? (
                      <SeverityBadge
                        severity={entry.active ? 'warning' : 'critical'}
                        label={accessLabel(entry)}
                      />
                    ) : (
                      entry.profiles.map((name) => (
                        <span key={name} className="access-chip">
                          {name}
                          <button
                            type="button"
                            className="access-chip-remove"
                            title={`Revoke ${name} from ${entry.email}`}
                            disabled={busy !== ''}
                            onClick={() =>
                              void run(`revoke-${entry.id}-${name}`, () => onRevoke(entry, name), `${name} revoked from ${entry.email}`)
                            }
                          >
                            ×
                          </button>
                        </span>
                      ))
                    )}
                  </td>
                  <td className="viz-dim">{formatStamp(entry.last_login_at)}</td>
                  <td>
                    {grantable.length > 0 && entry.active ? (
                      <select
                        className="access-grant"
                        aria-label={`Grant a profile to ${entry.email}`}
                        disabled={busy !== ''}
                        value=""
                        onChange={(event) => {
                          const chosen = grantable.find((profile) => profile.id === event.target.value);
                          if (!chosen) return;
                          void run(`grant-${entry.id}`, () => onGrant(entry, chosen), `${chosen.name} granted to ${entry.email}`);
                        }}
                      >
                        <option value="">grant profile…</option>
                        {grantable.map((profile) => (
                          <option key={profile.id} value={profile.id}>{profile.name}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="viz-dim">—</span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`viz-toggle ${entry.active ? 'viz-danger' : ''}`}
                      disabled={busy !== '' || (self && entry.active)}
                      title={
                        self && entry.active
                          ? 'Deactivating yourself would lock the door from the inside; another admin must do it.'
                          : entry.active
                            ? `${entry.email} keeps their profiles but cannot sign in`
                            : `Let ${entry.email} sign in again`
                      }
                      onClick={() =>
                        void run(
                          `active-${entry.id}`,
                          () => onSetActive(entry, !entry.active),
                          entry.active ? `${entry.email} deactivated` : `${entry.email} reactivated`,
                        )
                      }
                    >
                      {entry.active ? <UserX size={13} aria-hidden /> : <UserPlus size={13} aria-hidden />}
                      {entry.active ? ' Deactivate' : ' Reactivate'}
                    </button>
                  </td>
                </tr>
              );
            })}
            {users.length === 0 && (
              <tr><td colSpan={5} className="viz-empty">Nobody has signed in yet.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {view === 'Profiles' && (
        <div className="access-profiles">
          {fixed.map((profile) => (
            <section key={profile.id} className="access-profile">
              <header>
                <h3><ShieldCheck size={15} aria-hidden /> {profile.name}</h3>
                {profile.description && <p className="viz-dim">{profile.description}</p>}
              </header>
            </section>
          ))}
        </div>
      )}

      {view === 'Audit' && audit && (
        <table className="viz-table access-audit">
          <thead>
            <tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Outcome</th></tr>
          </thead>
          <tbody>
            {audit.rows.map((row, index) => {
              const cell = (name: string) => row[auditColumn(audit, name)] ?? null;
              const allowed = cell('allowed') === 'true';
              const target = cell('target');
              const namespace = cell('namespace');
              const detail = cell('detail');
              return (
                <tr key={index}>
                  <td className="viz-dim access-nowrap">{formatStamp(cell('at'))}</td>
                  <td className="mono">{cell('user_email')}</td>
                  <td>
                    <span className="mono">{cell('action')}</span>
                    {detail && <div className="viz-dim access-detail">{detail}</div>}
                  </td>
                  <td className="mono viz-dim">
                    {namespace ? `${namespace}/` : ''}{target ?? '—'}
                  </td>
                  <td>
                    <SeverityBadge severity={allowed ? 'good' : 'critical'} label={allowed ? 'allowed' : 'denied'} />
                  </td>
                </tr>
              );
            })}
            {audit.rows.length === 0 && (
              <tr><td colSpan={5} className="viz-empty">Nothing audited yet — reads are not recorded.</td></tr>
            )}
          </tbody>
        </table>
      )}
      {view === 'Audit' && !audit && (
        <div className="viz-empty viz-empty-page">{loading ? 'Reading the audit trail…' : 'Select Refresh to load.'}</div>
      )}
    </div>
  );
}
