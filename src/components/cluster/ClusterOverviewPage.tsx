import { useMemo, useState } from 'react';
import {
  Activity, Boxes, Cpu, FileText, Gauge, Layers, MapPin, MemoryStick, RefreshCw, Server, ShieldAlert, X,
} from 'lucide-react';
import {
  CapacityAxis, ChartCard, DataTable, HealthRing, RankedBars, SeverityBadge,
  SignalMeter, StackedBar, StatTile, TableToggle,
} from './charts';
import type { LegendEntry } from './charts';
import { formatBytes, formatCount, formatCpu, formatPercent, formatRelative, percent, shortNodeName } from '../../lib/format';
import type { ClusterOverview, NodeAction, NodeInfo, NodeTaint, Severity } from '../../types/cluster';

const SERIES_USED = 'var(--series-1)';
const SERIES_REQUESTED = 'var(--series-2)';
const SERIES_LIMITS = 'var(--series-3)';

export type NodeCapabilities = { cordon: boolean; drain: boolean; delete: boolean };

type Props = {
  data: ClusterOverview | null;
  loading: boolean;
  error: string;
  capabilities: NodeCapabilities;
  onRefresh: () => void;
  onNodeAction: (action: NodeAction, nodeName: string) => void;
  onGenerateReport: () => void;
  generatingReport: boolean;
};

function healthSeverity(score: number): Severity {
  if (score >= 90) return 'good';
  if (score >= 75) return 'warning';
  if (score >= 50) return 'serious';
  return 'critical';
}

