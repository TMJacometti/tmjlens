import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  BarChart3, Box, ChevronDown, CircleAlert, DatabaseBackup, Download, FileCog, Gauge, GitBranch, HardDrive,
  Layers3, ListTree, Network, Search, Server, Settings, Terminal,
  Trash2, Workflow, X, XCircle
} from 'lucide-react';
import { ActionMenu } from './components/ActionMenu';
import { WorkloadsPage } from './components/workloads/WorkloadsPage';
import { WorkloadInventoryTable } from './components/workloads/WorkloadInventoryTable';
import type { WorkloadInventory, WorkloadRow } from './types/workload-list';
import { NetworkPage } from './components/network/NetworkPage';
import { YamlEditor } from './components/YamlEditor';
import { LogViewer } from './components/logs/LogViewer';
import { PortForwardPanel } from './components/portforward/PortForwardPanel';
import { ExecTerminal } from './components/exec/ExecTerminal';
import type { NetworkOverview } from './types/network';
import { DeployReportPage } from './components/reports/DeployReportPage';
import { NamespacesPage } from './components/namespaces/NamespacesPage';
import type { DeployReport, NamespaceOverview } from './types/reports';
import { StoragePage } from './components/storage/StoragePage';
import type { StorageOverview } from './types/storage';
import { ConfigurationPage } from './components/configuration/ConfigurationPage';
import type { ConfigurationOverview, RevealedValue } from './types/configuration';
import { VeleroPage } from './components/velero/VeleroPage';
import type { VeleroStatus } from './types/velero';
import { DeploymentDetailPanel } from './components/workloads/DeploymentDetailPanel';
import { textToBase64 } from './lib/encoding';
import { usePodWatch } from './lib/usePodWatch';
import { CommandPalette, type PaletteCommand, type SearchHit } from './components/palette/CommandPalette';
import { Toast, ToastMessage } from './components/Toast';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { EnvironmentBadge, EnvironmentStripe } from './components/settings/EnvironmentBadge';
import { environmentMeta, type AppSettings, type EnvironmentId } from './types/settings';
import { ClusterOverviewPage, NodeCapabilities } from './components/cluster/ClusterOverviewPage';
import type { ClusterOverview, NodeAction } from './types/cluster';

type TauriContext = { name: string; current: boolean; namespace?: string };
type PodRow = { name: string; status: string; ready: string; age: string };
type DeploymentRow = { name: string; ready: number; desired: number; available: number; age: string };
type EventInfo = { reason: string; message: string; kind: string; name: string; timestamp?: string };
type Capabilities = { deletePods: boolean; deleteDeployments: boolean; patchDeployments: boolean; patchPods: boolean; patchServices: boolean; patchIngresses: boolean; patchConfigMaps: boolean; patchSecrets: boolean; portForward: boolean; podExec: boolean };

