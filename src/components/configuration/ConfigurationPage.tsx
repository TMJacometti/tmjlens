import { useMemo, useState } from 'react';
import { KeyRound, RefreshCw, ShieldAlert, Webhook } from 'lucide-react';
import { SeverityBadge, StatTile } from '../cluster/charts';
import {
  CONFIG_VIEWS, configViewCount, describeConsumers, formatBytes, sinceRenewal, viewSeverity,
  type ConfigMapInfo, type ConfigView, type ConfigurationOverview, type RevealedValue, type SecretInfo,
} from '../../types/configuration';
import { KeyValuePanel } from './KeyValuePanel';
import './configuration.css';

type Target = { kind: 'ConfigMap' | 'Secret'; item: ConfigMapInfo | SecretInfo };

type Props = {
  data: ConfigurationOverview | null;
  loading: boolean;
  error: string;
  canEditConfigMaps: boolean;
  canEditSecrets: boolean;
  onRefresh: () => void;
  onRead: (kind: 'ConfigMap' | 'Secret', name: string, key: string) => Promise<RevealedValue>;
  onSave: (kind: 'ConfigMap' | 'Secret', name: string, key: string, value: string) => Promise<void>;
  onDelete: (kind: 'ConfigMap' | 'Secret', name: string, key: string) => Promise<void>;
  notify: (text: string, detail: string | undefined, tone: 'good' | 'bad') => void;
};

