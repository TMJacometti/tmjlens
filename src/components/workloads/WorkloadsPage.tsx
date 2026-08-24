import { useMemo, useState } from 'react';
import { Download, ListTree, Search, Trash2 } from 'lucide-react';
import { ActionMenu } from '../ActionMenu';
import { SeverityBadge, StatTile } from '../cluster/charts';
import { deploymentSeverity, podSeverity, type DeploymentRow, type PodRow } from '../../types/workloads';
import './workloads.css';

export type WorkloadCapabilities = {
  deletePods: boolean;
  deleteDeployments: boolean;
  patchDeployments: boolean;
};

type Props = {
  view: 'Pods' | 'Deployments';
  /** The controller inventory, rendered in place of the pod table on that view. */
  controllers: React.ReactNode;
  /** Whether the pod list is being kept current by a watch, or is a static snapshot. */
  podsLive: boolean;
  onViewChange: (view: 'Pods' | 'Deployments') => void;
  pods: PodRow[];
  deployments: DeploymentRow[];
  selectedPod: string;
  selectedDeployment: string;
  capabilities: WorkloadCapabilities;
  onSelectPod: (name: string) => void;
  onSelectDeployment: (name: string) => void;
  onDeletePod: (name: string) => void;
  onExportPodLogs: (name: string) => void;
  onDeleteDeployment: (name: string) => void;
  onExportDeployment: (name: string) => void;
};

export function WorkloadsPage(props: Props) {
  const { view, pods, deployments, controllers, podsLive } = props;
  const [filter, setFilter] = useState('');

  const needle = filter.trim().toLowerCase();
  const visiblePods = useMemo(
    () => (needle ? pods.filter((pod) => pod.name.toLowerCase().includes(needle)) : pods),
    [pods, needle],
  );
  const visibleDeployments = useMemo(
    () => (needle ? deployments.filter((entry) => entry.name.toLowerCase().includes(needle)) : deployments),
    [deployments, needle],
  );

  const unhealthyPods = pods.filter((pod) => podSeverity(pod) !== 'good').length;
  const degraded = deployments.filter((entry) => deploymentSeverity(entry) !== 'good').length;

  return (
    <div className="wl-page">
      {view === 'Pods' && (
        <div className="wl-kpis">
          <StatTile label="Pods" value={String(pods.length)} note={`${pods.length - unhealthyPods} healthy`} />
          <StatTile
            label="Pods needing attention"
            value={String(unhealthyPods)}
            severity={unhealthyPods === 0 ? 'good' : 'serious'}
            note={unhealthyPods === 0 ? 'All ready' : 'Not fully ready'}
          />
          <StatTile label="Controllers" value={String(deployments.length)} note="Deployments in this namespace" />
          <StatTile
            label="Below desired"
            value={String(degraded)}
            severity={degraded === 0 ? 'good' : 'serious'}
            note={degraded === 0 ? 'Fully rolled out' : 'Missing replicas'}
          />
        </div>
      )}

      <div className="wl-toolbar">
        <div className="wl-switch">
          <button type="button" className={view === 'Pods' ? 'is-active' : ''} onClick={() => props.onViewChange('Pods')}>
            Pods <span className="viz-count">{pods.length}</span>
          </button>
          {view === 'Pods' && (
            <span className={`wl-live${podsLive ? ' is-live' : ''}`} title={podsLive ? 'Following the API server' : 'Static snapshot — the watch is not running'}>
              <span className="wl-live-dot" aria-hidden />
              {podsLive ? 'Live' : 'Snapshot'}
            </span>
          )}
          <button
            type="button"
            className={view === 'Deployments' ? 'is-active' : ''}
            onClick={() => props.onViewChange('Deployments')}
          >
            Controllers
          </button>
        </div>
        {view === 'Pods' && (
          <label className="wl-search">
            <Search size={14} aria-hidden />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter pods…"
              aria-label="Filter pods"
            />
          </label>
        )}
      </div>

      {view === 'Pods' ? <PodsTable {...props} pods={visiblePods} filtered={needle.length > 0} /> : controllers}
    </div>
  );
}

function PodsTable({
  pods,
  selectedPod,
  capabilities,
  onSelectPod,
  onDeletePod,
  onExportPodLogs,
  filtered,
}: Props & { filtered: boolean }) {
  if (pods.length === 0) {
    return <div className="viz-card"><div className="viz-empty">{filtered ? 'No pod matches this filter.' : 'No pods in this namespace.'}</div></div>;
  }

  return (
    <section className="viz-card">
      <div className="viz-table-wrap viz-table-scroll">
        <table className="viz-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>State</th>
              <th>Ready</th>
              <th>Age</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pods.map((pod) => (
              <tr
                key={pod.name}
                className={selectedPod === pod.name ? 'is-selected' : ''}
                onClick={() => onSelectPod(pod.name)}
              >
                <td className="mono">{pod.name}</td>
                <td>
                  <SeverityBadge severity={podSeverity(pod)} label={pod.status} />
                </td>
                <td>{pod.ready}</td>
                <td>{pod.age}</td>
                <td className="wl-actions">
                  <ActionMenu
                    label="Pod actions"
                    items={[
                      { label: 'Open details', icon: <ListTree size={14} />, onSelect: () => onSelectPod(pod.name) },
                      { label: 'Download logs', icon: <Download size={14} />, onSelect: () => onExportPodLogs(pod.name) },
                      ...(capabilities.deletePods
                        ? [{ label: 'Delete pod', icon: <Trash2 size={14} />, danger: true, onSelect: () => onDeletePod(pod.name) }]
                        : []),
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