export function ClusterOverviewPage({
  data,
  loading,
  error,
  capabilities,
  onRefresh,
  onNodeAction,
  onGenerateReport,
  generatingReport,
}: Props) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [showUtilisationTable, setShowUtilisationTable] = useState(false);
  const [showZoneTable, setShowZoneTable] = useState(false);
  const [nodeFilter, setNodeFilter] = useState('');

  const nodes = data?.nodes ?? [];
  const activeNode = useMemo(() => nodes.find((node) => node.name === selectedNode) ?? null, [nodes, selectedNode]);
  const filteredNodes = useMemo(() => {
    const needle = nodeFilter.trim().toLowerCase();
    if (!needle) return nodes;
    return nodes.filter((node) =>
      [node.name, node.zone, node.instance_type, node.node_pool ?? '', node.capacity_type, ...node.taints.map((taint) => taint.label)]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [nodes, nodeFilter]);

  if (error && !data) {
    return (
      <div className="cluster-page">
        <div className="viz-callout viz-callout-critical">
          <ShieldAlert size={18} aria-hidden />
          <div>
            <strong>The cluster overview could not be loaded.</strong>
            <p>{error}</p>
            <button type="button" className="viz-toggle" onClick={onRefresh}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="cluster-page">
        <div className="viz-empty viz-empty-page">{loading ? 'Reading cluster state…' : 'Select Refresh to load the cluster overview.'}</div>
      </div>
    );
  }

  const { control_plane: plane, health, capacity, pods, workloads, distribution, events, findings } = data;
  const severity = healthSeverity(health.score);
  const readyNodes = nodes.filter((node) => node.ready).length;
  const degradedWorkloads = workloads.deployments.degraded + workloads.statefulsets.degraded + workloads.daemonsets.degraded;
  const totalWorkloads = workloads.deployments.total + workloads.statefulsets.total + workloads.daemonsets.total;

  const utilisationNodes = [...filteredNodes]
    .sort((left, right) => cpuUtilisation(right) - cpuUtilisation(left))
    .slice(0, 14);

  const phaseColors: Record<string, string> = {
    Running: 'var(--status-good)',
    Pending: 'var(--status-warning)',
    Failed: 'var(--status-critical)',
    Unknown: 'var(--status-serious)',
    Succeeded: 'var(--viz-neutral-fill)',
  };

  // The legend may only name series the chart actually draws — without
  // metrics-server there is no live-usage row, so there is no live-usage key.
  const capacityLegend: LegendEntry[] = [
    ...(plane.metrics_available ? [{ label: 'Live usage', color: SERIES_USED }] : []),
    { label: 'Requested', color: SERIES_REQUESTED },
    { label: 'Limits', color: SERIES_LIMITS },
  ];

  return (
    <div className={`cluster-page${loading ? ' is-refreshing' : ''}`}>
      <IdentityStrip
        data={data}
        onRefresh={onRefresh}
        loading={loading}
        onGenerateReport={onGenerateReport}
        generatingReport={generatingReport}
      />

      {data.degraded_collectors.length > 0 && (
        <div className="viz-callout viz-callout-warning">
          <ShieldAlert size={18} aria-hidden />
          <div>
            <strong>This overview is partial.</strong>
            <ul>
              {data.degraded_collectors.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <section className="cluster-hero">
        <div className="cluster-hero-score">
          <HealthRing score={health.score} severity={severity} grade={health.grade} />
          <div className="cluster-hero-verdict">
            <SeverityBadge severity={severity} label={health.grade} />
            <p>{health.headline}</p>
            <small>
              Composite of {health.signals.length} weighted signals · read at {formatRelative(data.generated_at)}
            </small>
          </div>
        </div>
        <div className="cluster-hero-signals">
          {health.signals.map((signal) => (
            <SignalMeter
              key={signal.name}
              name={signal.name}
              score={signal.score}
              severity={signal.severity}
              detail={signal.detail}
              weight={signal.weight}
            />
          ))}
        </div>
      </section>

      <div className="cluster-kpis">
        <StatTile
          label="Nodes ready"
          value={`${readyNodes}/${nodes.length}`}
          severity={readyNodes === nodes.length ? 'good' : 'critical'}
          note={readyNodes === nodes.length ? 'All Ready' : `${nodes.length - readyNodes} NotReady`}
        />
        <StatTile
          label="Pods ready"
          value={`${formatCount(pods.ready)}/${formatCount(pods.total - pods.succeeded)}`}
          severity={pods.ready >= pods.total - pods.succeeded ? 'good' : 'warning'}
          note={`${formatCount(pods.total)} total`}
        />
        <StatTile
          label="CPU requested"
          value={formatPercent(percent(capacity.cpu.requested, capacity.cpu.allocatable))}
          note={`${formatCpu(capacity.cpu.requested)} of ${formatCpu(capacity.cpu.allocatable)}`}
        />
        <StatTile
          label="Memory requested"
          value={formatPercent(percent(capacity.memory.requested, capacity.memory.allocatable))}
          note={`${formatBytes(capacity.memory.requested)} of ${formatBytes(capacity.memory.allocatable)}`}
        />
        <StatTile
          label="Container restarts"
          value={formatCount(pods.total_restarts)}
          severity={pods.total_restarts === 0 ? 'good' : pods.total_restarts > 50 ? 'serious' : 'warning'}
          note={`${pods.top_restarts.length} pod(s) affected`}
        />
        <StatTile
          label="Warning events"
          value={formatCount(events.warning_count)}
          severity={events.warning_count === 0 ? 'good' : 'warning'}
          note={events.truncated ? 'capped at 500' : 'cluster-wide'}
        />
        <StatTile
          label="Degraded workloads"
          value={`${degradedWorkloads}/${totalWorkloads}`}
          severity={degradedWorkloads === 0 ? 'good' : 'serious'}
          note={degradedWorkloads === 0 ? 'At desired replicas' : 'Below desired'}
        />
        <StatTile
          label="Pod slots"
          value={`${capacity.pod_slots.used}/${capacity.pod_slots.allocatable}`}
          note={formatPercent(percent(capacity.pod_slots.used, capacity.pod_slots.allocatable))}
        />
      </div>

      <FindingsPanel findings={findings} />

      <div className="cluster-grid-2">
        <ChartCard
          title="CPU capacity"
          subtitle="Requests reserve capacity whether or not it is consumed."
          legend={capacityLegend}
        >
          <CapacityAxis
            allocatable={capacity.cpu.allocatable}
            format={formatCpu}
            rows={[
              ...(capacity.cpu.used !== undefined
                ? [{ key: 'used', label: 'Live usage', value: capacity.cpu.used, color: SERIES_USED }]
                : []),
              { key: 'requested', label: 'Requested', value: capacity.cpu.requested, color: SERIES_REQUESTED },
              { key: 'limits', label: 'Limits', value: capacity.cpu.limits, color: SERIES_LIMITS },
            ]}
          />
        </ChartCard>

        <ChartCard
          title="Memory capacity"
          subtitle="A limits bar past the allocatable rule means the cluster is overcommitted."
          legend={capacityLegend}
        >
          <CapacityAxis
            allocatable={capacity.memory.allocatable}
            format={formatBytes}
            rows={[
              ...(capacity.memory.used !== undefined
                ? [{ key: 'used', label: 'Live usage', value: capacity.memory.used, color: SERIES_USED }]
                : []),
              { key: 'requested', label: 'Requested', value: capacity.memory.requested, color: SERIES_REQUESTED },
              { key: 'limits', label: 'Limits', value: capacity.memory.limits, color: SERIES_LIMITS },
            ]}
          />
        </ChartCard>
      </div>

      <ChartCard
        title="Node utilisation"
        subtitle={
          plane.metrics_available
            ? 'Live CPU usage and reserved CPU requests, both as a share of the node’s allocatable CPU.'
            : 'Reserved CPU requests as a share of allocatable CPU. metrics-server is unavailable, so live usage is not plotted.'
        }
        legend={
          plane.metrics_available
            ? [
                { label: 'Live usage', color: SERIES_USED },
                { label: 'Requested', color: SERIES_REQUESTED },
              ]
            : undefined
        }
        action={<TableToggle open={showUtilisationTable} onToggle={() => setShowUtilisationTable((value) => !value)} />}
        empty={utilisationNodes.length === 0 ? 'No nodes matched the current filter.' : undefined}
      >
        {showUtilisationTable ? (
          <DataTable
            columns={['Node', 'Zone', 'CPU used', 'CPU requested', 'Allocatable CPU', 'Memory used', 'Memory requested']}
            rows={utilisationNodes.map((node) => [
              node.name,
              node.zone,
              formatCpu(node.cpu_used_milli),
              formatCpu(node.cpu_requested_milli),
              formatCpu(node.cpu_allocatable_milli),
              formatBytes(node.memory_used_bytes),
              formatBytes(node.memory_requested_bytes),
            ])}
          />
        ) : (
          <RankedBars
            max={100}
            // Without metrics the plotted measure is requests, which is orange everywhere else.
            primaryColor={plane.metrics_available ? SERIES_USED : SERIES_REQUESTED}
            formatValue={(value) => formatPercent(value)}
            items={utilisationNodes.map((node) => ({
              key: node.name,
              label: shortNodeName(node.name),
              value: plane.metrics_available ? cpuUtilisation(node) : percent(node.cpu_requested_milli, node.cpu_allocatable_milli),
              secondary: plane.metrics_available ? percent(node.cpu_requested_milli, node.cpu_allocatable_milli) : undefined,
              // A node with no metrics reading is reported as unmeasured, not as zero.
              valueLabel: plane.metrics_available && node.cpu_used_milli === undefined ? 'no data' : undefined,
              onClick: () => setSelectedNode(node.name),
              trailing: <SeverityBadge severity={node.health} />,
              tooltip: (
                <>
                  <strong>{node.name}</strong>
                  <span>
                    CPU {formatCpu(node.cpu_used_milli)} used · {formatCpu(node.cpu_requested_milli)} requested ·{' '}
                    {formatCpu(node.cpu_allocatable_milli)} allocatable
                  </span>
                  <span>
                    Memory {formatBytes(node.memory_used_bytes)} used · {formatBytes(node.memory_requested_bytes)} requested
                  </span>
                  <span>
                    {node.pod_count} pods · {node.instance_type} · {node.zone}
                  </span>
                </>
              ),
            }))}
          />
        )}
      </ChartCard>

      <div className="cluster-grid-3">
        <ChartCard
          title="Availability Zones"
          subtitle="Node placement across AZs. A single-AZ fleet fails together."
          legend={[
            { label: 'Ready', color: 'var(--status-good)' },
            { label: 'Not Ready', color: 'var(--status-critical)' },
          ]}
          action={<TableToggle open={showZoneTable} onToggle={() => setShowZoneTable((value) => !value)} />}
          empty={distribution.zones.length === 0 ? 'No zone labels are present on these nodes.' : undefined}
        >
          {showZoneTable ? (
            <DataTable
              columns={['Zone', 'Nodes', 'Ready', 'Pods', 'Allocatable CPU', 'Allocatable memory']}
              rows={distribution.zones.map((zone) => [
                zone.zone,
                zone.nodes,
                zone.ready_nodes,
                zone.pods,
                formatCpu(zone.cpu_allocatable_milli),
                formatBytes(zone.memory_allocatable_bytes),
              ])}
            />
          ) : (
            <div className="viz-stack-list">
              {distribution.zones.map((zone) => (
                <div className="viz-stack-line" key={zone.zone}>
                  <div className="viz-stack-line-head">
                    <span>
                      <MapPin size={12} aria-hidden /> {zone.zone}
                    </span>
                    <strong>{zone.nodes} nodes</strong>
                  </div>
                  <StackedBar
                    total={zone.nodes}
                    formatValue={(value) => `${value} node(s)`}
                    segments={[
                      { key: 'ready', label: 'Ready', value: zone.ready_nodes, color: 'var(--status-good)' },
                      { key: 'notready', label: 'Not Ready', value: zone.nodes - zone.ready_nodes, color: 'var(--status-critical)' },
                    ]}
                  />
                  <small>
                    {zone.pods} pods · {formatCpu(zone.cpu_allocatable_milli)} · {formatBytes(zone.memory_allocatable_bytes)}
                  </small>
                </div>
              ))}
            </div>
          )}
        </ChartCard>

        <ChartCard
          title="Pod phases"
          subtitle={`${formatCount(pods.total)} pods across every namespace the current identity can read.`}
          legend={pods.by_phase.map((bucket) => ({
            label: bucket.label,
            color: phaseColors[bucket.label] ?? 'var(--viz-neutral-fill)',
          }))}
          empty={pods.total === 0 ? 'No pods were returned.' : undefined}
        >
          <StackedBar
            total={pods.total}
            formatValue={(value) => `${value} pod(s)`}
            segments={pods.by_phase.map((bucket) => ({
              key: bucket.label,
              label: bucket.label,
              value: bucket.value,
              color: phaseColors[bucket.label] ?? 'var(--viz-neutral-fill)',
            }))}
          />
          <DataTable
            columns={['Phase', 'Pods', 'Share']}
            rows={pods.by_phase.map((bucket) => [
              bucket.label,
              bucket.value,
              formatPercent(percent(bucket.value, pods.total)),
            ])}
          />
        </ChartCard>

        <ChartCard
          title="Fleet composition"
          subtitle="Capacity type, instance mix, taints, and node pools — all read from the nodes themselves."
          legend={
            distribution.capacity_types.length > 1
              ? distribution.capacity_types.map((bucket, index) => ({
                  label: bucket.label,
                  color: capacityTypeColor(index),
                }))
              : undefined
          }
          empty={nodes.length === 0 ? 'No nodes are visible to the current identity.' : undefined}
        >
          <div className="viz-subgroup">
            <h4>Capacity type</h4>
            <StackedBar
              total={nodes.length}
              formatValue={(value) => `${value} node(s)`}
              segments={distribution.capacity_types.map((bucket, index) => ({
                key: bucket.label,
                label: bucket.label,
                value: bucket.value,
                color: capacityTypeColor(index),
              }))}
            />
          </div>
          <div className="viz-subgroup">
            <h4>Nodes per instance type</h4>
            <RankedBars
              labelWidth={110}
              max={Math.max(...distribution.instance_types.map((bucket) => bucket.value), 1)}
              formatValue={(value) => String(value)}
              items={distribution.instance_types.map((bucket) => ({
                key: bucket.label,
                label: bucket.label,
                value: bucket.value,
                tooltip: (
                  <>
                    <strong>{bucket.label}</strong>
                    <span>{bucket.value} node(s)</span>
                  </>
                ),
              }))}
            />
          </div>
          {distribution.taints.length > 0 && (
            <div className="viz-subgroup">
              <h4>Nodes per taint</h4>
              <RankedBars
                labelWidth={150}
                max={Math.max(...distribution.taints.map((bucket) => bucket.value), 1)}
                formatValue={(value) => String(value)}
                items={distribution.taints.map((bucket) => {
                  // `key=value:Effect` — neither a key nor a value may contain a colon,
                  // so the last one always separates the effect. It rides outside the
                  // label so two taints on the same key stay distinguishable when the
                  // label truncates.
                  const split = bucket.label.lastIndexOf(':');
                  const name = split === -1 ? bucket.label : bucket.label.slice(0, split);
                  const effect = split === -1 ? '' : bucket.label.slice(split + 1);
                  return {
                    key: bucket.label,
                    label: name,
                    value: bucket.value,
                    trailing: effect ? <em className="cluster-effect-tag">{effect}</em> : undefined,
                    tooltip: (
                      <>
                        <strong>{bucket.label}</strong>
                        <span>{bucket.value} node(s) carry this taint</span>
                        <span>Only pods with a matching toleration schedule there.</span>
                      </>
                    ),
                  };
                })}
              />
            </div>
          )}
          {distribution.node_pools.length > 0 && (
            <div className="viz-subgroup">
              <h4>Nodes per node pool</h4>
              <RankedBars
                labelWidth={110}
                max={Math.max(...distribution.node_pools.map((bucket) => bucket.value), 1)}
                formatValue={(value) => String(value)}
                items={distribution.node_pools.map((bucket) => ({
                  key: bucket.label,
                  label: bucket.label,
                  value: bucket.value,
                  tooltip: (
                    <>
                      <strong>{bucket.label}</strong>
                      <span>{bucket.value} node(s)</span>
                    </>
                  ),
                }))}
              />
            </div>
          )}
        </ChartCard>
      </div>

      <div className="cluster-grid-2">
        <ChartCard
          title="Warning events by reason"
          subtitle="Kubernetes expires events after roughly an hour, so these are current."
          empty={events.by_reason.length === 0 ? 'No warning events are present in the cluster right now.' : undefined}
        >
          <RankedBars
            labelWidth={170}
            max={Math.max(...events.by_reason.map((bucket) => bucket.value), 1)}
            formatValue={(value) => formatCount(value)}
            items={events.by_reason.map((bucket) => ({
              key: bucket.label,
              label: bucket.label,
              value: bucket.value,
              tooltip: (
                <>
                  <strong>{bucket.label}</strong>
                  <span>{bucket.value} occurrence(s)</span>
                </>
              ),
            }))}
          />
        </ChartCard>

        <ChartCard
          title={plane.metrics_available ? 'Top CPU consumers' : 'Most-restarted pods'}
          subtitle={plane.metrics_available ? 'Live pod CPU against what each pod reserved.' : 'metrics-server is unavailable, so pods are ranked by restart count.'}
          legend={
            plane.metrics_available
              ? [
                  { label: 'Live usage', color: SERIES_USED },
                  { label: 'Requested', color: SERIES_REQUESTED },
                ]
              : undefined
          }
          empty={
            (plane.metrics_available ? pods.top_cpu.length : pods.top_restarts.length) === 0
              ? 'Nothing to rank — no pod is consuming measurable CPU or restarting.'
              : undefined
          }
        >
          {plane.metrics_available ? (
            <RankedBars
              labelWidth={180}
              max={Math.max(...pods.top_cpu.map((pod) => Math.max(pod.cpu_used_milli, pod.cpu_requested_milli)), 1)}
              formatValue={formatCpu}
              items={pods.top_cpu.map((pod) => ({
                key: `${pod.namespace}/${pod.name}`,
                label: pod.name,
                value: pod.cpu_used_milli,
                secondary: pod.cpu_requested_milli,
                tooltip: (
                  <>
                    <strong>{pod.name}</strong>
                    <span>namespace {pod.namespace}</span>
                    <span>
                      {formatCpu(pod.cpu_used_milli)} used · {formatCpu(pod.cpu_requested_milli)} requested
                    </span>
                  </>
                ),
              }))}
            />
          ) : (
            <RankedBars
              labelWidth={180}
              max={Math.max(...pods.top_restarts.map((pod) => pod.restarts), 1)}
              formatValue={(value) => String(value)}
              items={pods.top_restarts.map((pod) => ({
                key: `${pod.namespace}/${pod.name}`,
                label: pod.name,
                value: pod.restarts,
                trailing: <SeverityBadge severity={pod.severity} />,
                tooltip: (
                  <>
                    <strong>{pod.name}</strong>
                    <span>namespace {pod.namespace}</span>
                    <span>{pod.restarts} restart(s) · {pod.phase}</span>
                  </>
                ),
              }))}
            />
          )}
        </ChartCard>
      </div>

      {pods.problems.length > 0 && (
        <section className="viz-card">
          <header className="viz-card-head">
            <div>
              <h3>Pods needing attention</h3>
              <p>The reason column is the container’s own reported state, not an inference.</p>
            </div>
            <span className="viz-count">{pods.problems.length}</span>
          </header>
          <DataTable
            columns={['Severity', 'Pod', 'Namespace', 'Node', 'Reason', 'Restarts', 'Age']}
            rows={pods.problems.map((pod) => [
              <SeverityBadge severity={pod.severity} key="severity" />,
              <span className="mono" key="name" title={pod.message ?? undefined}>
                {pod.name}
              </span>,
              pod.namespace,
              pod.node ? shortNodeName(pod.node) : '—',
              pod.reason,
              pod.restarts,
              pod.age,
            ])}
          />
        </section>
      )}

      <section className="viz-card">
        <header className="viz-card-head">
          <div>
            <h3>Nodes</h3>
            <p>Select a node to inspect its conditions, its pods, and the operations available to you.</p>
          </div>
          <input
            className="viz-filter"
            placeholder="Filter by name, zone, instance, node pool…"
            value={nodeFilter}
            onChange={(event) => setNodeFilter(event.target.value)}
          />
        </header>
        {filteredNodes.length === 0 ? (
          <div className="viz-empty">No node matches this filter.</div>
        ) : (
          <div className="viz-table-wrap viz-table-scroll">
            <table className="viz-table">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Health</th>
                  <th>CPU</th>
                  <th>Memory</th>
                  <th>Pods</th>
                  <th>Taints</th>
                  <th>Instance</th>
                  <th>Capacity</th>
                  <th>Zone</th>
                  <th>Kubelet</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {filteredNodes.map((node) => (
                  <tr
                    key={node.name}
                    className={selectedNode === node.name ? 'is-selected' : ''}
                    onClick={() => setSelectedNode(node.name)}
                  >
                    <td className="mono">{node.name}</td>
                    <td>
                      <SeverityBadge
                        severity={node.health}
                        label={
                          !node.ready
                            ? 'NotReady'
                            : node.pressure
                              ? node.pressure_reasons.join(', ')
                              : node.unschedulable
                                ? 'Cordoned'
                                : 'Ready'
                        }
                      />
                    </td>
                    <td>
                      <MiniMeter
                        used={node.cpu_used_milli}
                        requested={node.cpu_requested_milli}
                        allocatable={node.cpu_allocatable_milli}
                        format={formatCpu}
                      />
                    </td>
                    <td>
                      <MiniMeter
                        used={node.memory_used_bytes}
                        requested={node.memory_requested_bytes}
                        allocatable={node.memory_allocatable_bytes}
                        format={formatBytes}
                      />
                    </td>
                    <td>
                      {node.pod_count}
                      <span className="viz-dim"> / {node.pod_capacity}</span>
                    </td>
                    <td title={node.taints.map((taint) => taint.label).join('\n') || undefined}>
                      {node.taints.length === 0 ? (
                        <span className="viz-dim">—</span>
                      ) : (
                        <span className="cluster-taint-count">
                          {node.taints.length}
                          {node.taints.some((taint) => taint.effect === 'NoExecute') && <em>NoExecute</em>}
                        </span>
                      )}
                    </td>
                    <td>{node.instance_type}</td>
                    <td>{node.capacity_type === 'UNKNOWN' ? '—' : node.capacity_type}</td>
                    <td>{node.zone}</td>
                    <td>{node.kubelet_version}</td>
                    <td>{node.age}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {activeNode && (
        <NodeDetail
          node={activeNode}
          capabilities={capabilities}
          onAction={onNodeAction}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}

/**
 * Resource charts keep a fixed palette — blue is live usage, orange is reserved
 * (requests), aqua is limits — so a colour never changes meaning between cards.
 * Capacity type is identity rather than a resource, so it starts at slot 2 and
 * cannot be mistaken for a live-usage bar in a neighbouring chart.
 */
function capacityTypeColor(index: number): string {
  return `var(--series-${(index % 2) + 2})`;
}

/**
 * A taint is configuration, not health, so it never wears the reserved status
 * palette. The effect carries its own weight instead: NoExecute evicts pods that
 * are already running, NoSchedule only blocks new ones, PreferNoSchedule is a hint.
 */
function TaintList({ taints }: { taints: NodeTaint[] }) {
  if (taints.length === 0) {
    return <p className="viz-dim cluster-taints-empty">No taints. Every pod that tolerates nothing can still schedule here.</p>;
  }
  return (
    <ul className="cluster-taints">
      {taints.map((taint) => (
        <li key={taint.label} className={`cluster-taint cluster-taint-${taint.effect.toLowerCase()}`}>
          <code>
            {taint.key}
            {taint.value ? <span className="cluster-taint-value">={taint.value}</span> : null}
          </code>
          <em>{taint.effect}</em>
        </li>
      ))}
    </ul>
  );
}

function cpuUtilisation(node: NodeInfo): number {
  return percent(node.cpu_used_milli ?? 0, node.cpu_allocatable_milli);
}

function MiniMeter({
  used,
  requested,
  allocatable,
  format,
}: {
  used?: number;
  requested: number;
  allocatable: number;
  format: (value: number) => string;
}) {
  const usedShare = used === undefined ? undefined : percent(used, allocatable);
  const requestedShare = percent(requested, allocatable);
  return (
    <div className="viz-mini">
      <div className="viz-track viz-track-thin">
        <div className="viz-bar" style={{ width: `${Math.min(usedShare ?? requestedShare, 100)}%`, background: usedShare === undefined ? SERIES_REQUESTED : SERIES_USED }} />
      </div>
      <span>
        {usedShare === undefined ? `${formatPercent(requestedShare)} req` : `${formatPercent(usedShare)} · ${formatPercent(requestedShare)} req`}
      </span>
      <small>{format(allocatable)}</small>
    </div>
  );
}

function IdentityStrip({
  data,
  onRefresh,
  loading,
  onGenerateReport,
  generatingReport,
}: {
  data: ClusterOverview;
  onRefresh: () => void;
  loading: boolean;
  onGenerateReport: () => void;
  generatingReport: boolean;
}) {
  const plane = data.control_plane;
  const chips: { icon: React.ReactNode; label: string; value: string }[] = [
    { icon: <Server size={13} />, label: 'Distribution', value: plane.distribution },
    { icon: <Layers size={13} />, label: 'Version', value: plane.kubernetes_version },
  ];
  if (plane.cluster_name) chips.push({ icon: <Boxes size={13} />, label: 'Cluster', value: plane.cluster_name });
  if (plane.region) chips.push({ icon: <MapPin size={13} />, label: 'Region', value: plane.region });
  if (plane.account_id && plane.account_label) {
    chips.push({ icon: <Boxes size={13} />, label: plane.account_label, value: plane.account_id });
  }
  if (plane.provider_version) chips.push({ icon: <Gauge size={13} />, label: 'Platform', value: plane.provider_version });
  if (plane.provider_status) chips.push({ icon: <Activity size={13} />, label: 'Status', value: plane.provider_status });
  chips.push({ icon: <Cpu size={13} />, label: 'Metrics', value: plane.metrics_available ? 'metrics-server' : 'unavailable' });
  if (plane.oidc_issuer) chips.push({ icon: <MemoryStick size={13} />, label: 'OIDC', value: 'configured' });

  return (
    <section className="cluster-identity">
      <div className="cluster-identity-chips">
        {chips.map((chip) => (
          <span className="cluster-chip" key={chip.label}>
            {chip.icon}
            <em>{chip.label}</em>
            <strong>{chip.value}</strong>
          </span>
        ))}
      </div>
      <div className="cluster-identity-actions">
        <code title={plane.endpoint}>{plane.endpoint}</code>
        <button type="button" className="viz-toggle" onClick={onGenerateReport} disabled={generatingReport || loading}>
          <FileText size={14} aria-hidden />
          {generatingReport ? 'Building…' : 'Generate report'}
        </button>
        <button type="button" className="viz-primary" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'is-spinning' : undefined} aria-hidden />
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </div>
    </section>
  );
}

function FindingsPanel({ findings }: { findings: ClusterOverview['findings'] }) {
  return (
    <section className="viz-card">
      <header className="viz-card-head">
        <div>
          <h3>Findings</h3>
          <p>Derived from collected evidence only. Nothing here is asserted without a source signal.</p>
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

function NodeDetail({
  node,
  capabilities,
  onAction,
  onClose,
}: {
  node: NodeInfo;
  capabilities: NodeCapabilities;
  onAction: (action: NodeAction, nodeName: string) => void;
  onClose: () => void;
}) {
  const noPermission = !capabilities.cordon && !capabilities.drain && !capabilities.delete;

  return (
    <section className="viz-card cluster-node-detail">
      <header className="viz-card-head">
        <div>
          <h3 className="mono">{node.name}</h3>
          <p>
            {node.roles.join(', ')} · {node.instance_type} · {node.zone}
            {node.node_pool ? ` · node pool ${node.node_pool}` : ''}
          </p>
        </div>
        <div className="cluster-node-actions">
          {capabilities.cordon && (
            <button type="button" className="viz-toggle" onClick={() => onAction(node.unschedulable ? 'uncordon' : 'cordon', node.name)}>
              {node.unschedulable ? 'Uncordon' : 'Cordon'}
            </button>
          )}
          {capabilities.drain && (
            <button type="button" className="viz-toggle" onClick={() => onAction('drain', node.name)}>
              Drain
            </button>
          )}
          {capabilities.delete && (
            <button type="button" className="viz-toggle viz-danger" onClick={() => onAction('delete', node.name)}>
              Delete
            </button>
          )}
          {noPermission && <span className="viz-dim">Kubernetes denied node write access</span>}
          <button type="button" className="viz-icon" onClick={onClose} aria-label="Close node details">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="cluster-node-body">
        <div className="cluster-node-column">
          <h4>Capacity</h4>
          <CapacityAxis
            allocatable={node.cpu_allocatable_milli}
            format={formatCpu}
            rows={[
              ...(node.cpu_used_milli !== undefined
                ? [{ key: 'used', label: 'CPU used', value: node.cpu_used_milli, color: SERIES_USED }]
                : []),
              { key: 'requested', label: 'CPU requested', value: node.cpu_requested_milli, color: SERIES_REQUESTED },
              { key: 'limits', label: 'CPU limits', value: node.cpu_limit_milli, color: SERIES_LIMITS },
            ]}
          />
          <CapacityAxis
            allocatable={node.memory_allocatable_bytes}
            format={formatBytes}
            rows={[
              ...(node.memory_used_bytes !== undefined
                ? [{ key: 'used', label: 'Memory used', value: node.memory_used_bytes, color: SERIES_USED }]
                : []),
              { key: 'requested', label: 'Memory requested', value: node.memory_requested_bytes, color: SERIES_REQUESTED },
              { key: 'limits', label: 'Memory limits', value: node.memory_limit_bytes, color: SERIES_LIMITS },
            ]}
          />
          <dl className="cluster-node-facts">
            <div>
              <dt>OS image</dt>
              <dd>{node.os_image}</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd>{node.container_runtime}</dd>
            </div>
            <div>
              <dt>Architecture</dt>
              <dd>{node.architecture}</dd>
            </div>
            <div>
              <dt>Capacity type</dt>
              <dd>{node.capacity_type === 'UNKNOWN' ? 'not labelled' : node.capacity_type}</dd>
            </div>
            <div>
              <dt>Node pool</dt>
              <dd>{node.node_pool ?? 'not labelled'}</dd>
            </div>
            <div>
              <dt>Age</dt>
              <dd>{node.age}</dd>
            </div>
          </dl>

          <div>
            <h4>
              Taints <span className="viz-count">{node.taints.length}</span>
            </h4>
            <TaintList taints={node.taints} />
          </div>
        </div>

        <div className="cluster-node-column">
          <h4>Conditions</h4>
          <ul className="cluster-conditions">
            {node.conditions.map((condition) => (
              <li key={condition.kind}>
                <SeverityBadge severity={condition.healthy ? 'good' : 'critical'} label={`${condition.kind}=${condition.status}`} />
                {condition.reason && <span>{condition.reason}</span>}
              </li>
            ))}
          </ul>

          <h4>
            Pods on this node <span className="viz-count">{node.pods.length}</span>
          </h4>
          {node.pods.length === 0 ? (
            <div className="viz-empty">No pods are currently assigned to this node.</div>
          ) : (
            <div className="viz-table-wrap viz-table-scroll">
              <table className="viz-table">
                <thead>
                  <tr>
                    <th>Pod</th>
                    <th>Namespace</th>
                    <th>Status</th>
                    <th>Restarts</th>
                    <th>CPU req</th>
                    <th>Mem req</th>
                  </tr>
                </thead>
                <tbody>
                  {node.pods.map((pod) => (
                    <tr key={`${pod.namespace}/${pod.name}`}>
                      <td className="mono">{pod.name}</td>
                      <td>{pod.namespace}</td>
                      <td>{pod.status}</td>
                      <td>{pod.restarts}</td>
                      <td>{formatCpu(pod.cpu_requested_milli)}</td>
                      <td>{formatBytes(pod.memory_requested_bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
