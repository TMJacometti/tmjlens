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
  onScaleDeployment: (name: string) => void;
  onRestartDeployment: (name: string) => void;
  onExportDeployment: (name: string) => void;
};

export function WorkloadsPage(props: Props) {
  const { view, pods, deployments } = props;
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
      <div className="wl-kpis">
        <StatTile label="Pods" value={String(pods.length)} note={`${pods.length - unhealthyPods} healthy`} />
        <StatTile
          label="Pods needing attention"
          value={String(unhealthyPods)}
          severity={unhealthyPods === 0 ? 'good' : 'serious'}
          note={unhealthyPods === 0 ? 'All ready' : 'Not fully ready'}
        />
        <StatTile label="Deployments" value={String(deployments.length)} note={`${deployments.length - degraded} at desired`} />
        <StatTile
          label="Below desired"
          value={String(degraded)}
          severity={degraded === 0 ? 'good' : 'serious'}
          note={degraded === 0 ? 'Fully rolled out' : 'Missing replicas'}
        />
      </div>

      <div className="wl-toolbar">
        <div className="wl-switch">
          <button type="button" className={view === 'Pods' ? 'is-active' : ''} onClick={() => props.onViewChange('Pods')}>
            Pods <span className="viz-count">{pods.length}</span>
          </button>
          <button
            type="button"
            className={view === 'Deployments' ? 'is-active' : ''}
            onClick={() => props.onViewChange('Deployments')}
          >
            Deployments <span className="viz-count">{deployments.length}</span>
          </button>
        </div>
        <label className="wl-search">
          <Search size={14} aria-hidden />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={`Filter ${view.toLowerCase()}…`}
            aria-label={`Filter ${view.toLowerCase()}`}
          />
        </label>
      </div>

      {view === 'Pods' ? <PodsTable {...props} pods={visiblePods} filtered={needle.length > 0} /> : <DeploymentsTable {...props} deployments={visibleDeployments} filtered={needle.length > 0} />}
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

function DeploymentsTable({
  deployments,
  selectedDeployment,
  capabilities,
  onSelectDeployment,
  onDeleteDeployment,
  onScaleDeployment,
  onRestartDeployment,
  onExportDeployment,
  filtered,
}: Props & { filtered: boolean }) {
  if (deployments.length === 0) {
    return <div className="viz-card"><div className="viz-empty">{filtered ? 'No deployment matches this filter.' : 'No deployments in this namespace.'}</div></div>;
  }

  return (
    <section className="viz-card">
      <div className="viz-table-wrap viz-table-scroll">
        <table className="viz-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>State</th>
              <th>Replicas</th>
              <th>Available</th>
              <th>Age</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {deployments.map((deployment) => {
              const severity = deploymentSeverity(deployment);
              const share = deployment.desired > 0 ? (deployment.ready / deployment.desired) * 100 : 100;
              return (
                <tr
                  key={deployment.name}
                  className={selectedDeployment === deployment.name ? 'is-selected' : ''}
                  onClick={() => onSelectDeployment(deployment.name)}
                >
                  <td className="mono">{deployment.name}</td>
                  <td>
                    <SeverityBadge
                      severity={severity}
                      label={severity === 'good' ? 'Rolled out' : deployment.ready === 0 ? 'None ready' : 'Degraded'}
                    />
                  </td>
                  <td>
                    <div className="wl-replicas">
                      <div className="viz-track viz-track-thin">
                        <div
                          className="viz-bar"
                          style={{ width: `${Math.min(share, 100)}%`, background: `var(--status-${severity})` }}
                        />
                      </div>
                      <span>
                        {deployment.ready}/{deployment.desired}
                      </span>
                    </div>
                  </td>
                  <td>{deployment.available}</td>
                  <td>{deployment.age}</td>
                  <td className="wl-actions">
                    <ActionMenu
                      label="Deployment actions"
                      items={[
                        { label: 'Open details', icon: <ListTree size={14} />, onSelect: () => onSelectDeployment(deployment.name) },
                        { label: 'Download YAML', icon: <Download size={14} />, onSelect: () => onExportDeployment(deployment.name) },
                        ...(capabilities.patchDeployments
                          ? [
                              { label: 'Rollout restart', onSelect: () => onRestartDeployment(deployment.name) },
                              { label: 'Scale replicas', onSelect: () => onScaleDeployment(deployment.name) },
                            ]
                          : []),
                        ...(capabilities.deleteDeployments
                          ? [{ label: 'Delete deployment', icon: <Trash2 size={14} />, danger: true, onSelect: () => onDeleteDeployment(deployment.name) }]
                          : []),
                      ]}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
