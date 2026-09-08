import { useEffect, useState } from 'react';
import { invoke } from '../../lib/transport';
import { Download, X } from 'lucide-react';
import { DataTable, SeverityBadge } from '../cluster/charts';
import { RelationGraph, type RelationGraphData } from '../graph/RelationGraph';
import type { DeploymentDetail } from '../../types/workloads';
import type { Severity } from '../../types/cluster';

type Tab = 'Overview' | 'Relations' | 'Events' | 'Containers' | 'YAML';

type Props = {
  context: string;
  namespace: string;
  deploymentName: string;
  onClose: () => void;
  onExport: () => void;
  exporting: boolean;
  /** Opens a pod's logs for a chosen container, reusing the pod detail view. */
  onOpenLogs: (podName: string, container: string) => void;
};

export function DeploymentDetailPanel({
  context,
  namespace,
  deploymentName,
  onClose,
  onExport,
  exporting,
  onOpenLogs,
}: Props) {
  const [tab, setTab] = useState<Tab>('Overview');
  const [detail, setDetail] = useState<DeploymentDetail | null>(null);
  const [yaml, setYaml] = useState('');
  const [graph, setGraph] = useState<RelationGraphData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setDetail(null);
    setYaml('');
    setGraph(null);
    setError('');
    void invoke<DeploymentDetail>('get_deployment_detail', { context, namespace, deploymentName })
      .then(setDetail)
      .catch((cause) => setError(String(cause)));
  }, [context, namespace, deploymentName]);

  // The YAML is fetched only when asked for: it is the whole server document and
  // there is no reason to pull it for someone who opened the panel to read events.
  // The graph costs several lists, so it is built only when the tab is opened.
  useEffect(() => {
    if (tab !== 'Relations' || graph) return;
    void invoke<RelationGraphData>('get_relation_graph', { context, namespace, deploymentName })
      .then(setGraph)
      .catch((cause) => setError(String(cause)));
  }, [tab, graph, context, namespace, deploymentName]);

  useEffect(() => {
    if (tab !== 'YAML' || yaml) return;
    void invoke<string>('export_deployment_yaml', { context, namespace, deploymentName })
      .then(setYaml)
      .catch((cause) => setError(String(cause)));
  }, [tab, yaml, context, namespace, deploymentName]);

  const warnings = detail?.events.filter((event) => event.severity !== 'good').length ?? 0;

  return (
    <section className="viz-card wl-detail">
      <header className="viz-card-head">
        <div>
          <h3 className="mono">{deploymentName}</h3>
          <p>
            Deployment · namespace {namespace}
            {detail ? ` · ${detail.image_summary}` : ''}
          </p>
        </div>
        <div className="wl-detail-actions">
          <button type="button" className="viz-toggle" onClick={onExport} disabled={exporting}>
            <Download size={14} aria-hidden />
            {exporting ? 'Saving…' : 'Download YAML'}
          </button>
          <button type="button" className="viz-icon" onClick={onClose} aria-label="Close deployment details">
            <X size={16} />
          </button>
        </div>
      </header>

      <nav className="wl-tabs">
        {(['Overview', 'Relations', 'Events', 'Containers', 'YAML'] as Tab[]).map((entry) => (
          <button key={entry} type="button" className={tab === entry ? 'is-active' : ''} onClick={() => setTab(entry)}>
            {entry}
            {entry === 'Events' && warnings > 0 && <span className="viz-count">{warnings}</span>}
            {entry === 'Containers' && detail && <span className="viz-count">{detail.containers.length}</span>}
          </button>
        ))}
      </nav>

      {error && <div className="settings-error" style={{ margin: 16 }}>{error}</div>}

      {!detail && !error && <div className="viz-empty">Reading deployment…</div>}

      {detail && tab === 'Overview' && <Overview detail={detail} />}
      {tab === 'Relations' && (graph ? <RelationGraph data={graph} /> : <div className="viz-empty">Walking the graph…</div>)}
      {detail && tab === 'Events' && <Events detail={detail} />}
      {detail && tab === 'Containers' && <Containers detail={detail} onOpenLogs={onOpenLogs} />}
      {tab === 'YAML' && <Yaml body={yaml} />}
    </section>
  );
}

