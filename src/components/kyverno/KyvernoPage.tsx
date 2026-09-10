import { useState } from 'react';
import { Gavel, RefreshCw, ShieldAlert } from 'lucide-react';
import { SeverityBadge, StatTile } from '../cluster/charts';
import {
  KYVERNO_VIEWS, enforceSplit, kyvernoViewCount, toggleWarning, violationTarget,
  type KyvernoOverview, type KyvernoView, type PolicyRow,
} from '../../types/kyverno';
import '../configuration/configuration.css';
import './kyverno.css';

type Props = {
  data: KyvernoOverview | null;
  loading: boolean;
  error: string;
  /** Whether this identity may switch policies between Enforce and Audit. */
  canToggle: boolean;
  onRefresh: () => void;
  /** Resolves to the server's own sentence about what the switch did. */
  onToggleAction: (policy: PolicyRow, next: string) => Promise<string>;
  notify: (text: string, detail: string | undefined, tone: 'good' | 'bad') => void;
};

export function KyvernoPage({ data, loading, error, canToggle, onRefresh, onToggleAction, notify }: Props) {
  const [view, setView] = useState<KyvernoView>('Policies');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState('');

  if (error && !data) {
    return (
      <div className="viz-callout viz-callout-critical">
        <ShieldAlert size={18} aria-hidden />
        <div>
          <strong>Kyverno could not be read.</strong>
          <p>{error}</p>
          <button type="button" className="viz-toggle" onClick={onRefresh}>Try again</button>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="viz-empty viz-empty-page">{loading ? 'Reading policies…' : 'Select Refresh to load.'}</div>;
  }

  if (!data.installed) {
    return (
      <div className="viz-callout">
        <Gavel size={18} aria-hidden />
        <div>
          <strong>Kyverno is not installed in this cluster.</strong>
          <p>{data.reason}</p>
          <button type="button" className="viz-toggle" onClick={onRefresh}>
            <RefreshCw size={13} aria-hidden /> Check again
          </button>
        </div>
      </div>
    );
  }

  const split = enforceSplit(data.policies);
  const needle = filter.trim().toLowerCase();
  const policies = needle
    ? data.policies.filter((entry) => entry.name.toLowerCase().includes(needle))
    : data.policies;
  const violations = needle
    ? data.violations.filter(
        (entry) =>
          entry.policy.toLowerCase().includes(needle) ||
          entry.name.toLowerCase().includes(needle) ||
          (entry.namespace ?? '').toLowerCase().includes(needle),
      )
    : data.violations;

  const toggle = async (policy: PolicyRow) => {
    const next = policy.action === 'Enforce' ? 'Audit' : 'Enforce';
    if (!window.confirm(toggleWarning(policy, next))) return;
    setBusy(policy.name);
    try {
      notify(`${policy.name} → ${next}`, await onToggleAction(policy, next), 'good');
    } catch (cause) {
      notify('The policy was not changed', String(cause), 'bad');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className={`kyv-page ${loading ? 'is-refreshing' : ''}`}>
      {data.degraded_collectors.length > 0 && (
        <div className="viz-callout viz-callout-warning">
          <ShieldAlert size={16} aria-hidden />
          <div>
            <strong>Part of this screen is missing.</strong>
            <ul className="kyv-degraded">
              {data.degraded_collectors.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>
        </div>
      )}

      <div className="kyv-kpis">
        <StatTile
          label="Policies"
          value={String(data.policies.length)}
          note={`${split.enforce} Enforce · ${split.audit} Audit`}
        />
        <StatTile
          label="Blocking"
          value={split.enforce > 0 ? String(split.enforce) : 'none'}
          note={split.audit > 0 ? `${split.audit} only report — Audit blocks nothing` : 'Every policy enforces'}
          severity={split.enforce === 0 && data.policies.length > 0 ? 'warning' : 'good'}
        />
        <StatTile
          label="Failing checks"
          value={String(data.fail)}
          note={data.warn > 0 ? `plus ${data.warn} warning(s)` : 'Across every policy report'}
          severity={data.fail > 0 ? 'serious' : 'good'}
        />
        <StatTile
          label="Passing checks"
          value={String(data.pass)}
          note="What the cluster already satisfies"
          severity="good"
        />
      </div>

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

      <div className="kyv-toolbar">
        <div className="wl-switch" role="tablist" aria-label="Kyverno resources">
          {KYVERNO_VIEWS.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={view === entry}
              className={view === entry ? 'is-active' : ''}
              onClick={() => setView(entry)}
            >
              {entry} <span className="viz-count">{kyvernoViewCount(data, entry)}</span>
            </button>
          ))}
        </div>
        <div className="kyv-toolbar-right">
          <input
            className="wl-search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by policy, resource or namespace…"
            aria-label="Filter"
          />
          <button type="button" className="viz-toggle" onClick={onRefresh}>
            <RefreshCw size={13} aria-hidden /> Refresh
          </button>
        </div>
      </div>

      {view === 'Policies' && (
        <table className="viz-table">
          <thead>
            <tr>
              <th>Policy</th><th>State</th><th>Mode</th><th>Rules</th>
              <th>Failing</th><th>Background</th><th>Age</th>
              {canToggle && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {policies.map((entry) => (
              <tr key={`${entry.namespace ?? ''}/${entry.name}`}>
                <td>
                  <span className="mono">{entry.name}</span>
                  <div className="viz-dim kyv-scope">
                    {entry.namespace ? `namespace ${entry.namespace}` : 'cluster-wide'}
                  </div>
                </td>
                <td>
                  <SeverityBadge severity={entry.health} label={entry.ready ? 'Ready' : 'Not ready'} />
                  {entry.message && <div className="kyv-message">{entry.message}</div>}
                </td>
                <td>
                  <span className={entry.action === 'Enforce' ? 'kyv-enforce' : 'kyv-audit'}>
                    {entry.action}
                  </span>
                  {entry.action === 'Audit' && (
                    <div className="viz-dim kyv-scope">reports, does not block</div>
                  )}
                </td>
                <td>
                  {entry.rules}
                  <div className="viz-dim kyv-scope">{entry.rule_kinds.join(', ') || '—'}</div>
                </td>
                <td className={entry.fail_count > 0 ? 'kyv-failing' : 'viz-dim'}>
                  {entry.fail_count > 0 ? entry.fail_count : '—'}
                </td>
                <td className={entry.background ? '' : 'viz-dim'}>{entry.background ? 'scans' : 'off'}</td>
                <td>{entry.age}</td>
                {canToggle && (
                  <td>
                    <button
                      type="button"
                      className={entry.action === 'Enforce' ? 'viz-toggle viz-danger' : 'viz-toggle'}
                      disabled={busy !== ''}
                      title={
                        entry.action === 'Enforce'
                          ? 'Switch to Audit — it stops blocking and only reports'
                          : 'Switch to Enforce — new violations will be rejected at admission'
                      }
                      onClick={() => void toggle(entry)}
                    >
                      <Gavel size={13} aria-hidden />
                      {entry.action === 'Enforce' ? ' Make Audit' : ' Make Enforce'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {policies.length === 0 && (
              <tr><td colSpan={canToggle ? 8 : 7} className="viz-empty">No policy matches.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {view === 'Violations' && (
        <>
          {data.violations_capped && (
            <p className="kyv-cap viz-dim">
              Showing the worst {data.violations.length} results — the full count is in the tiles above.
            </p>
          )}
          <table className="viz-table">
            <thead>
              <tr><th>Result</th><th>Policy / rule</th><th>Resource</th><th>Why</th></tr>
            </thead>
            <tbody>
              {violations.map((entry, index) => (
                <tr key={`${entry.policy}-${entry.rule}-${entry.name}-${index}`}>
                  <td>
                    <SeverityBadge
                      severity={entry.result === 'fail' ? 'serious' : 'warning'}
                      label={entry.result}
                    />
                    {entry.severity && <div className="viz-dim kyv-scope">{entry.severity}</div>}
                  </td>
                  <td>
                    <span className="mono">{entry.policy}</span>
                    <div className="viz-dim kyv-scope mono">{entry.rule}</div>
                  </td>
                  <td className="mono kyv-target">{violationTarget(entry)}</td>
                  <td className="kyv-why">{entry.message || <span className="viz-dim">—</span>}</td>
                </tr>
              ))}
              {violations.length === 0 && (
                <tr>
                  <td colSpan={4} className="viz-empty">
                    {data.violations.length === 0
                      ? 'No failing result in any policy report — the cluster satisfies its policies.'
                      : 'No violation matches the filter.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