export function ConfigurationPage({
  data, loading, error, canEditConfigMaps, canEditSecrets, onRefresh, onRead, onSave, onDelete, notify,
}: Props) {
  const [view, setView] = useState<ConfigView>('Config Maps');
  const [filter, setFilter] = useState('');
  const [target, setTarget] = useState<Target | null>(null);

  const now = Date.now();
  const needle = filter.trim().toLowerCase();
  const matches = <T extends { name: string }>(items: T[]): T[] =>
    needle ? items.filter((item) => item.name.toLowerCase().includes(needle)) : items;

  const secretKeyCount = useMemo(
    () => data?.secrets.reduce((total, secret) => total + secret.keys.length, 0) ?? 0,
    [data],
  );

  if (error && !data) {
    return (
      <div className="viz-callout viz-callout-critical">
        <ShieldAlert size={18} aria-hidden />
        <div>
          <strong>Configuration could not be read.</strong>
          <p>{error}</p>
          <button type="button" className="viz-toggle" onClick={onRefresh}>Try again</button>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="viz-empty viz-empty-page">{loading ? 'Reading configuration…' : 'Select Refresh to load.'}</div>;
  }

  const blockedDrains = data.disruption_budgets.filter((budget) => budget.disruptions_allowed === 0).length;
  const tightQuota = data.quotas.filter((quota) => quota.health === 'critical' || quota.health === 'serious').length;

  return (
    <div className={`cfg-page ${loading ? 'is-refreshing' : ''}`}>
      {data.degraded_collectors.length > 0 && (
        <div className="viz-callout viz-callout-warning">
          <ShieldAlert size={16} aria-hidden />
          <div>
            <strong>Part of this screen is missing.</strong>
            <ul className="cfg-degraded">
              {data.degraded_collectors.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>
        </div>
      )}

      <div className="cfg-kpis">
        <StatTile
          label="Config maps"
          value={String(data.config_maps.length)}
          note={`${data.config_maps.reduce((total, entry) => total + entry.keys.length, 0)} keys`}
        />
        <StatTile
          label="Secrets"
          value={String(data.secrets.length)}
          note={`${secretKeyCount} keys, values not loaded`}
        />
        <StatTile
          label="Quota pressure"
          value={tightQuota > 0 ? `${tightQuota}` : 'clear'}
          note={tightQuota > 0 ? 'quota near its limit' : 'No quota is close to full'}
          severity={tightQuota > 0 ? 'serious' : 'good'}
        />
        <StatTile
          label="Drains blocked"
          value={blockedDrains > 0 ? `${blockedDrains}` : 'none'}
          note={blockedDrains > 0 ? 'budget allows no eviction' : 'Every budget allows an eviction'}
          severity={blockedDrains > 0 ? 'serious' : 'good'}
        />
      </div>

      {data.findings.length > 0 && (
        <div className="cfg-findings">
          {data.findings.map((finding) => (
            // Collapsed by default: the title and the objects it names answer "what is
            // wrong and where" in one line, which is what the screen is scanned for.
            // The explanation is a click away rather than filling the first screen.
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

      <div className="cfg-toolbar">
        <div className="cfg-switch" role="tablist" aria-label="Configuration resources">
          {CONFIG_VIEWS.map((entry) => {
            const severity = viewSeverity(data, entry);
            return (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={view === entry}
                className={view === entry ? 'active' : ''}
                onClick={() => setView(entry)}
              >
                {entry} <span className="wl-count">{configViewCount(data, entry)}</span>
                {/* A dot alone would carry meaning by colour, so it is labelled. */}
                {severity && (
                  <span className={`cfg-dot cfg-dot-${severity}`} title={`${entry} needs attention`}>
                    <span className="viz-sr">needs attention</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="cfg-toolbar-right">
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

      {view === 'Config Maps' && (
        <table className="viz-table">
          <thead><tr><th>Name</th><th>Keys</th><th>Size</th><th>Used by</th><th>Owner</th><th>Age</th></tr></thead>
          <tbody>
            {matches(data.config_maps).map((entry) => (
              <tr key={entry.name} className="cfg-row" onClick={() => setTarget({ kind: 'ConfigMap', item: entry })}>
                <td>
                  <button type="button" className="cfg-link mono">{entry.name}</button>
                  {entry.immutable && <span className="cfg-tag">immutable</span>}
                </td>
                <td>{entry.keys.length}</td>
                <td>{formatBytes(entry.total_bytes)}</td>
                <td className={entry.used_by_total === 0 ? 'cfg-orphan' : 'cfg-consumers'}>
                  {describeConsumers(entry.used_by, entry.used_by_total)}
                </td>
                <td className="viz-dim">{entry.managed_by ?? '—'}</td>
                <td>{entry.age}</td>
              </tr>
            ))}
            {matches(data.config_maps).length === 0 && <tr><td colSpan={6} className="viz-empty">No config map matches.</td></tr>}
          </tbody>
        </table>
      )}

      {view === 'Secrets' && (
        <>
          <p className="cfg-lead">
            <KeyRound size={13} aria-hidden />
            <span>
              This table carries no secret values — only key names and sizes. A value is read from the cluster only
              when you open a secret and ask for that key.
            </span>
          </p>
          <table className="viz-table">
            <thead><tr><th>Name</th><th>Type</th><th>Keys</th><th>Size</th><th>Used by</th><th>Owner</th><th>Age</th></tr></thead>
            <tbody>
              {matches(data.secrets).map((entry) => (
                <tr key={entry.name} className="cfg-row" onClick={() => setTarget({ kind: 'Secret', item: entry })}>
                  <td>
                    <button type="button" className="cfg-link mono">{entry.name}</button>
                    {entry.immutable && <span className="cfg-tag">immutable</span>}
                  </td>
                  <td>
                    <div className="cfg-purpose">{entry.purpose}</div>
                    <div className="viz-dim mono cfg-type">{entry.secret_type}</div>
                  </td>
                  <td>{entry.keys.length}</td>
                  <td>{formatBytes(entry.total_bytes)}</td>
                  <td className={entry.used_by_total === 0 ? 'cfg-orphan' : 'cfg-consumers'}>
                    {describeConsumers(entry.used_by, entry.used_by_total)}
                  </td>
                  <td className="viz-dim">{entry.managed_by ?? '—'}</td>
                  <td>{entry.age}</td>
                </tr>
              ))}
              {matches(data.secrets).length === 0 && <tr><td colSpan={7} className="viz-empty">No secret matches.</td></tr>}
            </tbody>
          </table>
        </>
      )}

      {view === 'Resource Quotas' && (
        <div className="cfg-quotas">
          {matches(data.quotas).map((quota) => (
            <div key={quota.name} className="cfg-quota">
              <div className="cfg-quota-head">
                <span className="mono">{quota.name}</span>
                <SeverityBadge severity={quota.health === 'unknown' ? 'warning' : quota.health} />
                {quota.scopes.length > 0 && <span className="viz-dim">scopes: {quota.scopes.join(', ')}</span>}
              </div>
              <table className="viz-table">
                <thead><tr><th>Resource</th><th>Used</th><th>Hard limit</th><th>Consumed</th></tr></thead>
                <tbody>
                  {quota.entries.map((entry) => (
                    <tr key={entry.resource}>
                      <td className="mono">{entry.resource}</td>
                      <td className="mono">{entry.used}</td>
                      <td className="mono">{entry.hard}</td>
                      <td>
                        {entry.percent === null ? (
                          <span className="viz-dim">not measurable</span>
                        ) : (
                          <span className="cfg-meter">
                            <span
                              className={`cfg-meter-fill cfg-meter-${entry.health}`}
                              style={{ width: `${Math.min(100, entry.percent)}%` }}
                            />
                            <span className="cfg-meter-label">{entry.percent.toFixed(0)}%</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {matches(data.quotas).length === 0 && (
            <div className="viz-empty">No resource quota constrains this namespace.</div>
          )}
        </div>
      )}

      {view === 'Limit Ranges' && (
        <table className="viz-table">
          <thead><tr><th>Name</th><th>Applies to</th><th>Resource</th><th>Min</th><th>Max</th><th>Default request</th><th>Default limit</th></tr></thead>
          <tbody>
            {matches(data.limit_ranges).flatMap((range) =>
              range.items.map((item) => (
                <tr key={`${range.name}-${item.item_type}-${item.resource}`}>
                  <td className="mono">{range.name}</td>
                  <td>{item.item_type}</td>
                  <td className="mono">{item.resource}</td>
                  <td className="mono">{item.min ?? '—'}</td>
                  <td className="mono">{item.max ?? '—'}</td>
                  <td className="mono">{item.default_request ?? '—'}</td>
                  <td className="mono">{item.default_limit ?? '—'}</td>
                </tr>
              )),
            )}
            {matches(data.limit_ranges).length === 0 && (
              <tr><td colSpan={7} className="viz-empty">No limit range applies to this namespace.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {view === 'Autoscalers' && (
        <table className="viz-table">
          <thead><tr><th>Name</th><th>State</th><th>Target</th><th>Replicas</th><th>Range</th><th>Metrics</th><th>Age</th></tr></thead>
          <tbody>
            {matches(data.autoscalers).map((entry) => (
              <tr key={entry.name}>
                <td className="mono">{entry.name}</td>
                <td>
                  <SeverityBadge severity={entry.health} />
                  <div className="cfg-reason">{entry.reason}</div>
                </td>
                <td className="mono">{entry.target}</td>
                <td>
                  {entry.current_replicas}
                  {entry.current_replicas !== entry.desired_replicas && ` → ${entry.desired_replicas}`}
                </td>
                <td className="viz-dim">{entry.min_replicas}–{entry.max_replicas}</td>
                <td className="cfg-metrics">{entry.metrics.join('; ') || '—'}</td>
                <td>{entry.age}</td>
              </tr>
            ))}
            {matches(data.autoscalers).length === 0 && (
              <tr><td colSpan={7} className="viz-empty">Nothing in this namespace scales automatically.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {view === 'Disruption Budgets' && (
        <table className="viz-table">
          <thead><tr><th>Name</th><th>State</th><th>Requirement</th><th>Healthy</th><th>Evictions allowed</th><th>Age</th></tr></thead>
          <tbody>
            {matches(data.disruption_budgets).map((entry) => (
              <tr key={entry.name}>
                <td className="mono">{entry.name}</td>
                <td>
                  <SeverityBadge severity={entry.health} />
                  <div className="cfg-reason">{entry.reason}</div>
                </td>
                <td>{entry.requirement}</td>
                <td>{entry.current_healthy} of {entry.desired_healthy}</td>
                <td className={entry.disruptions_allowed === 0 ? 'cfg-orphan' : ''}>{entry.disruptions_allowed}</td>
                <td>{entry.age}</td>
              </tr>
            ))}
            {matches(data.disruption_budgets).length === 0 && (
              <tr><td colSpan={6} className="viz-empty">No disruption budget protects these workloads during a drain.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {view === 'Priority Classes' && (
        <table className="viz-table">
          <thead><tr><th>Name</th><th>Value</th><th>Default</th><th>Preemption</th><th>Description</th></tr></thead>
          <tbody>
            {matches(data.priority_classes).map((entry) => (
              <tr key={entry.name}>
                <td className="mono">{entry.name}</td>
                <td className="mono">{entry.value.toLocaleString()}</td>
                <td>{entry.global_default ? 'cluster default' : '—'}</td>
                <td className="viz-dim">{entry.preemption}</td>
                <td className="cfg-description">{entry.description || '—'}</td>
              </tr>
            ))}
            {matches(data.priority_classes).length === 0 && (
              <tr><td colSpan={5} className="viz-empty">No priority class is defined, or this identity may not read them.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {view === 'Runtime Classes' && (
        <table className="viz-table">
          <thead><tr><th>Name</th><th>Handler</th><th>Age</th></tr></thead>
          <tbody>
            {matches(data.runtime_classes).map((entry) => (
              <tr key={entry.name}>
                <td className="mono">{entry.name}</td>
                <td className="mono">{entry.handler}</td>
                <td>{entry.age}</td>
              </tr>
            ))}
            {matches(data.runtime_classes).length === 0 && (
              <tr><td colSpan={3} className="viz-empty">Every pod uses the default container runtime.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {view === 'Leases' && (
        <table className="viz-table">
          <thead><tr><th>Name</th><th>State</th><th>Holder</th><th>Last renewed</th><th>Duration</th></tr></thead>
          <tbody>
            {matches(data.leases).map((entry) => (
              <tr key={entry.name}>
                <td className="mono">{entry.name}</td>
                <td><SeverityBadge severity={entry.health} label={entry.health === 'good' ? 'Renewing' : 'Stale'} /></td>
                <td className="mono viz-dim cfg-holder">{entry.holder ?? '—'}</td>
                <td>{sinceRenewal(entry.renewed, now)}</td>
                <td className="viz-dim">{entry.duration_seconds ? `${entry.duration_seconds}s` : '—'}</td>
              </tr>
            ))}
            {matches(data.leases).length === 0 && (
              <tr><td colSpan={5} className="viz-empty">No lease is held in this namespace.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {view === 'Webhooks' && (
        <>
          <p className="cfg-lead">
            <Webhook size={13} aria-hidden />
            <span>
              Admission webhooks are cluster-wide. Each one is checked against the services that exist, because a
              webhook set to <code>Fail</code> whose service is gone rejects every write that matches its rules.
            </span>
          </p>
          <table className="viz-table">
            <thead><tr><th>Webhook</th><th>State</th><th>Kind</th><th>On failure</th><th>Service</th><th>Rules</th></tr></thead>
            <tbody>
              {data.webhooks
                .filter((hook) => !needle || hook.webhook.toLowerCase().includes(needle) || hook.configuration.toLowerCase().includes(needle))
                .map((hook) => (
                  <tr key={`${hook.configuration}-${hook.webhook}`}>
                    <td>
                      <span className="mono">{hook.webhook}</span>
                      <div className="viz-dim mono cfg-type">{hook.configuration}</div>
                    </td>
                    <td>
                      <SeverityBadge severity={hook.health === 'unknown' ? 'warning' : hook.health} />
                      <div className="cfg-reason">{hook.reason}</div>
                    </td>
                    <td>{hook.kind}</td>
                    <td className={hook.failure_policy === 'Fail' ? 'cfg-strict' : 'viz-dim'}>{hook.failure_policy}</td>
                    <td className="mono cfg-service">
                      {hook.service ?? 'external URL'}
                      {hook.service_exists === false && <div className="cfg-orphan">does not exist</div>}
                    </td>
                    <td className="cfg-rules mono">{hook.rules.join('; ') || '—'}</td>
                  </tr>
                ))}
              {data.webhooks.length === 0 && (
                <tr><td colSpan={6} className="viz-empty">No admission webhook is registered, or this identity may not read them.</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {target && (
        <KeyValuePanel
          kind={target.kind}
          name={target.item.name}
          namespace={data.namespace}
          keys={target.item.keys}
          immutable={target.item.immutable}
          managedBy={target.item.managed_by}
          canEdit={target.kind === 'Secret' ? canEditSecrets : canEditConfigMaps}
          onClose={() => setTarget(null)}
          onRead={(key) => onRead(target.kind, target.item.name, key)}
          onSave={async (key, value) => {
            await onSave(target.kind, target.item.name, key, value);
            onRefresh();
          }}
          onDelete={async (key) => {
            await onDelete(target.kind, target.item.name, key);
            onRefresh();
          }}
          notify={notify}
        />
      )}
    </div>
  );
}