function Overview({ detail }: { detail: DeploymentDetail }) {
  const rollout: Severity =
    detail.replicas_ready >= detail.replicas_desired
      ? 'good'
      : detail.replicas_ready === 0
        ? 'critical'
        : 'serious';

  return (
    <div className="viz-card-body">
      <div className="wl-facts">
        <div>
          <span>Ready</span>
          <strong>
            {detail.replicas_ready}/{detail.replicas_desired}
          </strong>
          <SeverityBadge severity={rollout} label={rollout === 'good' ? 'At desired' : 'Below desired'} />
        </div>
        <div>
          <span>Updated</span>
          <strong>{detail.replicas_updated}</strong>
        </div>
        <div>
          <span>Available</span>
          <strong>{detail.replicas_available}</strong>
        </div>
        <div>
          <span>Strategy</span>
          <strong>{detail.strategy}</strong>
        </div>
      </div>

      <div>
        <h4>Conditions</h4>
        {detail.conditions.length === 0 ? (
          <p className="viz-dim">The controller has not reported any condition yet.</p>
        ) : (
          <ul className="wl-conditions">
            {detail.conditions.map((condition) => (
              <li key={condition.kind}>
                <SeverityBadge
                  severity={condition.healthy ? 'good' : 'serious'}
                  label={`${condition.kind}=${condition.status}`}
                />
                <span>{condition.reason ?? ''}</span>
                {condition.message && <small>{condition.message}</small>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4>Selector</h4>
        <ul className="cluster-finding-targets">
          {detail.selector.length === 0 ? (
            <li className="viz-dim">No label selector</li>
          ) : (
            detail.selector.map((entry) => (
              <li key={entry} className="mono">
                {entry}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

function Events({ detail }: { detail: DeploymentDetail }) {
  if (detail.events.length === 0) {
    return (
      <div className="viz-empty">
        No events for this deployment, its ReplicaSets or its pods. Kubernetes expires events after roughly an hour,
        so an old problem leaves nothing behind.
      </div>
    );
  }

  return (
    <>
      <p className="wl-lead">
        Events from the Deployment, the ReplicaSets it owns, and its pods. A rollout that never came up almost always
        explains itself on the ReplicaSet or the pod, not on the Deployment.
      </p>
      <DataTable
        columns={['Severity', 'Source', 'Object', 'Reason', 'Message', 'Count', 'Age']}
        rows={detail.events.map((event, index) => [
          // Kubernetes calls a non-warning event "Normal"; "Healthy" would overstate it.
          <SeverityBadge
            severity={event.severity}
            label={event.severity === 'good' ? 'Normal' : undefined}
            key={`s${index}`}
          />,
          event.kind,
          <span className="mono" key={`n${index}`}>
            {event.name}
          </span>,
          event.reason,
          <span key={`m${index}`} className="wl-message">
            {event.message}
          </span>,
          event.count,
          event.age,
        ])}
      />
    </>
  );
}

function Containers({ detail, onOpenLogs }: { detail: DeploymentDetail; onOpenLogs: (pod: string, container: string) => void }) {
  const [pod, setPod] = useState(detail.pods[0] ?? '');

  return (
    <div className="viz-card-body">
      <p className="wl-lead">
        Containers declared by the pod template. Pick a pod to read a container's logs — a Deployment has no logs of
        its own, only its pods do.
      </p>

      <label className="wl-pod-picker">
        <span>Pod</span>
        <select value={pod} onChange={(event) => setPod(event.target.value)}>
          {detail.pods.length === 0 ? (
            <option value="">No pods running</option>
          ) : (
            detail.pods.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))
          )}
        </select>
      </label>

      <ul className="wl-containers">
        {detail.containers.map((container) => (
          <li key={`${container.kind}-${container.name}`}>
            <div>
              <strong className="mono">{container.name}</strong>
              {container.kind === 'init' && <span className="wl-init">init</span>}
              <code>{container.image}</code>
            </div>
            <button
              type="button"
              className="viz-toggle"
              disabled={!pod}
              onClick={() => onOpenLogs(pod, container.name)}
            >
              View logs
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Yaml({ body }: { body: string }) {
  return (
    <>
      <p className="wl-lead">
        The object exactly as the API server holds it, including <code>status</code> and <code>managedFields</code>.
        Strip the server-owned fields before re-applying it.
      </p>
      <pre className="wl-yaml">{body || 'Reading…'}</pre>
    </>
  );
}
