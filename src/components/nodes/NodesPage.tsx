import { useState } from 'react';
import { Ban, CircleCheck, RefreshCw, ShieldAlert, Trash2, Wind } from 'lucide-react';
import { SeverityBadge, StatTile } from '../cluster/charts';
import { formatBytes, formatCpu, percent, shortNodeName } from '../../lib/format';
import type { NodeAction, NodeInfo, ClusterOverview } from '../../types/cluster';
import type { NodeCapabilities } from '../cluster/ClusterOverviewPage';
import './nodes.css';

type Props = {
  data: ClusterOverview | null;
  loading: boolean;
  error: string;
  capabilities: NodeCapabilities;
  onRefresh: () => void;
  onNodeAction: (action: NodeAction, name: string) => void;
};

/**
 * The fleet, one node per row, with the taints and conditions that explain why
 * pods do or do not land there. Selection opens the node in full: every taint
 * as tolerations are written against it, every unhealthy condition with the
 * kubelet's own words, and the pods currently on the machine.
 */
export function NodesPage({ data, loading, error, capabilities, onRefresh, onNodeAction }: Props) {
  const [selected, setSelected] = useState('');
  const [filter, setFilter] = useState('');

  if (error && !data) {
    return (
      <div className="viz-callout viz-callout-critical">
        <ShieldAlert size={18} aria-hidden />
        <div>
          <strong>Nodes could not be read.</strong>
          <p>{error}</p>
          <button type="button" className="viz-toggle" onClick={onRefresh}>Try again</button>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="viz-empty viz-empty-page">{loading ? 'Reading nodes…' : 'Select Refresh to load.'}</div>;
  }

  const needle = filter.trim().toLowerCase();
  const nodes = needle
    ? data.nodes.filter((node) => node.name.toLowerCase().includes(needle) || node.zone.toLowerCase().includes(needle))
    : data.nodes;
  const detail = data.nodes.find((node) => node.name === selected) ?? null;

  const notReady = data.nodes.filter((node) => !node.ready).length;
  const cordoned = data.nodes.filter((node) => node.unschedulable).length;
  const pressured = data.nodes.filter((node) => node.pressure).length;
  const tainted = data.nodes.filter((node) => node.taints.length > 0).length;

  return (
    <div className={`nodes-page ${loading ? 'is-refreshing' : ''}`}>
      <div className="nodes-kpis">
        <StatTile
          label="Nodes"
          value={`${data.nodes.length - notReady}/${data.nodes.length}`}
          note={notReady > 0 ? `${notReady} not reporting Ready` : 'All reporting Ready'}
          severity={notReady > 0 ? 'critical' : 'good'}
        />
        <StatTile
          label="Cordoned"
          value={cordoned > 0 ? String(cordoned) : 'none'}
          note={cordoned > 0 ? 'Not accepting new pods' : 'Everything schedulable'}
          severity={cordoned > 0 ? 'warning' : 'good'}
        />
        <StatTile
          label="Under pressure"
          value={pressured > 0 ? String(pressured) : 'none'}
          note={pressured > 0 ? 'Memory, disk or PID pressure' : 'No kubelet pressure signals'}
          severity={pressured > 0 ? 'serious' : 'good'}
        />
        <StatTile
          label="Tainted"
          value={tainted > 0 ? String(tainted) : 'none'}
          note={tainted > 0 ? 'Only tolerating pods land there' : 'No taints anywhere'}
        />
      </div>

      <div className="nodes-toolbar">
        <p className="wl-lead nodes-lead">
          Selecting a node shows its taints, conditions and the pods on it — and that is where cordon, drain
          and delete live.
        </p>
        <div className="nodes-toolbar-right">
          <input
            className="wl-search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by name or zone…"
            aria-label="Filter nodes"
          />
          <button type="button" className="viz-toggle" onClick={onRefresh}>
            <RefreshCw size={13} aria-hidden /> Refresh
          </button>
        </div>
      </div>

      <table className="viz-table">
        <thead>
          <tr>
            <th>Node</th><th>State</th><th>Zone</th><th>Instance</th>
            <th>CPU</th><th>Memory</th><th>Pods</th><th>Taints</th><th>Age</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <tr
              key={node.name}
              className={`nodes-row ${node.name === selected ? 'is-selected' : ''}`}
              onClick={() => setSelected(node.name === selected ? '' : node.name)}
            >
              <td>
                <button type="button" className="cfg-link mono" title={node.name}>{shortNodeName(node.name)}</button>
                <div className="viz-dim nodes-roles">{node.roles.join(', ')} · {node.kubelet_version}</div>
              </td>
              <td>
                <SeverityBadge severity={node.health} label={node.ready ? 'Ready' : 'NotReady'} />
                {node.unschedulable && <div className="nodes-flag">cordoned</div>}
                {node.pressure_reasons.length > 0 && (
                  <div className="nodes-flag">{node.pressure_reasons.join(', ')}</div>
                )}
              </td>
              <td className="viz-dim">{node.zone}</td>
              <td>
                <span className="mono">{node.instance_type}</span>
                <div className="viz-dim nodes-roles">{node.capacity_type}{node.node_pool ? ` · ${node.node_pool}` : ''}</div>
              </td>
              <td>
                {formatCpu(node.cpu_used_milli)} <span className="viz-dim">/ {formatCpu(node.cpu_allocatable_milli)}</span>
              </td>
              <td>
                {formatBytes(node.memory_used_bytes)} <span className="viz-dim">/ {formatBytes(node.memory_allocatable_bytes)}</span>
              </td>
              <td className={percent(node.pod_count, node.pod_capacity) >= 90 ? 'nodes-full' : ''}>
                {node.pod_count}/{node.pod_capacity}
              </td>
              <td>
                {node.taints.length === 0
                  ? <span className="viz-dim">—</span>
                  : <span className="cfg-tag mono">{node.taints.length}</span>}
              </td>
              <td>{node.age}</td>
            </tr>
          ))}
          {nodes.length === 0 && <tr><td colSpan={9} className="viz-empty">No node matches.</td></tr>}
        </tbody>
      </table>

      {detail && (
        <section className="nodes-detail" aria-label={`Node ${detail.name}`}>
          <header className="nodes-detail-head">
            <div>
              <h3 className="mono">{detail.name}</h3>
              <p className="viz-dim">
                {detail.os_image} · {detail.architecture} · {detail.container_runtime}
              </p>
            </div>
            <div className="nodes-detail-actions">
              <button
                type="button"
                className="viz-toggle"
                disabled={!capabilities.cordon}
                title={
                  capabilities.cordon
                    ? detail.unschedulable
                      ? 'Let the scheduler place pods here again'
                      : 'Stop new pods from landing here; running pods stay'
                    : "You do not have permission to change nodes."
                }
                onClick={() => onNodeAction(detail.unschedulable ? 'uncordon' : 'cordon', detail.name)}
              >
                {detail.unschedulable ? <CircleCheck size={13} aria-hidden /> : <Ban size={13} aria-hidden />}
                {detail.unschedulable ? ' Uncordon' : ' Cordon'}
              </button>
              <button
                type="button"
                className="viz-toggle viz-danger"
                disabled={!capabilities.drain}
                title={
                  capabilities.drain
                    ? 'Cordon, then evict every pod. PodDisruptionBudgets are respected, never forced; daemonsets stay.'
                    : "You do not have permission to drain nodes."
                }
                onClick={() => onNodeAction('drain', detail.name)}
              >
                <Wind size={13} aria-hidden /> Drain
              </button>
              <button
                type="button"
                className="viz-toggle viz-danger"
                disabled={!capabilities.delete}
                title={
                  capabilities.delete
                    ? 'Remove the Node object. The machine itself belongs to the node group and may come back.'
                    : "You do not have permission to delete nodes."
                }
                onClick={() => onNodeAction('delete', detail.name)}
              >
                <Trash2 size={13} aria-hidden /> Delete
              </button>
            </div>
          </header>

          <div className="nodes-detail-grid">
            <div>
              <h4>Taints</h4>
              {detail.taints.length === 0 ? (
                <p className="viz-dim">None — every pod may land here.</p>
              ) : (
                <ul className="nodes-taints">
                  {detail.taints.map((taint) => (
                    <li key={taint.label}>
                      <code>{taint.label}</code>
                      <span className="viz-dim"> — {taint.effect === 'NoExecute'
                        ? 'evicts running pods without this toleration'
                        : taint.effect === 'NoSchedule'
                          ? 'blocks pods without this toleration'
                          : 'avoided when possible'}</span>
                    </li>
                  ))}
                </ul>
              )}

              <h4>Conditions</h4>
              <ul className="nodes-conditions">
                {detail.conditions.map((condition) => (
                  <li key={condition.kind} className={condition.healthy ? '' : 'nodes-condition-bad'}>
                    <span className="mono">{condition.kind}</span> {condition.status}
                    {!condition.healthy && condition.message && (
                      <div className="viz-dim">{condition.message}</div>
                    )}
                  </li>
                ))}
              </ul>

              <h4>Capacity</h4>
              <ul className="nodes-capacity">
                <li>CPU: {formatCpu(detail.cpu_used_milli)} used · {formatCpu(detail.cpu_requested_milli)} requested · {formatCpu(detail.cpu_allocatable_milli)} allocatable</li>
                <li>Memory: {formatBytes(detail.memory_used_bytes)} used · {formatBytes(detail.memory_requested_bytes)} requested · {formatBytes(detail.memory_allocatable_bytes)} allocatable</li>
                <li>Pods: {detail.pod_count} of {detail.pod_capacity}</li>
              </ul>
            </div>

            <div>
              <h4>Pods on this node ({detail.pods.length})</h4>
              <div className="nodes-pods-wrap">
                <table className="viz-table nodes-pods">
                  <thead>
                    <tr><th>Pod</th><th>Namespace</th><th>Status</th><th>Restarts</th><th>CPU req</th><th>Mem req</th></tr>
                  </thead>
                  <tbody>
                    {detail.pods.map((pod) => (
                      <tr key={`${pod.namespace}/${pod.name}`}>
                        <td className="mono nodes-pod-name">{pod.name}</td>
                        <td className="viz-dim">{pod.namespace}</td>
                        <td>{pod.status}</td>
                        <td className={pod.restarts > 0 ? 'nodes-full' : ''}>{pod.restarts}</td>
                        <td>{formatCpu(pod.cpu_requested_milli)}</td>
                        <td>{formatBytes(pod.memory_requested_bytes)}</td>
                      </tr>
                    ))}
                    {detail.pods.length === 0 && (
                      <tr><td colSpan={6} className="viz-empty">Nothing scheduled here.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
