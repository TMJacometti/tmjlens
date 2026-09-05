import { useEffect, useState } from 'react';
import { invoke } from '../lib/transport';
import { WorkloadsPage } from '../components/workloads/WorkloadsPage';
import { DeploymentDetailPanel } from '../components/workloads/DeploymentDetailPanel';
import { LogPopup } from '../components/logs/LogPopup';
import { WorkloadInventoryTable } from '../components/workloads/WorkloadInventoryTable';
import type { WorkloadInventory } from '../types/workload-list';
import type { PodUsageRow } from '../types/metrics';

/**
 * The modernised workloads screen against fixtures, with a deployment whose rollout
 * is stuck — the case the detail panel exists to explain. The Tauri IPC is stubbed in
 * preview/main.tsx, so the detail panel reads its data from there.
 */
const PODS = [
  { name: 'checkout-api-7d9f8b6c4d-5kx2m', status: 'Running', ready: '2/2', age: '2d' },
  { name: 'checkout-api-7d9f8b6c4d-9wq8p', status: 'Running', ready: '1/2', age: '2d' },
  { name: 'fraud-scoring-58f7c6d9b4-lm3nq', status: 'Pending', ready: '0/1', age: '22m' },
  { name: 'ledger-reconciler-6d4b9c7f8d-2xk9p', status: 'Running', ready: '0/1', age: '3h' },
  { name: 'batch-export-29187360-8kxv2', status: 'Succeeded', ready: '0/1', age: '14m' },
  { name: 'otel-collector-9f8d7c6b5a-qq41z', status: 'Failed', ready: '0/1', age: '6d' },
];

const DEPLOYMENTS = [
  { name: 'checkout-api', ready: 3, desired: 3, available: 3, age: '31d' },
  { name: 'fraud-scoring', ready: 1, desired: 4, available: 1, age: '12d' },
  { name: 'ledger-reconciler', ready: 0, desired: 2, available: 0, age: '5d' },
  { name: 'notification-worker', ready: 2, desired: 2, available: 2, age: '88d' },
];

const USAGE: Record<string, PodUsageRow> = {
  'checkout-api-7d9f8b6c4d-5kx2m': {
    name: 'checkout-api-7d9f8b6c4d-5kx2m', cpu_milli: 182, memory_bytes: 402 * 1024 * 1024,
    cpu_request_milli: 200, cpu_limit_milli: 500, memory_request_bytes: 256 * 1024 * 1024, memory_limit_bytes: 1024 * 1024 * 1024,
    sampled_at: new Date(Date.now() - 12_000).toISOString(), window: '30s',
    containers: [
      { name: 'api', cpu_milli: 170, memory_bytes: 384 * 1024 * 1024, cpu_request_milli: 200, cpu_limit_milli: 500, memory_request_bytes: 256 * 1024 * 1024, memory_limit_bytes: 1024 * 1024 * 1024 },
      { name: 'envoy', cpu_milli: 12, memory_bytes: 18 * 1024 * 1024, cpu_request_milli: 0, cpu_limit_milli: 0, memory_request_bytes: 0, memory_limit_bytes: 0 },
    ],
  },
  'checkout-api-7d9f8b6c4d-9wq8p': {
    name: 'checkout-api-7d9f8b6c4d-9wq8p', cpu_milli: 505, memory_bytes: 981 * 1024 * 1024,
    cpu_request_milli: 200, cpu_limit_milli: 500, memory_request_bytes: 256 * 1024 * 1024, memory_limit_bytes: 1024 * 1024 * 1024,
    sampled_at: new Date(Date.now() - 9_000).toISOString(), window: '30s',
    containers: [
      { name: 'api', cpu_milli: 505, memory_bytes: 981 * 1024 * 1024, cpu_request_milli: 200, cpu_limit_milli: 500, memory_request_bytes: 256 * 1024 * 1024, memory_limit_bytes: 1024 * 1024 * 1024 },
    ],
  },
  'ledger-reconciler-6d4b9c7f8d-2xk9p': {
    name: 'ledger-reconciler-6d4b9c7f8d-2xk9p', cpu_milli: 88, memory_bytes: 1.4 * 1024 * 1024 * 1024,
    cpu_request_milli: 100, cpu_limit_milli: 0, memory_request_bytes: 1024 * 1024 * 1024, memory_limit_bytes: 0,
    sampled_at: new Date(Date.now() - 20_000).toISOString(), window: '30s',
    containers: [
      { name: 'reconciler', cpu_milli: 88, memory_bytes: 1.4 * 1024 * 1024 * 1024, cpu_request_milli: 100, cpu_limit_milli: 0, memory_request_bytes: 1024 * 1024 * 1024, memory_limit_bytes: 0 },
    ],
  },
};

export function WorkloadsPreview() {
  const [view, setView] = useState<'Pods' | 'Deployments'>('Deployments');
  const [inventory, setInventory] = useState<WorkloadInventory | null>(null);
  useEffect(() => { void invoke<WorkloadInventory>('list_workloads').then(setInventory); }, []);
  const [pod, setPod] = useState('');
  const [deployment, setDeployment] = useState('fraud-scoring');
  const [logPopupPod, setLogPopupPod] = useState('');

  return (
    <>
      <div className="title-row">
        <div>
          <h1>Workloads</h1>
          <p>Live Kubernetes resources from <b>prod-shark</b></p>
        </div>
      </div>
      <WorkloadsPage
        view={view}
        onViewChange={setView}
        pods={PODS}
        deployments={DEPLOYMENTS}
        selectedPod={pod}
        selectedDeployment={deployment}
        capabilities={{ deletePods: true, deleteDeployments: false, patchDeployments: true }}
        onSelectPod={setPod}
        onSelectDeployment={setDeployment}
        onDeletePod={() => undefined}
        onOpenPodLogs={setLogPopupPod}
        onExportPodLogs={() => undefined}
        onDeleteDeployment={() => undefined}
        onExportDeployment={() => undefined}
        podsLive
        usage={USAGE}
        usageAvailable
        usageReason=""
        controllers={<WorkloadInventoryTable inventory={inventory} loading={false} error="" selected="" canDelete onSelect={() => undefined} onEditYaml={() => undefined} onDelete={() => undefined} onExportYaml={() => undefined} canPatch={() => true} onScale={() => undefined} onRestart={() => undefined} />}
      />
      {logPopupPod && (
        <LogPopup
          context="prod-shark"
          namespace="payments"
          podName={logPopupPod}
          onExport={() => undefined}
          onClose={() => setLogPopupPod('')}
        />
      )}
      {deployment && (
        <DeploymentDetailPanel
          context="prod-shark"
          namespace="payments"
          deploymentName={deployment}
          onClose={() => setDeployment('')}
          onExport={() => undefined}
          exporting={false}
          onOpenLogs={() => undefined}
        />
      )}
    </>
  );
}
