import { Fragment, useMemo, useState } from 'react';
import { ArrowRight, Globe, Lock, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { SeverityBadge, StatTile } from '../cluster/charts';
import {
  NETWORK_VIEWS, formatPorts, viewCount,
  type EndpointsInfo, type EndpointSliceInfo, type IngressClassInfo, type IngressInfo,
  type NetworkOverview, type NetworkPolicyInfo, type NetworkView, type ServiceInfo,
} from '../../types/network';
import './network.css';

type Props = {
  data: NetworkOverview | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
};

export function NetworkPage({ data, loading, error, onRefresh }: Props) {
  const [view, setView] = useState<NetworkView>('Services');
  const [filter, setFilter] = useState('');
  const [openService, setOpenService] = useState<string | null>(null);

  const needle = filter.trim().toLowerCase();
  const match = <T extends { name: string }>(items: T[]): T[] =>
    needle ? items.filter((item) => item.name.toLowerCase().includes(needle)) : items;
  const services = useMemo(
    () => (needle ? (data?.services ?? []).filter((entry) => entry.name.toLowerCase().includes(needle)) : data?.services ?? []),
    [data, needle],
  );
  const ingresses = useMemo(
    () => (needle ? (data?.ingresses ?? []).filter((entry) => entry.name.toLowerCase().includes(needle)) : data?.ingresses ?? []),
    [data, needle],
  );

  if (error && !data) {
    return (
      <div className="viz-callout viz-callout-critical">
        <ShieldAlert size={18} aria-hidden />
        <div>
          <strong>Network resources could not be read.</strong>
          <p>{error}</p>
          <button type="button" className="viz-toggle" onClick={onRefresh}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="viz-empty viz-empty-page">{loading ? 'Reading network resources…' : 'Select Refresh to load.'}</div>;
  }

  const broken = data.services.filter((entry) => entry.health === 'critical').length;
  const brokenRoutes = data.ingresses.reduce(
    (total, ingress) => total + ingress.rules.filter((rule) => rule.problem).length,
    0,
  );
  const totalRoutes = data.ingresses.reduce((total, ingress) => total + ingress.rules.length, 0);

  return (
    <div className={`net-page${loading ? ' is-refreshing' : ''}`}>
      {data.degraded_collectors.length > 0 && (
        <div className="viz-callout viz-callout-warning">
          <ShieldAlert size={18} aria-hidden />
          <div>
            <strong>This view is partial.</strong>
            <ul>
              {data.degraded_collectors.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="net-kpis">
        <StatTile label="Services" value={String(data.services.length)} note={`namespace ${data.namespace}`} />
        <StatTile
          label="Without ready endpoints"
          value={String(broken)}
          severity={broken === 0 ? 'good' : 'critical'}
          note={broken === 0 ? 'All backed' : 'Requests will fail'}
        />
        <StatTile label="Ingress routes" value={String(totalRoutes)} note={`${data.ingresses.length} ingress(es)`} />
        <StatTile
          label="Routes that cannot serve"
          value={String(brokenRoutes)}
          severity={brokenRoutes === 0 ? 'good' : 'critical'}
          note={brokenRoutes === 0 ? 'All reachable' : 'Returning 503'}
        />
      </div>

      <FindingsPanel findings={data.findings} />

      <div className="net-toolbar">
        <div className="wl-switch net-switch">
          {NETWORK_VIEWS.map((entry) => (
            <button
              key={entry}
              type="button"
              className={view === entry ? 'is-active' : ''}
              onClick={() => setView(entry)}
            >
              {entry} <span className="viz-count">{viewCount(data, entry)}</span>
            </button>
          ))}
        </div>
        <div className="net-toolbar-right">
          <label className="wl-search">
            <Search size={14} aria-hidden />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={`Filter ${view.toLowerCase()}…`}
              aria-label={`Filter ${view.toLowerCase()}`}
            />
          </label>
          <button type="button" className="viz-toggle" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'is-spinning' : undefined} aria-hidden />
            Refresh
          </button>
        </div>
      </div>

      {view === 'Services' && <ServicesTable services={services} openService={openService} onToggle={setOpenService} />}
      {view === 'Endpoint Slices' && <SlicesTable slices={match(data.endpoint_slices)} />}
      {view === 'Endpoints' && <EndpointsTable endpoints={match(data.endpoints)} />}
      {view === 'Ingresses' && <IngressList ingresses={ingresses} />}
      {view === 'Ingress Classes' && <ClassesTable classes={match(data.ingress_classes)} />}
      {view === 'Network Policies' && <PoliciesTable policies={match(data.network_policies)} />}
    </div>
  );
}

function FindingsPanel({ findings }: { findings: NetworkOverview['findings'] }) {
  return (
    <section className="viz-card">
      <header className="viz-card-head">
        <div>
          <h3>Findings</h3>
          <p>Derived from the Services, their EndpointSlices, and the Ingress rules pointing at them.</p>
        </div>
        <span className="viz-count">{findings.length}</span>
      </header>
      <ul className="cluster-findings">
        {findings.map((finding) => (
          <li key={finding.title} className={`cluster-finding cluster-finding-${finding.severity}`}>
            <div className="cluster-finding-head">
              <SeverityBadge severity={finding.severity} />
              <strong>{finding.title}</strong>
              {finding.count > 0 && <span className="viz-count">{finding.count}</span>}
            </div>
            <p>{finding.detail}</p>
            {finding.targets.length > 0 && (
              <ul className="cluster-finding-targets">
                {finding.targets.map((target) => (
                  <li key={target} className="mono">
                    {target}
                  </li>
                ))}
              </ul>
            )}
            <small>{finding.hint}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ServicesTable({
  services,
  openService,
  onToggle,
}: {
  services: ServiceInfo[];
  openService: string | null;
  onToggle: (name: string | null) => void;
}) {
  if (services.length === 0) {
    return (
      <div className="viz-card">
        <div className="viz-empty">No Service matches.</div>
      </div>
    );
  }

  return (
    <section className="viz-card">
      <div className="viz-table-wrap">
        <table className="viz-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>State</th>
              <th>Type</th>
              <th>Cluster IP</th>
              <th>External</th>
              <th>Ports</th>
              <th>Endpoints</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            {services.map((service) => (
              // A keyed Fragment: the row and its expansion are siblings in tbody.
              <Fragment key={service.name}>
                <tr
                  className={openService === service.name ? 'is-selected' : ''}
                  onClick={() => onToggle(openService === service.name ? null : service.name)}
                >
                  <td className="mono">{service.name}</td>
                  <td>
                    <SeverityBadge severity={service.health} label={service.reason} />
                  </td>
                  <td>{service.service_type}</td>
                  <td className="mono">{service.cluster_ip}</td>
                  <td className="mono">{service.external_address ?? <span className="viz-dim">—</span>}</td>
                  <td className="mono net-ports">{formatPorts(service.ports)}</td>
                  <td>
                    {service.ready_endpoints}
                    <span className="viz-dim"> / {service.total_endpoints}</span>
                  </td>
                  <td>{service.age}</td>
                </tr>
                {openService === service.name && (
                  <tr className="net-expanded">
                    <td colSpan={8}>
                      <ServiceDetail service={service} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ServiceDetail({ service }: { service: ServiceInfo }) {
  return (
    <div className="net-detail">
      <div>
        <h4>Selector</h4>
        {service.selector.length === 0 ? (
          <p className="viz-dim">
            No selector. Endpoints for this Service are managed by hand or by another controller.
          </p>
        ) : (
          <ul className="cluster-finding-targets">
            {service.selector.map((entry) => (
              <li key={entry} className="mono">
                {entry}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4>
          Backing pods <span className="viz-count">{service.backing_pods.length}</span>
        </h4>
        {service.backing_pods.length === 0 ? (
          <p className="viz-dim">
            Nothing is behind this Service. Traffic to it fails at the connection, before reaching any container.
          </p>
        ) : (
          <div className="viz-table-wrap">
            <table className="viz-table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Pod</th>
                  <th>Node</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {service.backing_pods.map((pod) => (
                  <tr key={`${pod.address}-${pod.pod ?? ''}`}>
                    <td className="mono">{pod.address}</td>
                    <td className="mono">{pod.pod ?? '—'}</td>
                    <td>{pod.node ?? '—'}</td>
                    <td>
                      <SeverityBadge
                        severity={pod.terminating ? 'warning' : pod.ready ? 'good' : 'critical'}
                        label={pod.terminating ? 'Terminating' : pod.ready ? 'Ready' : 'Not ready'}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function IngressList({ ingresses }: { ingresses: IngressInfo[] }) {
  if (ingresses.length === 0) {
    return (
      <div className="viz-card">
        <div className="viz-empty">No Ingress matches.</div>
      </div>
    );
  }

  return (
    <div className="net-ingresses">
      {ingresses.map((ingress) => (
        <section className="viz-card" key={ingress.name}>
          <header className="viz-card-head">
            <div>
              <h3 className="mono">{ingress.name}</h3>
              <p>
                class {ingress.class} · {ingress.address ?? 'no address assigned'} · {ingress.age}
              </p>
            </div>
            <SeverityBadge severity={ingress.health} label={ingress.reason} />
          </header>

          {ingress.rules.length === 0 ? (
            <div className="viz-empty">This Ingress declares no routing rules.</div>
          ) : (
            <ul className="net-routes">
              {ingress.rules.map((rule, index) => (
                <li key={`${rule.host}${rule.path}${index}`} className={rule.problem ? 'has-problem' : undefined}>
                  <div className="net-route-line">
                    <span className="net-host">
                      {rule.tls ? <Lock size={12} aria-hidden /> : <Globe size={12} aria-hidden />}
                      {rule.tls ? 'https' : 'http'}://{rule.host}
                      <em>{rule.path}</em>
                    </span>
                    <ArrowRight size={13} aria-hidden className="net-arrow" />
                    <span className="net-target mono">
                      {rule.service || 'no backend'}:{rule.port}
                    </span>
                    <SeverityBadge
                      severity={rule.problem ? 'critical' : 'good'}
                      label={rule.problem ? 'Broken' : 'Reachable'}
                    />
                  </div>
                  {rule.problem && <p className="net-problem">{rule.problem}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function EmptyCard({ label }: { label: string }) {
  return (
    <div className="viz-card">
      <div className="viz-empty">No {label} in this namespace.</div>
    </div>
  );
}

function SlicesTable({ slices }: { slices: EndpointSliceInfo[] }) {
  if (slices.length === 0) return <EmptyCard label="EndpointSlice" />;

  return (
    <section className="viz-card">
      <header className="viz-card-head">
        <div>
          <h3>Endpoint Slices</h3>
          <p>What kube-proxy actually programs. A Service with no ready endpoint here cannot serve, whatever its own definition says.</p>
        </div>
      </header>
      <div className="viz-table-wrap">
        <table className="viz-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>State</th>
              <th>Service</th>
              <th>Address type</th>
              <th>Ports</th>
              <th>Ready</th>
              <th>Addresses</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            {slices.map((slice) => (
              <tr key={slice.name}>
                <td className="mono">{slice.name}</td>
                <td>
                  <SeverityBadge
                    severity={slice.health}
                    label={slice.total === 0 ? 'Empty' : `${slice.ready}/${slice.total} ready`}
                  />
                </td>
                <td className="mono">{slice.service ?? <span className="viz-dim">unlinked</span>}</td>
                <td>{slice.address_type}</td>
                <td className="mono net-ports">{slice.ports.join(', ') || '—'}</td>
                <td>
                  {slice.ready}
                  <span className="viz-dim"> / {slice.total}</span>
                </td>
                <td className="mono net-ports">
                  {slice.endpoints.map((endpoint) => endpoint.address).join(', ') || '—'}
                </td>
                <td>{slice.age}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EndpointsTable({ endpoints }: { endpoints: EndpointsInfo[] }) {
  if (endpoints.length === 0) return <EmptyCard label="Endpoints object" />;

  return (
    <section className="viz-card">
      <header className="viz-card-head">
        <div>
          <h3>Endpoints</h3>
          <p>The original core/v1 object. Superseded by EndpointSlice, still written by the control plane and still read by some older controllers.</p>
        </div>
      </header>
      <div className="viz-table-wrap">
        <table className="viz-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>State</th>
              <th>Ready addresses</th>
              <th>Not ready</th>
              <th>Ports</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((entry) => (
              <tr key={entry.name}>
                <td className="mono">{entry.name}</td>
                <td>
                  <SeverityBadge
                    severity={entry.health}
                    label={entry.addresses.length === 0 ? 'No addresses' : `${entry.addresses.length} ready`}
                  />
                </td>
                <td className="mono net-ports">{entry.addresses.join(', ') || '—'}</td>
                <td className="mono net-ports">
                  {entry.not_ready_addresses.length === 0 ? (
                    <span className="viz-dim">—</span>
                  ) : (
                    entry.not_ready_addresses.join(', ')
                  )}
                </td>
                <td className="mono">{entry.ports.join(', ') || '—'}</td>
                <td>{entry.age}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ClassesTable({ classes }: { classes: IngressClassInfo[] }) {
  if (classes.length === 0) {
    return (
      <div className="viz-card">
        <div className="viz-empty">
          No IngressClass exists in this cluster. Without one, an Ingress has no controller to claim it.
        </div>
      </div>
    );
  }

  return (
    <section className="viz-card">
      <header className="viz-card-head">
        <div>
          <h3>Ingress Classes</h3>
          <p>Cluster-scoped. An Ingress that names no class falls to the default, and none exists if no class is marked as one.</p>
        </div>
      </header>
      <div className="viz-table-wrap">
        <table className="viz-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Controller</th>
              <th>Default</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            {classes.map((entry) => (
              <tr key={entry.name}>
                <td className="mono">{entry.name}</td>
                <td className="mono">{entry.controller}</td>
                <td>{entry.is_default ? <SeverityBadge severity="good" label="Default" /> : <span className="viz-dim">—</span>}</td>
                <td>{entry.age}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PoliciesTable({ policies }: { policies: NetworkPolicyInfo[] }) {
  if (policies.length === 0) {
    return (
      <div className="viz-card">
        <div className="viz-empty">
          No NetworkPolicy in this namespace. Every pod here accepts traffic from anywhere in the cluster.
        </div>
      </div>
    );
  }

  return (
    <section className="viz-card">
      <header className="viz-card-head">
        <div>
          <h3>Network Policies</h3>
          <p>
            Naming a policy type without giving it rules is what denies all traffic in that direction, and an empty pod
            selector covers every pod in the namespace rather than none.
          </p>
        </div>
      </header>
      <div className="viz-table-wrap">
        <table className="viz-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Applies to</th>
              <th>Types</th>
              <th>Effect</th>
              <th>Rules</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            {policies.map((policy) => (
              <tr key={policy.name}>
                <td className="mono">{policy.name}</td>
                <td>
                  {policy.applies_to_all ? (
                    <SeverityBadge severity="warning" label="Every pod" />
                  ) : (
                    <span className="mono net-ports">{policy.pod_selector.join(', ')}</span>
                  )}
                </td>
                <td>{policy.policy_types.join(', ') || <span className="viz-dim">none</span>}</td>
                <td>{policy.effect}</td>
                <td>
                  {policy.ingress_rules} in / {policy.egress_rules} out
                </td>
                <td>{policy.age}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