export function App() {
  const [active, setActive] = useState('Workloads');
  const [workloadView, setWorkloadView] = useState<'Pods' | 'Deployments'>('Pods');
  const [inventory, setInventory] = useState<WorkloadInventory | null>(null);
  const [inventoryError, setInventoryError] = useState('');
  const [isLoadingInventory, setIsLoadingInventory] = useState(false);
  const [selectedDeployment, setSelectedDeployment] = useState('');
  const [isExportingDeployment, setIsExportingDeployment] = useState(false);
  const [deployReport, setDeployReport] = useState<DeployReport | null>(null);
  const [deployReportError, setDeployReportError] = useState('');
  const [isLoadingDeployReport, setIsLoadingDeployReport] = useState(false);
  const [namespaceOverview, setNamespaceOverview] = useState<NamespaceOverview | null>(null);
  const [namespaceError, setNamespaceError] = useState('');
  const [isLoadingNamespaces, setIsLoadingNamespaces] = useState(false);
  const [storage, setStorage] = useState<StorageOverview | null>(null);
  const [storageError, setStorageError] = useState('');
  const [isLoadingStorage, setIsLoadingStorage] = useState(false);
  const [configuration, setConfiguration] = useState<ConfigurationOverview | null>(null);
  const [configurationError, setConfigurationError] = useState('');
  const [isLoadingConfiguration, setIsLoadingConfiguration] = useState(false);
  const [velero, setVelero] = useState<VeleroStatus | null>(null);
  const [veleroError, setVeleroError] = useState('');
  const [isLoadingVelero, setIsLoadingVelero] = useState(false);
  const [veleroCapabilities, setVeleroCapabilities] = useState({ backup: false, restore: false });
  const [network, setNetwork] = useState<NetworkOverview | null>(null);
  const [networkError, setNetworkError] = useState('');
  const [isLoadingNetwork, setIsLoadingNetwork] = useState(false);
  const [yamlTarget, setYamlTarget] = useState<{ kind: string; name: string } | null>(null);
  const [namespace, setNamespace] = useState('default');
  const [context, setContext] = useState('loading...');
  const [contexts, setContexts] = useState<string[]>([]);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [snapshotPods, setPods] = useState<PodRow[]>([]);
  const [deployments, setDeployments] = useState<DeploymentRow[]>([]);
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [clusterOverview, setClusterOverview] = useState<ClusterOverview | null>(null);
  const [clusterError, setClusterError] = useState('');
  const [isLoadingCluster, setIsLoadingCluster] = useState(false);
  const [nodeCapabilities, setNodeCapabilities] = useState<NodeCapabilities>({ cordon: false, drain: false, delete: false });
  const [selectedPod, setSelectedPod] = useState('');
  const [selectedContainer, setSelectedContainer] = useState('');
  const [containers, setContainers] = useState<string[]>([]);
  const [showDetail, setShowDetail] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [settings, setSettings] = useState<AppSettings>({ context_environments: {}, confirm_destructive_in_production: true });
  const [showSettings, setShowSettings] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities>({ deletePods: false, deleteDeployments: false, patchDeployments: false, patchPods: false, patchServices: false, patchIngresses: false, patchConfigMaps: false, patchSecrets: false, portForward: false, podExec: false });
  const refreshGeneration = useRef(0);

  // Pods come from a live watch while the screen is showing them; the snapshot from
  // list_namespace_snapshot is only a fallback for when the watch cannot run.
  const podWatch = usePodWatch(context, namespace, active === 'Workloads');
  const pods = podWatch.live ? podWatch.pods : snapshotPods;

  const notify = (text: string, detail: string | undefined, tone: 'good' | 'bad') => setToast({ text, detail, tone });

  // Ctrl/Cmd+K anywhere, and Escape closes whatever is on top.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setShowPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const currentEnvironment: EnvironmentId = settings.context_environments[context] ?? 'unset';

  /**
   * Destructive confirmation, scaled to the blast radius. A context marked Production
   * asks for its name to be typed, which a reflexive Enter cannot satisfy; every other
   * environment keeps the ordinary confirm, with the environment named in the prompt.
   */
  const confirmDestructive = (message: string): boolean => {
    if (currentEnvironment === 'production' && settings.confirm_destructive_in_production) {
      const typed = window.prompt(`${message}\n\nThis context is marked PRODUCTION.\nType the context name to confirm:\n\n${context}`);
      if (typed === null) return false;
      if (typed.trim() !== context) {
        notify('Confirmation did not match', 'The context name was not typed exactly, so nothing was changed.', 'bad');
        return false;
      }
      return true;
    }
    const meta = environmentMeta(currentEnvironment);
    const prefix = currentEnvironment === 'unset' ? '' : `[${meta.label}] `;
    return window.confirm(`${prefix}${message}`);
  };

  const refreshCapabilities = async (targetContext: string, targetNamespace: string) => {
    const check = (verb: string, resource: string, subresource?: string) => invoke<boolean>('check_permission', { context: targetContext, namespace: targetNamespace, verb, resource, subresource, group: null }).catch(() => false);
    const [deletePods, deleteDeployments, patchDeployments, patchPods, patchServices, patchIngresses, portForward, podExec, patchConfigMaps, patchSecrets] = await Promise.all([
      check('delete', 'pods'), check('delete', 'deployments'), check('patch', 'deployments'), check('patch', 'pods'),
      check('patch', 'services'), check('patch', 'ingresses'), check('create', 'pods', 'portforward'), check('create', 'pods', 'exec'),
      check('patch', 'configmaps'), check('patch', 'secrets'),
    ]);
    setCapabilities({ deletePods, deleteDeployments, patchDeployments, patchPods, patchServices, patchIngresses, portForward, podExec, patchConfigMaps, patchSecrets });
  };

  // Nodes are cluster-scoped, so the access review is sent with an empty namespace.
  const refreshNodeCapabilities = async (targetContext: string) => {
    const check = (verb: string, resource: string, subresource?: string) =>
      invoke<boolean>('check_permission', { context: targetContext, namespace: '', verb, resource, subresource, group: null }).catch(() => false);
    const [patchNodes, deleteNodes, evictPods] = await Promise.all([
      check('patch', 'nodes'), check('delete', 'nodes'), check('create', 'pods', 'eviction'),
    ]);
    setNodeCapabilities({ cordon: patchNodes, drain: patchNodes && evictPods, delete: deleteNodes });
  };


  const refreshResources = async (targetContext: string, targetNamespace: string) => {
    const generation = ++refreshGeneration.current;
    const snapshot = await invoke<{ pods: PodRow[]; deployments: DeploymentRow[]; events: EventInfo[] }>('list_namespace_snapshot', { context: targetContext, namespace: targetNamespace }).catch(() => ({ pods: [], deployments: [], events: [] }));
    if (generation !== refreshGeneration.current) return;
    const { pods: podList, deployments: deploymentList, events: eventList } = snapshot;
    setPods(podList);
    setDeployments(deploymentList); setEvents(eventList); setSelectedPod(''); setShowDetail(false);
  };

  const selectPod = (podName: string) => { setSelectedPod(podName); setShowDetail(true); };

  const deletePod = async (podName: string) => {
    if (!confirmDestructive(`Delete pod ${podName}? Kubernetes may recreate it.`)) return;
    await invoke('delete_pod', { context, namespace, podName });
    await refreshResources(context, namespace);
    for (const delay of [400, 800, 1200]) {
      await new Promise((resolve) => window.setTimeout(resolve, delay));
      await refreshResources(context, namespace);
    }
  };

  const deleteDeployment = async (deploymentName: string) => {
    if (!confirmDestructive(`Delete deployment ${deploymentName}?`)) return;
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
    if (!confirmDestructive(`Rollout restart deployment ${deploymentName}?`)) return;
    await invoke('restart_deployment', { context, namespace, deploymentName });
    await refreshResources(context, namespace);
  };

  const refreshEvents = async () => {
    const eventList = await invoke<EventInfo[]>('list_events', { context, namespace }).catch(() => []);
    setEvents(eventList);
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

  /**
   * Builds the executive PDF in the frontend and hands the bytes to Rust to write.
   * The document is drawn from the same snapshot already on screen, so the report can
   * never disagree with what was reviewed before pressing the button.
   */
  const generateReport = async () => {
    if (!clusterOverview) return;
    setIsGeneratingReport(true);
    try {
      const { buildClusterReport, reportFileName } = await import('./lib/report');
      const pdf = buildClusterReport(clusterOverview, currentEnvironment);
      const base64 = pdf.output('datauristring').split(',')[1];
      const path = await invoke<string>('save_bytes_to_downloads', {
        fileName: reportFileName(clusterOverview),
        extension: 'pdf',
        base64Contents: base64,
      });
      notify('Executive report saved', path, 'good');
    } catch (error) {
      notify('Could not build the report', String(error), 'bad');
    } finally {
      setIsGeneratingReport(false);
    }
  };

  /** Writes the deployment's server document to Downloads, unmodified. */
  const exportDeployment = async (deploymentName: string) => {
    setIsExportingDeployment(true);
    try {
      const body = await invoke<string>('export_deployment_yaml', { context, namespace, deploymentName });
      const path = await invoke<string>('save_bytes_to_downloads', {
        fileName: `${deploymentName}-deployment`,
        extension: 'yaml',
        base64Contents: textToBase64(body),
      });
      notify('Deployment YAML saved', path, 'good');
    } catch (error) {
      notify('Could not export the deployment', String(error), 'bad');
    } finally {
      setIsExportingDeployment(false);
    }
  };

  const openDeploymentLogs = (podName: string, container: string) => {
    setSelectedDeployment('');
    setWorkloadView('Pods');
    selectPod(podName);
    setSelectedContainer(container);
  };

  /** Runs only when the operator picks namespaces and filters. Never on screen open. */
  const runDeployReport = async (chosen: string[], window: string) => {
    setIsLoadingDeployReport(true);
    try {
      setDeployReport(await invoke<DeployReport>('get_deploy_report', { context, namespaces: chosen, window }));
      setDeployReportError('');
    } catch (error) {
      setDeployReportError(String(error));
      setDeployReport(null);
    } finally {
      setIsLoadingDeployReport(false);
    }
  };

  const loadNamespaceOverview = async () => {
    setIsLoadingNamespaces(true);
    try {
      setNamespaceOverview(await invoke<NamespaceOverview>('get_namespace_overview', { context }));
      setNamespaceError('');
    } catch (error) {
      setNamespaceError(String(error));
    } finally {
      setIsLoadingNamespaces(false);
    }
  };

  const loadStorage = async () => {
    setIsLoadingStorage(true);
    try {
      setStorage(await invoke<StorageOverview>('get_storage_overview', { context, namespace }));
      setStorageError('');
    } catch (error) {
      setStorageError(String(error));
    } finally {
      setIsLoadingStorage(false);
    }
  };

  const loadConfiguration = async () => {
    setIsLoadingConfiguration(true);
    try {
      setConfiguration(await invoke<ConfigurationOverview>('get_configuration', { context, namespace }));
      setConfigurationError('');
    } catch (error) {
      setConfigurationError(String(error));
    } finally {
      setIsLoadingConfiguration(false);
    }
  };

  const readConfigurationKey = (kind: 'ConfigMap' | 'Secret', name: string, key: string) =>
    invoke<RevealedValue>(kind === 'Secret' ? 'reveal_secret_key' : 'read_config_map_key', { context, namespace, name, key });

  const saveConfigurationKey = async (kind: 'ConfigMap' | 'Secret', name: string, key: string, value: string) => {
    // Writing a Secret changes what running pods will read on their next restart, so it
    // carries the same confirmation as any other write to a live cluster.
    if (!confirmDestructive(`Save ${key} to ${kind.toLowerCase()} ${name}? Pods already running keep the old value until they restart.`)) {
      throw new Error('Cancelled.');
    }
    await invoke(kind === 'Secret' ? 'write_secret_key' : 'write_config_map_key', { context, namespace, name, key, value });
  };

  const deleteConfigurationKey = async (kind: 'ConfigMap' | 'Secret', name: string, key: string) => {
    if (!confirmDestructive(`Remove ${key} from ${kind.toLowerCase()} ${name}?`)) throw new Error('Cancelled.');
    await invoke('delete_configuration_key', { context, namespace, kind, name, key });
  };

  /**
   * Velero's objects live in Velero's own namespace, not the one selected in the
   * toolbar, so this load is deliberately independent of the namespace picker.
   */
  const loadVelero = async () => {
    setIsLoadingVelero(true);
    try {
      const status = await invoke<VeleroStatus>('get_velero_status', { context, veleroNamespace: null });
      setVelero(status);
      setVeleroError('');
      if (status.installed) {
        const check = (verb: string, resource: string) =>
          invoke<boolean>('check_permission', { context, namespace: status.namespace, verb, resource, subresource: null, group: 'velero.io' }).catch(() => false);
        const [backup, restore] = await Promise.all([check('create', 'backups'), check('create', 'restores')]);
        setVeleroCapabilities({ backup, restore });
      }
    } catch (error) {
      setVeleroError(String(error));
    } finally {
      setIsLoadingVelero(false);
    }
  };

  const createVeleroBackup = async (request: { name: string; includedNamespaces: string[]; ttlHours: number; storageLocation: string | null; includeVolumes: boolean }) => {
    if (!velero) return;
    const created = await invoke<string>('create_velero_backup', {
      context, veleroNamespace: velero.namespace, name: request.name,
      includedNamespaces: request.includedNamespaces, ttlHours: request.ttlHours,
      storageLocation: request.storageLocation, includeVolumes: request.includeVolumes,
    });
    notify('Backup requested', `Velero is taking ${created}. Refresh to watch it finish.`, 'good');
    await loadVelero();
  };

  const createVeleroRestore = async (request: { name: string; backupName: string; includedNamespaces: string[] }) => {
    if (!velero) return;
    // A restore writes into the live cluster, so it goes through the same confirmation
    // as a delete — which, in a context marked Production, means typing the context name.
    if (!confirmDestructive(`Restore ${request.backupName} into this cluster? Velero will create the resources it holds.`)) return;
    const created = await invoke<string>('create_velero_restore', {
      context, veleroNamespace: velero.namespace, name: request.name,
      backupName: request.backupName, includedNamespaces: request.includedNamespaces,
    });
    notify('Restore requested', `Velero is running ${created}. Watch it under Restores.`, 'good');
    await loadVelero();
  };

  const loadNetwork = async () => {
    setIsLoadingNetwork(true);
    try {
      setNetwork(await invoke<NetworkOverview>('get_network_overview', { context, namespace }));
      setNetworkError('');
    } catch (error) {
      setNetworkError(String(error));
    } finally {
      setIsLoadingNetwork(false);
    }
  };

  const loadInventory = async () => {
    setIsLoadingInventory(true);
    try {
      setInventory(await invoke<WorkloadInventory>('list_workloads', { context, namespace }));
      setInventoryError('');
    } catch (error) {
      setInventoryError(String(error));
    } finally {
      setIsLoadingInventory(false);
    }
  };

  const deleteWorkload = async (row: WorkloadRow) => {
    if (!confirmDestructive(`Delete ${row.kind} ${row.name}? Its pods go with it.`)) return;
    try {
      await invoke('delete_workload', { context, namespace, kind: row.kind, name: row.name });
      notify(`${row.kind} deleted`, row.name, 'good');
      await loadInventory();
    } catch (error) {
      notify(`Could not delete the ${row.kind.toLowerCase()}`, String(error), 'bad');
    }
  };

  const exportWorkloadYaml = async (row: WorkloadRow) => {
    try {
      const body = await invoke<string>('get_resource_yaml', {
        context, namespace, resourceKind: row.kind, resourceName: row.name,
      });
      const path = await invoke<string>('save_bytes_to_downloads', {
        fileName: `${row.name}-${row.kind.toLowerCase()}`,
        extension: 'yaml',
        base64Contents: textToBase64(body),
      });
      notify('YAML saved', path, 'good');
    } catch (error) {
      notify('Could not export', String(error), 'bad');
    }
  };

  /** Where a search result leads. Kinds without a screen of their own open in the
   *  YAML editor, which is honest: it is what the app can actually show for them. */
  const openSearchHit = (found: SearchHit) => {
    if (found.namespace && found.namespace !== namespace) setNamespace(found.namespace);
    switch (found.kind) {
      case 'Pod':
        setActive('Workloads');
        setWorkloadView('Pods');
        selectPod(found.name);
        break;
      case 'Deployment':
        setActive('Workloads');
        setWorkloadView('Deployments');
        setSelectedDeployment(found.name);
        break;
      case 'StatefulSet':
      case 'DaemonSet':
      case 'Job':
      case 'CronJob':
        setActive('Workloads');
        setWorkloadView('Deployments');
        setYamlTarget({ kind: found.kind, name: found.name });
        break;
      case 'Service':
      case 'Ingress':
        setActive('Network');
        setYamlTarget({ kind: found.kind, name: found.name });
        break;
      case 'Node':
        setActive('Cluster Overview');
        break;
      case 'Namespace':
        setNamespace(found.name);
        setActive('Workloads');
        break;
      default:
        notify(`${found.kind} ${found.name}`, 'No dedicated screen for this kind yet.', 'bad');
    }
  };

  const paletteCommands: PaletteCommand[] = [
    { id: 'go-overview', label: 'Go to Cluster Overview', group: 'Navigate', run: () => setActive('Cluster Overview') },
    { id: 'go-workloads', label: 'Go to Workloads', group: 'Navigate', run: () => setActive('Workloads') },
    { id: 'go-network', label: 'Go to Network', group: 'Navigate', run: () => setActive('Network') },
    { id: 'go-velero', label: 'Go to Velero backups', group: 'Navigate', run: () => setActive('Velero') },
    { id: 'go-configuration', label: 'Go to Configuration', group: 'Navigate', run: () => setActive('Configuration') },
    { id: 'go-storage', label: 'Go to Storage', group: 'Navigate', run: () => setActive('Storage') },
    { id: 'go-namespaces', label: 'Go to Namespaces', group: 'Navigate', run: () => setActive('Namespaces') },
    { id: 'go-events', label: 'Go to Events', group: 'Navigate', run: () => setActive('Events') },
    { id: 'go-reports', label: 'Go to Reports', group: 'Navigate', run: () => setActive('Reports') },
    { id: 'open-settings', label: 'Open Settings', group: 'App', run: () => setShowSettings(true) },
    { id: 'refresh-cluster', label: 'Refresh cluster overview', group: 'Action', run: () => void loadClusterOverview() },
    { id: 'refresh-network', label: 'Refresh network', group: 'Action', run: () => void loadNetwork() },
    { id: 'refresh-workloads', label: 'Refresh controllers', group: 'Action', run: () => void loadInventory() },
    { id: 'report', label: 'Generate executive report', group: 'Action', hint: 'PDF to Downloads', run: () => void generateReport() },
  ];

  const nodeAction = async (action: NodeAction, nodeName: string) => {
    const messages = { cordon: `Cordon node ${nodeName}?`, uncordon: `Uncordon node ${nodeName}?`, drain: `Drain node ${nodeName}? Pods will be evicted.`, delete: `Delete node ${nodeName}?` };
    if (!confirmDestructive(messages[action])) return;
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



  useEffect(() => {
    void reloadContexts();
    void invoke<AppSettings>('load_settings').then(setSettings).catch(() => undefined);
  }, []);

  /** Re-reads the kubeconfig into the shell. Also runs after Settings edits the file,
   *  so the context and namespace shown here follow what kubectl would now use. */
  async function reloadContexts() {
    {
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
    }
  }

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
      setContainers(nextContainers); const nextContainer = nextContainers[0] || ''; setSelectedContainer(nextContainer);
    };
    void loadDetails();
  }, [showDetail, selectedPod, namespace, context]);

  useEffect(() => {
    if (active === 'Network') void loadNetwork();
    if (active === 'Velero') void loadVelero();
    if (active === 'Configuration') void loadConfiguration();
    if (active === 'Storage') void loadStorage();
    if (active === 'Namespaces') void loadNamespaceOverview();
    if (active === 'Workloads' && workloadView === 'Deployments') void loadInventory();
    if (active === 'Cluster Overview') {
      void loadClusterOverview();
      void refreshNodeCapabilities(context);
    }
  }, [active, context, namespace, workloadView]);

  const showEvents = active === 'Events';
  if (active === 'Reports') {
    return <div className="app"><EnvironmentStripe environment={currentEnvironment}/><header className="topbar"><div className="brand"><span className="shark">🦈</span> tmjLens</div><span className="muted">{context}</span><div className="spacer"/><button className="selector" onClick={() => setActive('Workloads')}>Back to Workloads</button></header><main className="main report-screen"><div className="breadcrumbs">Cluster / {context} / Reports</div><div className="title-row"><div><h1>Deploy report</h1><p>What landed in <b>{context}</b>, for the namespaces you choose</p></div></div><DeployReportPage namespaces={namespaces} report={deployReport} loading={isLoadingDeployReport} error={deployReportError} onRun={(chosen, window) => void runDeployReport(chosen, window)}/></main></div>;
  }
  if (active === 'Cluster Overview') {
    return <div className="app"><EnvironmentStripe environment={currentEnvironment}/><header className="topbar"><div className="brand"><span className="shark">🦈</span> tmjLens</div><span className="muted">{context}</span><div className="spacer"/><button className="selector" onClick={() => setActive('Workloads')}>Back to Workloads</button></header><main className="main report-screen"><div className="breadcrumbs">Cluster / {context} / Overview</div><div className="title-row"><div><h1>Cluster Overview</h1><p>Cluster health, capacity, and node operations for <b>{context}</b></p></div></div><ClusterOverviewPage data={clusterOverview} loading={isLoadingCluster} error={clusterError} capabilities={nodeCapabilities} onRefresh={() => void loadClusterOverview()} onNodeAction={nodeAction} onGenerateReport={() => void generateReport()} generatingReport={isGeneratingReport}/></main></div>;
  }
  return <div className="app">
    <EnvironmentStripe environment={currentEnvironment}/>
    <header className="topbar"><div className="brand"><span className="shark">🦈</span> tmjLens</div>
      <label className="selector"><GitBranch size={15}/><select value={context} onChange={(event) => void handleContextChange(event.target.value)}>{contexts.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select><ChevronDown size={14}/></label><EnvironmentBadge environment={currentEnvironment}/>
      <label className="selector"><Layers3 size={15}/><span>ns:</span><select value={namespace} onChange={(event) => void handleNamespaceChange(event.target.value)}>{namespaces.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select><ChevronDown size={14}/></label>
      <div className="spacer"/><button className="icon-btn" title="Search the cluster (Ctrl+K)" onClick={() => setShowPalette(true)}><Search size={17}/></button><button className="icon-btn" title="Settings" onClick={() => setShowSettings(true)}><Settings size={17}/></button>
    </header>
    <div className="body"><aside className="sidebar"><div className="section-title">CLUSTER</div>
      <Nav icon={<Gauge size={16}/>} label="Cluster Overview" active={active === 'Cluster Overview'} onClick={() => setActive('Cluster Overview')} /><Nav icon={<Workflow size={16}/>} label="Workloads" active={active === 'Workloads'} onClick={() => setActive('Workloads')} /><Nav icon={<Network size={16}/>} label="Network" active={active === 'Network'} onClick={() => setActive('Network')} /><Nav icon={<HardDrive size={16}/>} label="Storage" active={active === 'Storage'} onClick={() => setActive('Storage')} /><Nav icon={<FileCog size={16}/>} label="Configuration" active={active === 'Configuration'} onClick={() => setActive('Configuration')} /><Nav icon={<Server size={16}/>} label="Nodes" active={active === 'Nodes'} onClick={() => setActive('Nodes')} /><Nav icon={<Layers3 size={16}/>} label="Namespaces" active={active === 'Namespaces'} onClick={() => setActive('Namespaces')} /><Nav icon={<CircleAlert size={16}/>} label="Events" active={active === 'Events'} onClick={() => setActive('Events')} /><Nav icon={<BarChart3 size={16}/>} label="Reports" active={active === 'Reports'} onClick={() => setActive('Reports')} />
      <div className="section-title aws">CLOUD</div><Nav icon={<Network size={16}/>} label="Load Balancers"/><Nav icon={<Box size={16}/>} label="Node Pools"/><div className="section-title plugins">PLUGINS</div><Nav icon={<DatabaseBackup size={16}/>} label="Velero" active={active === 'Velero'} onClick={() => setActive('Velero')} /><Nav icon={<Terminal size={16}/>} label="Helm"/><Nav icon={<Workflow size={16}/>} label="Argo CD"/>
    </aside><main className="main"><div className="breadcrumbs">Cluster / {namespace} / {active}</div><div className="title-row"><div><h1>{active}</h1><p>Live Kubernetes resources from <b>{context}</b></p></div></div>
      {showEvents ? <EventsPanel events={events} onRefresh={refreshEvents}/> : active === 'Namespaces' ? <NamespacesPage data={namespaceOverview} loading={isLoadingNamespaces} error={namespaceError} current={namespace} onRefresh={() => void loadNamespaceOverview()} onSelect={(name) => void handleNamespaceChange(name)}/> : active === 'Storage' ? <StoragePage data={storage} loading={isLoadingStorage} error={storageError} onRefresh={() => void loadStorage()}/> : active === 'Configuration' ? <ConfigurationPage data={configuration} loading={isLoadingConfiguration} error={configurationError} canEditConfigMaps={capabilities.patchConfigMaps} canEditSecrets={capabilities.patchSecrets} onRefresh={() => void loadConfiguration()} onRead={readConfigurationKey} onSave={saveConfigurationKey} onDelete={deleteConfigurationKey} notify={notify}/> : active === 'Velero' ? <VeleroPage status={velero} loading={isLoadingVelero} error={veleroError} namespaces={namespaces} canBackup={veleroCapabilities.backup} canRestore={veleroCapabilities.restore} onRefresh={() => void loadVelero()} onCreateBackup={createVeleroBackup} onCreateRestore={createVeleroRestore}/> : active === 'Network' ? <NetworkPage data={network} loading={isLoadingNetwork} error={networkError} onRefresh={() => void loadNetwork()} onEditYaml={(kind, name) => setYamlTarget({ kind, name })}/> : active === 'Workloads' ? <><WorkloadsPage view={workloadView} onViewChange={setWorkloadView} pods={pods} deployments={deployments} selectedPod={selectedPod} selectedDeployment={selectedDeployment} capabilities={{ deletePods: capabilities.deletePods, deleteDeployments: capabilities.deleteDeployments, patchDeployments: capabilities.patchDeployments }} onSelectPod={selectPod} onSelectDeployment={(name) => { setSelectedDeployment(name); setShowDetail(false); }} onDeletePod={(name) => void deletePod(name)} onExportPodLogs={(name) => void exportLogsFor(name)} onDeleteDeployment={(name) => void deleteDeployment(name)} onScaleDeployment={(name) => void scaleDeployment(name)} onRestartDeployment={(name) => void restartDeployment(name)} onExportDeployment={(name) => void exportDeployment(name)} podsLive={podWatch.live}
      controllers={<WorkloadInventoryTable inventory={inventory} loading={isLoadingInventory} error={inventoryError}
        selected={selectedDeployment ? `Deployment/${selectedDeployment}` : ''} canDelete={capabilities.deleteDeployments}
        onSelect={(row) => { if (row.kind === 'Deployment') { setSelectedDeployment(row.name); } else { setYamlTarget({ kind: row.kind, name: row.name }); } }}
        onEditYaml={(row) => setYamlTarget({ kind: row.kind, name: row.name })}
        onDelete={(row) => void deleteWorkload(row)} onExportYaml={(row) => void exportWorkloadYaml(row)}/>}/>{selectedDeployment && <DeploymentDetailPanel context={context} namespace={namespace} deploymentName={selectedDeployment} onClose={() => setSelectedDeployment('')} onExport={() => void exportDeployment(selectedDeployment)} exporting={isExportingDeployment} onOpenLogs={openDeploymentLogs}/>}{showDetail && selectedPod && <PodDetail pod={pods.find((pod) => pod.name === selectedPod)} context={context} namespace={namespace} containers={containers} events={events} selectedContainer={selectedContainer} setSelectedContainer={setSelectedContainer} onOpenYaml={() => setYamlTarget({ kind: 'Pod', name: selectedPod })} canForward={capabilities.portForward} canExec={capabilities.podExec} environmentWarning={currentEnvironment === 'production' ? `This context is marked Production. Commands run here affect real traffic.` : undefined} notify={notify} onExport={exportLogs} onClose={() => setShowDetail(false)}/>}</> : <div className="empty"><ListTree size={32}/><h2>{active}</h2><p>This screen is scaffolded. The Kubernetes data layer will populate it.</p></div>}
    </main></div>
    <Toast message={toast} onDismiss={() => setToast(null)}/>
    {yamlTarget && <YamlEditor context={context} namespace={namespace} kind={yamlTarget.kind} name={yamlTarget.name}
      canEdit={yamlTarget.kind === 'Service' ? capabilities.patchServices : capabilities.patchIngresses}
      onClose={() => setYamlTarget(null)} onSaved={() => void loadNetwork()} notify={notify} confirmSave={confirmDestructive}/>}
    {showPalette && <CommandPalette context={context} commands={paletteCommands} onOpenHit={openSearchHit} onClose={() => setShowPalette(false)}/>}
    {showSettings && <SettingsPanel settings={settings} onSettingsChange={setSettings} onKubeconfigChanged={() => void reloadContexts()} onClose={() => setShowSettings(false)} notify={notify}/>}
  </div>;
}

function EventsPanel({ events, onRefresh }: { events: EventInfo[]; onRefresh?: () => void }) { return <div className="panel events-panel"><div className="panel-head"><span>Events</span><div className="panel-actions"><span className="muted">{events.length} in namespace</span>{onRefresh && <button onClick={onRefresh}>Refresh</button>}</div></div>{events.length === 0 ? <div className="empty-inline">No events found.</div> : <div className="event-list">{events.map((event) => <article className="event" key={`${event.name}-${event.timestamp}`}><CircleAlert size={16}/><div><strong>{event.reason}</strong><span>{event.message}</span><small>{event.kind} / {event.name}{event.timestamp ? ` · ${event.timestamp}` : ''}</small></div></article>)}</div>}</div>; }
function PodDetail({ pod, context, namespace, containers, events, selectedContainer, setSelectedContainer, onOpenYaml, onExport, onClose, canForward, canExec, environmentWarning, notify }: { pod?: PodRow; canForward: boolean; canExec: boolean; environmentWarning?: string; notify: (text: string, detail: string | undefined, tone: 'good' | 'bad') => void; context: string; namespace: string; containers: string[]; events: EventInfo[]; selectedContainer: string; setSelectedContainer: (name: string) => void; onOpenYaml: () => void; onExport: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<'Logs' | 'Shell' | 'Forward' | 'Overview' | 'Events'>('Logs');
  const podEvents = events.filter((event) => event.name === pod?.name);
  return <div className="detail"><div className="detail-head"><div><h2>{pod?.name || 'Pod'}</h2><span className="muted">Pod · namespace {namespace}</span></div><button className="icon-btn" title="Close details" onClick={onClose}><X size={17}/></button></div>
    <div className="detail-tabs">
      <button className={`tab ${tab === 'Logs' ? 'active' : ''}`} onClick={() => setTab('Logs')}>Logs</button>
      <button className={`tab ${tab === 'Shell' ? 'active' : ''}`} onClick={() => setTab('Shell')}>Shell</button>
      <button className={`tab ${tab === 'Forward' ? 'active' : ''}`} onClick={() => setTab('Forward')}>Port forward</button>
      <button className={`tab ${tab === 'Overview' ? 'active' : ''}`} onClick={() => setTab('Overview')}>Overview</button>
      <button className={`tab ${tab === 'Events' ? 'active' : ''}`} onClick={() => setTab('Events')}>Events ({podEvents.length})</button>
      <span className="spacer"/>
      <button className="tab" onClick={onOpenYaml}>Edit YAML</button>
    </div>
    {tab === 'Logs' ? <LogViewer context={context} namespace={namespace} podName={pod?.name || ''} containers={containers} selectedContainer={selectedContainer} onSelectContainer={setSelectedContainer} onExport={onExport}/>
      : tab === 'Shell' ? <ExecTerminal context={context} namespace={namespace} podName={pod?.name || ''} containers={containers} canExec={canExec} environmentWarning={environmentWarning}/>
      : tab === 'Forward' ? <PortForwardPanel context={context} namespace={namespace} podName={pod?.name || ''} canForward={canForward} notify={notify}/>
      : tab === 'Overview' ? <PodOverview pod={pod} containers={containers}/>
      : <EventsPanel events={podEvents}/>}
  </div>;
}

function PodOverview({ pod, containers }: { pod?: PodRow; containers: string[] }) { return <div className="overview-grid"><div><span>Status</span><strong>{pod?.status || 'Unknown'}</strong></div><div><span>Ready</span><strong>{pod?.ready || 'n/a'}</strong></div><div><span>Age</span><strong>{pod?.age || 'n/a'}</strong></div><div><span>Containers</span><strong>{containers.length}</strong></div></div>; }
function Nav({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void }) { return <button className={`nav ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span></button>; }
function Stat({ label, value, danger }: { label: string; value: string | number; danger?: boolean }) { return <div className={`stat ${danger ? 'danger-stat' : ''}`}><span>{label}</span><strong>{String(value)}</strong></div>; }
function Status({ status }: { status: string }) { const bad = status !== 'Running'; return <span className={`status ${bad ? 'bad' : 'good'}`}>{bad ? <XCircle size={14}/> : <span className="dot"/>}{status}</span>; }
