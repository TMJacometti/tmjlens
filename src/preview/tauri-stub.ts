import type { KubeconfigView } from '../types/settings';

/**
 * Minimal stand-in for the Tauri IPC bridge.
 *
 * `@tauri-apps/api` dispatches through `window.__TAURI_INTERNALS__.invoke`, which only
 * exists inside the desktop shell. Defining it here lets the preview exercise the real
 * components in a browser. Preview-only: never imported by the app entry point.
 */
const KUBECONFIG: KubeconfigView = {
  path: 'C:\\Users\\operator\\.kube\\config',
  writable: true,
  current_context: 'arn:aws:eks:sa-east-1:123456789012:cluster/prod-shark',
  contexts: [
    {
      name: 'arn:aws:eks:sa-east-1:123456789012:cluster/prod-shark',
      current: true,
      cluster: 'arn:aws:eks:sa-east-1:123456789012:cluster/prod-shark',
      user: 'arn:aws:eks:sa-east-1:123456789012:cluster/prod-shark',
      namespace: 'payments',
      server: 'https://A1B2C3D4.gr7.sa-east-1.eks.amazonaws.com',
      auth_method: 'exec plugin',
      environment: 'production',
    },
    {
      name: 'aks-hml-shark',
      current: false,
      cluster: 'aks-hml-shark',
      user: 'clusterUser_rg-shark_aks-hml-shark',
      namespace: 'checkout',
      server: 'https://hml-shark-a1b2.hcp.brazilsouth.azmk8s.io:443',
      auth_method: 'exec plugin',
      environment: 'staging',
    },
    {
      name: 'minikube',
      current: false,
      cluster: 'minikube',
      user: 'minikube',
      server: 'https://127.0.0.1:6443',
      auth_method: 'client certificate',
      environment: 'development',
    },
  ],
};

/** A rollout stuck because the ReplicaSet cannot create pods — the case the
 *  Deployment's own events would never explain on their own. */
const DEPLOYMENT_DETAIL = {
  name: 'fraud-scoring',
  namespace: 'payments',
  replicas_desired: 4,
  replicas_ready: 1,
  replicas_updated: 4,
  replicas_available: 1,
  strategy: 'RollingUpdate',
  image_summary: 'registry.internal/fraud:2.14.0 and 1 more',
  selector: ['app=fraud-scoring', 'tier=backend'],
  containers: [
    { name: 'wait-for-db', image: 'busybox:1.36', kind: 'init' },
    { name: 'fraud-scoring', image: 'registry.internal/fraud:2.14.0', kind: 'container' },
    { name: 'envoy-sidecar', image: 'envoyproxy/envoy:v1.29.1', kind: 'container' },
  ],
  pods: ['fraud-scoring-58f7c6d9b4-lm3nq', 'fraud-scoring-58f7c6d9b4-w8ptr'],
  conditions: [
    { kind: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable', message: 'Deployment does not have minimum availability.', healthy: false },
    { kind: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: 'ReplicaSet "fraud-scoring-58f7c6d9b4" has timed out progressing.', healthy: false },
  ],
  events: [
    { reason: 'FailedCreate', message: 'Error creating: pods "fraud-scoring-58f7c6d9b4-" is forbidden: exceeded quota: compute-resources, requested: limits.memory=2Gi, used: limits.memory=14Gi, limited: limits.memory=15Gi', kind: 'ReplicaSet', name: 'fraud-scoring-58f7c6d9b4', severity: 'critical', count: 27, timestamp: new Date(Date.now() - 120000).toISOString(), age: '2m' },
    { reason: 'ImagePullBackOff', message: 'Back-off pulling image "registry.internal/fraud:2.14.0"', kind: 'Pod', name: 'fraud-scoring-58f7c6d9b4-lm3nq', severity: 'critical', count: 14, timestamp: new Date(Date.now() - 300000).toISOString(), age: '5m' },
    { reason: 'FailedScheduling', message: '0/7 nodes are available: 3 Insufficient memory, 2 node(s) had untolerated taint {workload: batch}, 2 Insufficient cpu.', kind: 'Pod', name: 'fraud-scoring-58f7c6d9b4-w8ptr', severity: 'critical', count: 8, timestamp: new Date(Date.now() - 600000).toISOString(), age: '10m' },
    { reason: 'ScalingReplicaSet', message: 'Scaled up replica set fraud-scoring-58f7c6d9b4 to 4', kind: 'Deployment', name: 'fraud-scoring', severity: 'good', count: 1, timestamp: new Date(Date.now() - 900000).toISOString(), age: '15m' },
  ],
};

const DEPLOYMENT_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  annotations:
    deployment.kubernetes.io/revision: "7"
  creationTimestamp: "2026-08-06T11:20:31Z"
  generation: 12
  managedFields:
  - apiVersion: apps/v1
    fieldsType: FieldsV1
    manager: kubectl-client-side-apply
  name: fraud-scoring
  namespace: payments
  resourceVersion: "88213764"
  uid: 4f2c7a10-9d3e-4c5b-8a71-2b6e0d9f1a34
spec:
  replicas: 4
  selector:
    matchLabels:
      app: fraud-scoring
status:
  availableReplicas: 1
  observedGeneration: 12
  readyReplicas: 1
`;

type Internals = { invoke: (command: string, args?: unknown) => Promise<unknown> };

export function installTauriStub() {
  const host = window as unknown as { __TAURI_INTERNALS__?: Internals };
  if (host.__TAURI_INTERNALS__) return;

  host.__TAURI_INTERNALS__ = {
    invoke: async (command) => {
      switch (command) {
        case 'read_kubeconfig':
          return KUBECONFIG;
        case 'get_deployment_detail':
          return DEPLOYMENT_DETAIL;
        case 'export_deployment_yaml':
          return DEPLOYMENT_YAML;
        case 'load_settings':
          return { context_environments: {}, confirm_destructive_in_production: true };
        case 'save_settings':
        case 'set_current_context':
        case 'set_context_namespace':
          return null;
        default:
          throw new Error(`preview stub has no answer for "${command}"`);
      }
    },
  };
}
