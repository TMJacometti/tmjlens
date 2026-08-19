import { useState } from 'react';
import { WorkloadsPage } from '../components/workloads/WorkloadsPage';
import { DeploymentDetailPanel } from '../components/workloads/DeploymentDetailPanel';

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

export function WorkloadsPreview() {
  const [view, setView] = useState<'Pods' | 'Deployments'>('Deployments');
  const [pod, setPod] = useState('');
  const [deployment, setDeployment] = useState('fraud-scoring');

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
        onExportPodLogs={() => undefined}
        onDeleteDeployment={() => undefined}
        onScaleDeployment={() => undefined}
        onRestartDeployment={() => undefined}
        onExportDeployment={() => undefined}
      />
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
