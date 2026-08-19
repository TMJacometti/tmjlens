import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  BarChart3, Box, ChevronDown, CircleAlert, Download, FileCog, Gauge, GitBranch, HardDrive,
  Layers3, ListTree, Network, Search, Server, Settings, Terminal,
  Trash2, Workflow, X, XCircle
} from 'lucide-react';
import { ActionMenu } from './components/ActionMenu';
import { Toast, ToastMessage } from './components/Toast';
import { ClusterOverviewPage, NodeCapabilities } from './components/cluster/ClusterOverviewPage';
import type { ClusterOverview, NodeAction } from './types/cluster';

type TauriContext = { name: string; current: boolean; namespace?: string };
type PodRow = { name: string; status: string; ready: string; age: string };
type DeploymentRow = { name: string; ready: number; desired: number; available: number; age: string };
type EventInfo = { reason: string; message: string; kind: string; name: string; timestamp?: string };
type ReportItem = { kind: string; name: string; namespace?: string; created_at: string };
type Capabilities = { deletePods: boolean; deleteDeployments: boolean; patchDeployments: boolean; patchPods: boolean };

const defaultPods: PodRow[] = [{ name: 'sem-pods', status: 'Running', ready: '0/0', age: 'n/a' }];

export function App() {
  const [active, setActive] = useState('Workloads');
  const [workloadView, setWorkloadView] = useState<'Pods' | 'Deployments'>('Pods');
  const [namespace, setNamespace] = useState('default');
  const [context, setContext] = useState('loading...');
  const [contexts, setContexts] = useState<string[]>([]);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [pods, setPods] = useState<PodRow[]>(defaultPods);
  const [deployments, setDeployments] = useState<DeploymentRow[]>([]);
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [reportItems, setReportItems] = useState<ReportItem[]>([]);
  const [isLoadingReport, setIsLoadingReport] = useState(false);
  const [clusterOverview, setClusterOverview] = useState<ClusterOverview | null>(null);
  const [clusterError, setClusterError] = useState('');
  const [isLoadingCluster, setIsLoadingCluster] = useState(false);
  const [nodeCapabilities, setNodeCapabilities] = useState<NodeCapabilities>({ cordon: false, drain: false, delete: false });
  const [selectedPod, setSelectedPod] = useState('');
  const [selectedContainer, setSelectedContainer] = useState('');
  const [containers, setContainers] = useState<string[]>([]);
  const [logs, setLogs] = useState('');
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [yaml, setYaml] = useState('');
  const [editedYaml, setEditedYaml] = useState('');
  const [yamlError, setYamlError] = useState('');
  const [showDetail, setShowDetail] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities>({ deletePods: false, deleteDeployments: false, patchDeployments: false, patchPods: false });
  const refreshGeneration = useRef(0);

  const refreshCapabilities = async (targetContext: string, targetNamespace: string) => {
    const check = (verb: string, resource: string) => invoke<boolean>('check_permission', { context: targetContext, namespace: targetNamespace, verb, resource }).catch(() => false);
    const [deletePods, deleteDeployments, patchDeployments, patchPods] = await Promise.all([
      check('delete', 'pods'), check('delete', 'deployments'), check('patch', 'deployments'), check('patch', 'pods'),
    ]);
    setCapabilities({ deletePods, deleteDeployments, patchDeployments, patchPods });
  };

  // Nodes are cluster-scoped, so the access review is sent with an empty namespace.
  const refreshNodeCapabilities = async (targetContext: string) => {
    const check = (verb: string, resource: string, subresource?: string) =>
      invoke<boolean>('check_permission', { context: targetContext, namespace: '', verb, resource, subresource }).catch(() => false);
    const [patchNodes, deleteNodes, evictPods] = await Promise.all([
      check('patch', 'nodes'), check('delete', 'nodes'), check('create', 'pods', 'eviction'),
    ]);
    setNodeCapabilities({ cordon: patchNodes, drain: patchNodes && evictPods, delete: deleteNodes });
  };

  const loadPodLogs = async (podName: string, containerName?: string, allLogs = false) => {
    if (!podName) return;
    setIsLoadingLogs(true);
    try {
      const result = await invoke<string>('get_pod_logs', {
        context, namespace, podName, container: containerName || undefined,
        tailLines: allLogs ? null : 200, previous: false,
      });
      setLogs(result || 'No logs returned for this pod.');
    } catch (error) {
      setLogs(`Unable to fetch logs for ${podName}: ${String(error)}`);
    } finally {
      setIsLoadingLogs(false);
    }
  };

  const refreshResources = async (targetContext: string, targetNamespace: string) => {
    const generation = ++refreshGeneration.current;
    const snapshot = await invoke<{ pods: PodRow[]; deployments: DeploymentRow[]; events: EventInfo[] }>('list_namespace_snapshot', { context: targetContext, namespace: targetNamespace }).catch(() => ({ pods: [], deployments: [], events: [] }));
    if (generation !== refreshGeneration.current) return;
    const { pods: podList, deployments: deploymentList, events: eventList } = snapshot;
    setPods(podList.length > 0 ? podList : defaultPods);
    setDeployments(deploymentList); setEvents(eventList); setSelectedPod(''); setShowDetail(false);
  };

  const selectPod = (podName: string) => { setSelectedPod(podName); setLogs(''); setYaml(''); setEditedYaml(''); setYamlError(''); setShowDetail(true); };

  const deletePod = async (podName: string) => {
    if (!window.confirm(`Delete pod ${podName}? Kubernetes may recreate it.`)) return;
    await invoke('delete_pod', { context, namespace, podName });
    await refreshResources(context, namespace);
    for (const delay of [400, 800, 1200]) {
      await new Promise((resolve) => window.setTimeout(resolve, delay));
      await refreshResources(context, namespace);
    }
  };

  const deleteDeployment = async (deploymentName: string) => {
    if (!window.confirm(`Delete deployment ${deploymentName}?`)) return;
    await invoke('delete_deployment', { context, namespace, deploymentName });
    await refreshResources(context, namespace);
  };

  const scaleDeployment = async (deploymentName: string) => {
    const value = window.prompt(`Desired replicas for ${deploymentName}:`, '1');
    if (value === null) return;
    const replicas = Number(value);
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > 1000) { window.alert('Enter a whole number between 0 and 1000.'); return; }
    await invoke('scale_deployment', { context, namespace, deploymentName, replicas });
    await refreshResources(context, namespace);
  };

  const restartDeployment = async (deploymentName: string) => {
    if (!window.confirm(`Rollout restart deployment ${deploymentName}?`)) return;
    await invoke('restart_deployment', { context, namespace, deploymentName });
    await refreshResources(context, namespace);
  };

  const refreshEvents = async () => {
    const eventList = await invoke<EventInfo[]>('list_events', { context, namespace }).catch(() => []);
    setEvents(eventList);
  };

  const loadCreatedToday = async () => {
    setIsLoadingReport(true);
    try {
      setReportItems(await invoke<ReportItem[]>('list_created_today', { context }));
    } finally {
      setIsLoadingReport(false);
    }
  };

  const loadClusterOverview = async () => {
    setIsLoadingCluster(true);
    try {
      setClusterOverview(await invoke<ClusterOverview>('get_cluster_overview', { context }));
      setClusterError('');
    } catch (error) {
      setClusterError(String(error));
    } finally {
      setIsLoadingCluster(false);
    }
  };

  const nodeAction = async (action: NodeAction, nodeName: string) => {
    const messages = { cordon: `Cordon node ${nodeName}?`, uncordon: `Uncordon node ${nodeName}?`, drain: `Drain node ${nodeName}? Pods will be evicted.`, delete: `Delete node ${nodeName}?` };
    if (!window.confirm(messages[action])) return;
    try {
      if (action === 'delete') await invoke('delete_node', { context, nodeName });
      else if (action === 'drain') await invoke('drain_node', { context, nodeName });
      else await invoke('set_node_schedulable', { context, nodeName, schedulable: action === 'uncordon' });
      await loadClusterOverview();
    } catch (error) {
      window.alert(`Node action failed: ${String(error)}`);
    }
  };

  const exportLogsFor = async (podName: string, container?: string) => {
    if (!podName) return;
    try {
      const fullLogs = await invoke<string>('get_pod_logs', { context, namespace, podName, container: container || undefined, tailLines: null, previous: false });
      const path = await invoke<string>('save_to_downloads', { fileName: `${podName}-logs`, contents: fullLogs });
      setToast({ tone: 'good', text: `Logs exported for ${podName}`, detail: path });
    } catch (error) {
      setToast({ tone: 'bad', text: 'Log export failed', detail: String(error) });
    }
  };

  const exportLogs = () => exportLogsFor(selectedPod, selectedContainer);

  const loadPodYaml = async () => {
    try {
      const result = await invoke<string>('get_resource_yaml', { context, namespace, resourceKind: 'Pod', resourceName: selectedPod });
      setYaml(result); setEditedYaml(result); setYamlError('');
    } catch (error) {
      setYamlError(String(error));
    }
  };

  const applyPodYaml = async () => {
    if (!window.confirm(`Apply YAML changes to pod ${selectedPod}?`)) return;
    try {
      const result = await invoke<string>('apply_resource_yaml', { context, namespace, resourceKind: 'Pod', resourceName: selectedPod, yaml: editedYaml });
      setYaml(result); setEditedYaml(result); setYamlError('');
      await refreshResources(context, namespace);
    } catch (error) {
      setYamlError(String(error));
    }
  };

  useEffect(() => {
    const loadData = async () => {
      const [contextResult, contextListResult] = await Promise.allSettled([
        invoke<{ name: string; namespace?: string }>('current_context'),
        invoke<TauriContext[]>('list_kube_contexts'),
      ]);
      const contextInfo = contextResult.status === 'fulfilled' ? contextResult.value : undefined;
      const contextList = contextListResult.status === 'fulfilled' ? contextListResult.value : [];
      const nextContexts = contextList.map((entry) => entry.name);
      const initialContext = contextInfo?.name || nextContexts[0] || 'default';
      const configuredNamespace = contextInfo?.namespace;

      setContext(initialContext);
      setContexts(nextContexts);

      const nsList = await invoke<string[]>('list_namespaces', { context: initialContext }).catch(() => []);
      const nextNamespaces = nsList.length > 0 ? nsList : ['default'];
      const initialNamespace = configuredNamespace || nextNamespaces[0];
      setNamespaces(nextNamespaces);
      setNamespace(initialNamespace);

      await refreshResources(initialContext, initialNamespace);
      void refreshCapabilities(initialContext, initialNamespace);
    };
    void loadData();
  }, []);

  const handleContextChange = async (nextContext: string) => {
    setContext(nextContext);
    const nextNamespaces = await invoke<string[]>('list_namespaces', { context: nextContext }).catch(() => ['default']);
    const nextNamespace = nextNamespaces[0] || 'default';
    setNamespaces(nextNamespaces.length > 0 ? nextNamespaces : ['default']); setNamespace(nextNamespace);
    await refreshResources(nextContext, nextNamespace);
    void refreshCapabilities(nextContext, nextNamespace);
  };

  const handleNamespaceChange = async (nextNamespace: string) => { setNamespace(nextNamespace); await refreshResources(context, nextNamespace); void refreshCapabilities(context, nextNamespace); };

  useEffect(() => {
    if (!showDetail || !selectedPod) return;
    const loadDetails = async () => {
      const nextContainers = await invoke<string[]>('list_pod_containers', { context, namespace, podName: selectedPod }).catch(() => []);
      setContainers(nextContainers); const nextContainer = nextContainers[0] || ''; setSelectedContainer(nextContainer); setLogs('');
    };
    void loadDetails();
  }, [showDetail, selectedPod, namespace, context]);

  useEffect(() => {
    if (active === 'Reports') void loadCreatedToday();
    if (active === 'Cluster Overview') {
      void loadClusterOverview();
      void refreshNodeCapabilities(context);
    }
  }, [active, context]);

  const showEvents = active === 'Events';
  if (active === 'Reports') {
    return <div className="app"><header className="topbar"><div className="brand"><span className="shark">🦈</span> tmjLens</div><span className="muted">{context}</span><div className="spacer"/><button className="selector" onClick={() => setActive('Workloads')}>Back to Workloads</button></header><main className="main report-screen"><div className="breadcrumbs">Cluster / {context} / Reports</div><div className="title-row"><div><h1>Reports</h1><p>Resources created today in this cluster context</p></div><button className="primary" onClick={() => void loadCreatedToday()}>Refresh report</button></div><ReportsPanel items={reportItems} loading={isLoadingReport} onRefresh={loadCreatedToday}/></main></div>;
  }
  if (active === 'Cluster Overview') {
    return <div className="app"><header className="topbar"><div className="brand"><span className="shark">🦈</span> tmjLens</div><span className="muted">{context}</span><div className="spacer"/><button className="selector" onClick={() => setActive('Workloads')}>Back to Workloads</button></header><main className="main report-screen"><div className="breadcrumbs">Cluster / {context} / Overview</div><div className="title-row"><div><h1>Cluster Overview</h1><p>Cluster health, capacity, and node operations for <b>{context}</b></p></div></div><ClusterOverviewPage data={clusterOverview} loading={isLoadingCluster} error={clusterError} capabilities={nodeCapabilities} onRefresh={() => void loadClusterOverview()} onNodeAction={nodeAction}/></main></div>;
  }
  return <div className="app">
    <header className="topbar"><div className="brand"><span className="shark">🦈</span> tmjLens</div>
      <label className="selector"><GitBranch size={15}/><select value={context} onChange={(event) => void handleContextChange(event.target.value)}>{contexts.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select><ChevronDown size={14}/></label>
      <label className="selector"><Layers3 size={15}/><span>ns:</span><select value={namespace} onChange={(event) => void handleNamespaceChange(event.target.value)}>{namespaces.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select><ChevronDown size={14}/></label>
      <div className="spacer"/><button className="icon-btn" title="Search"><Search size={17}/></button><button className="icon-btn" title="Settings"><Settings size={17}/></button>
    </header>
    <div className="body"><aside className="sidebar"><div className="section-title">CLUSTER</div>
      <Nav icon={<Gauge size={16}/>} label="Cluster Overview" active={active === 'Cluster Overview'} onClick={() => setActive('Cluster Overview')} /><Nav icon={<Workflow size={16}/>} label="Workloads" active={active === 'Workloads'} onClick={() => setActive('Workloads')} /><Nav icon={<Network size={16}/>} label="Network" active={active === 'Network'} onClick={() => setActive('Network')} /><Nav icon={<HardDrive size={16}/>} label="Storage" active={active === 'Storage'} onClick={() => setActive('Storage')} /><Nav icon={<FileCog size={16}/>} label="Configuration" active={active === 'Configuration'} onClick={() => setActive('Configuration')} /><Nav icon={<Server size={16}/>} label="Nodes" active={active === 'Nodes'} onClick={() => setActive('Nodes')} /><Nav icon={<CircleAlert size={16}/>} label="Events" active={active === 'Events'} onClick={() => setActive('Events')} /><Nav icon={<BarChart3 size={16}/>} label="Reports" active={active === 'Reports'} onClick={() => setActive('Reports')} />
      <div className="section-title aws">CLOUD</div><Nav icon={<Network size={16}/>} label="Load Balancers"/><Nav icon={<Box size={16}/>} label="Node Pools"/><div className="section-title plugins">PLUGINS</div><Nav icon={<Terminal size={16}/>} label="Helm"/><Nav icon={<Workflow size={16}/>} label="Argo CD"/>
    </aside><main className="main"><div className="breadcrumbs">Cluster / {namespace} / {active}</div><div className="title-row"><div><h1>{active}</h1><p>Live Kubernetes resources from <b>{context}</b></p></div></div>
      {showEvents ? <EventsPanel events={events} onRefresh={refreshEvents}/> : active === 'Workloads' ? <><div className="view-switch"><button className={workloadView === 'Pods' ? 'active' : ''} onClick={() => setWorkloadView('Pods')}>Pods ({pods.length})</button><button className={workloadView === 'Deployments' ? 'active' : ''} onClick={() => setWorkloadView('Deployments')}>Deployments ({deployments.length})</button></div>{workloadView === 'Pods' ? <PodsPanel pods={pods} selectedPod={selectedPod} onSelect={selectPod} onDelete={capabilities.deletePods ? deletePod : undefined} onExport={(podName) => void exportLogsFor(podName)}/> : <DeploymentsPanel deployments={deployments} onDelete={capabilities.deleteDeployments ? deleteDeployment : undefined} onScale={capabilities.patchDeployments ? scaleDeployment : undefined} onRestart={capabilities.patchDeployments ? restartDeployment : undefined}/>} {showDetail && selectedPod && <PodDetail pod={pods.find((pod) => pod.name === selectedPod)} namespace={namespace} containers={containers} events={events} selectedContainer={selectedContainer} setSelectedContainer={setSelectedContainer} onLoadLogs={() => void loadPodLogs(selectedPod, selectedContainer)} onLoadYaml={() => void loadPodYaml()} onApplyYaml={capabilities.patchPods ? () => void applyPodYaml() : undefined} yaml={yaml} editedYaml={editedYaml} setEditedYaml={setEditedYaml} yamlError={yamlError} logs={logs} isLoading={isLoadingLogs} onExport={exportLogs} onClose={() => setShowDetail(false)}/>}</> : <div className="empty"><ListTree size={32}/><h2>{active}</h2><p>This screen is scaffolded. The Kubernetes data layer will populate it.</p></div>}
    </main></div><Toast message={toast} onDismiss={() => setToast(null)}/></div>;
}

function PodsPanel({ pods, selectedPod, onSelect, onDelete, onExport }: { pods: PodRow[]; selectedPod: string; onSelect: (name: string) => void; onDelete?: (name: string) => void; onExport: (name: string) => void }) { return <><div className="cards"><Stat label="Pods" value={pods.length}/><Stat label="Healthy" value={pods.filter((p) => p.status === 'Running').length}/><Stat label="Warnings" value={pods.filter((p) => p.status !== 'Running').length} danger/></div><div className="panel"><div className="panel-head"><span>Pods</span><div className="search"><Search size={15}/><input placeholder="Filter pods..." /></div></div><table><thead><tr><th>Name</th><th>Status</th><th>Ready</th><th>Age</th><th /></tr></thead><tbody>{pods.map((pod) => <tr key={pod.name} className={selectedPod === pod.name ? 'selected' : ''} onClick={() => onSelect(pod.name)}><td className="mono">{pod.name}</td><td><Status status={pod.status}/></td><td>{pod.ready}</td><td>{pod.age}</td><td className="action-cell"><ActionMenu label="Pod actions" items={[
    { label: 'Open details', icon: <ListTree size={14}/>, onSelect: () => onSelect(pod.name) },
    { label: 'Download logs', icon: <Download size={14}/>, onSelect: () => void onExport(pod.name) },
    ...(onDelete ? [{ label: 'Delete pod', icon: <Trash2 size={14}/>, danger: true, onSelect: () => void onDelete(pod.name) }] : []),
  ]}/></td></tr>)}</tbody></table></div></>; }
function DeploymentsPanel({ deployments, onDelete, onScale, onRestart }: { deployments: DeploymentRow[]; onDelete?: (name: string) => void; onScale?: (name: string) => void; onRestart?: (name: string) => void }) { return <div className="panel"><div className="panel-head"><span>Deployments</span></div><table><thead><tr><th>Name</th><th>Ready</th><th>Available</th><th>Age</th><th>Actions</th></tr></thead><tbody>{deployments.map((deployment) => <tr key={deployment.name}><td className="mono">{deployment.name}</td><td>{deployment.ready}/{deployment.desired}</td><td>{deployment.available}</td><td>{deployment.age}</td><td className="action-cell"><ActionMenu label="Deployment actions" items={[
    ...(onRestart ? [{ label: 'Rollout restart', onSelect: () => void onRestart(deployment.name) }] : []),
    ...(onScale ? [{ label: 'Scale replicas', onSelect: () => void onScale(deployment.name) }] : []),
    ...(onDelete ? [{ label: 'Delete deployment', icon: <Trash2 size={14}/>, danger: true, onSelect: () => void onDelete(deployment.name) }] : []),
  ]}/></td></tr>)}</tbody></table></div>; }
function EventsPanel({ events, onRefresh }: { events: EventInfo[]; onRefresh?: () => void }) { return <div className="panel events-panel"><div className="panel-head"><span>Events</span><div className="panel-actions"><span className="muted">{events.length} in namespace</span>{onRefresh && <button onClick={onRefresh}>Refresh</button>}</div></div>{events.length === 0 ? <div className="empty-inline">No events found.</div> : <div className="event-list">{events.map((event) => <article className="event" key={`${event.name}-${event.timestamp}`}><CircleAlert size={16}/><div><strong>{event.reason}</strong><span>{event.message}</span><small>{event.kind} / {event.name}{event.timestamp ? ` · ${event.timestamp}` : ''}</small></div></article>)}</div>}</div>; }
function PodDetail({ pod, namespace, containers, events, selectedContainer, setSelectedContainer, onLoadLogs, onLoadYaml, onApplyYaml, yaml, editedYaml, setEditedYaml, yamlError, logs, isLoading, onExport, onClose }: { pod?: PodRow; namespace: string; containers: string[]; events: EventInfo[]; selectedContainer: string; setSelectedContainer: (name: string) => void; onLoadLogs: () => void; onLoadYaml: () => void; onApplyYaml?: () => void; yaml: string; editedYaml: string; setEditedYaml: (value: string) => void; yamlError: string; logs: string; isLoading: boolean; onExport: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<'Logs' | 'YAML' | 'Overview' | 'Events'>('Logs');
  const podEvents = events.filter((event) => event.name === pod?.name);
  return <div className="detail"><div className="detail-head"><div><h2>{pod?.name || 'Pod'}</h2><span className="muted">Pod · namespace {namespace}</span></div><button className="icon-btn" title="Close details" onClick={onClose}><X size={17}/></button></div><div className="detail-tabs"><button className={`tab ${tab === 'Logs' ? 'active' : ''}`} onClick={() => setTab('Logs')}>Logs</button><button className={`tab ${tab === 'YAML' ? 'active' : ''}`} onClick={() => { setTab('YAML'); if (!yaml) onLoadYaml(); }}>YAML</button><button className={`tab ${tab === 'Overview' ? 'active' : ''}`} onClick={() => setTab('Overview')}>Overview</button><button className={`tab ${tab === 'Events' ? 'active' : ''}`} onClick={() => setTab('Events')}>Events ({podEvents.length})</button></div>{tab === 'Logs' ? <><div className="log-toolbar"><select value={selectedContainer} onChange={(event) => setSelectedContainer(event.target.value)}>{containers.length === 0 ? <option value="">No containers</option> : containers.map((container) => <option key={container} value={container}>{container}</option>)}</select><button onClick={onLoadLogs}>Load logs</button><button onClick={() => void onExport()}><Download size={14}/> Export logs</button><span className="spacer"/><span className="muted">{isLoading ? 'loading logs...' : logs ? 'last 200 lines' : 'logs not loaded'}</span></div><pre className="logs">{isLoading ? 'Loading logs...' : logs || 'Select Load logs to fetch this pod output.'}</pre></> : tab === 'Overview' ? <PodOverview pod={pod} containers={containers}/> : tab === 'Events' ? <EventsPanel events={podEvents}/> : <><div className="yaml-toolbar"><button onClick={onLoadYaml}>Reload YAML</button>{onApplyYaml ? <button className="primary" onClick={onApplyYaml} disabled={!editedYaml}>Apply YAML</button> : <span className="muted">Read-only: Kubernetes denied patch access</span>}</div>{yamlError && <div className="yaml-error">{yamlError}</div>}<textarea className="yaml-editor" value={editedYaml} onChange={(event) => setEditedYaml(event.target.value)} placeholder="Load YAML to inspect this resource." spellCheck={false}/></>}</div>;
}

function PodOverview({ pod, containers }: { pod?: PodRow; containers: string[] }) { return <div className="overview-grid"><div><span>Status</span><strong>{pod?.status || 'Unknown'}</strong></div><div><span>Ready</span><strong>{pod?.ready || 'n/a'}</strong></div><div><span>Age</span><strong>{pod?.age || 'n/a'}</strong></div><div><span>Containers</span><strong>{containers.length}</strong></div></div>; }
function ReportsPanel({ items, loading, onRefresh }: { items: ReportItem[]; loading: boolean; onRefresh: () => void }) { return <div className="panel reports-panel"><div className="panel-head"><span>Created today</span><div className="panel-actions"><span className="muted">{items.length} resources</span><button onClick={onRefresh}>Refresh</button></div></div>{loading ? <div className="empty-inline">Loading report...</div> : items.length === 0 ? <div className="empty-inline">No resources were created today, or the current identity cannot list them.</div> : <table><thead><tr><th>Type</th><th>Name</th><th>Namespace</th><th>Created at</th></tr></thead><tbody>{items.map((item) => <tr key={`${item.kind}-${item.namespace}-${item.name}-${item.created_at}`}><td><span className="report-kind">{item.kind}</span></td><td className="mono">{item.name}</td><td>{item.namespace || 'cluster'}</td><td>{new Date(item.created_at).toLocaleTimeString()}</td></tr>)}</tbody></table>}</div>; }
function Nav({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void }) { return <button className={`nav ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span></button>; }
function Stat({ label, value, danger }: { label: string; value: string | number; danger?: boolean }) { return <div className={`stat ${danger ? 'danger-stat' : ''}`}><span>{label}</span><strong>{String(value)}</strong></div>; }
function Status({ status }: { status: string }) { const bad = status !== 'Running'; return <span className={`status ${bad ? 'bad' : 'good'}`}>{bad ? <XCircle size={14}/> : <span className="dot"/>}{status}</span>; }
