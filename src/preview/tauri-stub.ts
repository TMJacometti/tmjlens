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

const SERVICE_YAML = `apiVersion: v1
kind: Service
metadata:
  creationTimestamp: "2026-07-19T09:14:02Z"
  labels:
    app: fraud-scoring
  name: fraud-scoring
  namespace: payments
  resourceVersion: "88213764"
  uid: 4f2c7a10-9d3e-4c5b-8a71-2b6e0d9f1a34
spec:
  clusterIP: 10.96.201.7
  internalTrafficPolicy: Cluster
  ipFamilies:
  - IPv4
  ports:
  - name: http
    port: 8080
    protocol: TCP
    targetPort: 8080
  selector:
    app: fraud-scoring
  sessionAffinity: None
  type: ClusterIP
status:
  loadBalancer: {}
`;

const WORKLOAD_INVENTORY = {
  rows: [
    { kind: 'Deployment', name: 'fraud-scoring', namespace: 'payments', ready: 1, desired: 4, unit: 'replicas', detail: '1 of 4 replicas ready', health: 'serious', suspended: false, images: ['registry.internal/fraud:2.14.0', 'envoyproxy/envoy:v1.29.1'], age: '12d' },
    { kind: 'StatefulSet', name: 'postgres', namespace: 'payments', ready: 0, desired: 2, unit: 'replicas', detail: '0 of 2 replicas ready, in order', health: 'critical', suspended: false, images: ['postgres:16.3'], age: '90d' },
    { kind: 'DaemonSet', name: 'fluent-bit', namespace: 'payments', ready: 5, desired: 7, unit: 'nodes', detail: '5 of 7 eligible nodes ready, 1 misscheduled', health: 'serious', suspended: false, images: ['fluent/fluent-bit:3.0.7'], age: '210d' },
    { kind: 'Job', name: 'ledger-backfill-29187360', namespace: 'payments', ready: 0, desired: 1, unit: 'completions', detail: '0 of 1 completions, 4 failed attempt(s)', health: 'critical', suspended: false, images: ['registry.internal/backfill:1.4.2'], age: '3h' },
    { kind: 'CronJob', name: 'nightly-reconcile', namespace: 'payments', ready: 0, desired: 0, unit: 'active runs', detail: 'suspended · 0 3 * * * · last run 19h ago', health: 'warning', suspended: true, images: ['registry.internal/reconcile:3.1.0'], age: '120d' },
    { kind: 'Deployment', name: 'checkout-api', namespace: 'payments', ready: 3, desired: 3, unit: 'replicas', detail: '3 of 3 replicas ready', health: 'good', suspended: false, images: ['registry.internal/checkout:5.2.1'], age: '31d' },
    { kind: 'CronJob', name: 'hourly-export', namespace: 'payments', ready: 1, desired: 1, unit: 'active runs', detail: '0 * * * * · last run 12m ago', health: 'good', suspended: false, images: ['registry.internal/export:2.0.0'], age: '88d' },
    { kind: 'Job', name: 'schema-migrate-29187100', namespace: 'payments', ready: 1, desired: 1, unit: 'completions', detail: 'completed 1 of 1', health: 'good', suspended: false, images: ['registry.internal/migrate:5.2.1'], age: '2d' },
  ],
  degraded_collectors: [],
};

type Internals = {
  invoke: (command: string, args?: unknown) => Promise<unknown>;
  transformCallback: (callback: (payload: unknown) => void, once?: boolean) => number;
};

/**
 * Tauri delivers events by storing a callback on `window` under a generated id and
 * calling it from the host. Reproducing that here is what lets the preview exercise
 * the streaming log viewer, which is driven entirely by events rather than by invoke.
 */
const pendingCallbacks = new Map<number, (payload: unknown) => void>();
const listeners = new Map<number, { event: string; handler: (payload: unknown) => void }>();
let nextCallbackId = 1;

export function emitPreviewEvent(event: string, payload: unknown) {
  for (const [id, entry] of listeners) {
    if (entry.event === event) entry.handler({ event, id, payload });
  }
}

let streaming: ReturnType<typeof setInterval> | undefined;

function startPreviewStream(streamId: string) {
  stopPreviewStream();
  let counter = 0;
  streaming = setInterval(() => {
    const lines = Array.from({ length: 3 }, () => {
      counter += 1;
      const level = counter % 11 === 0 ? 'WARN ' : counter % 17 === 0 ? 'ERROR' : 'INFO ';
      return `2026-08-19T13:${String(counter % 60).padStart(2, '0')}:12.418Z ${level} [checkout] request ${counter} handled in ${8 + (counter % 40)}ms`;
    });
    emitPreviewEvent('pod-log', { stream_id: streamId, lines });
  }, 350);
}

function stopPreviewStream() {
  if (streaming) clearInterval(streaming);
  streaming = undefined;
}

export function installTauriStub() {
  const host = window as unknown as { __TAURI_INTERNALS__?: Internals };
  if (host.__TAURI_INTERNALS__) return;

  host.__TAURI_INTERNALS__ = {
    transformCallback: (callback) => {
      const id = nextCallbackId++;
      pendingCallbacks.set(id, callback);
      return id;
    },
    invoke: async (command, args) => {
      switch (command) {
        case 'read_kubeconfig':
          return KUBECONFIG;
        case 'get_deployment_detail':
          return DEPLOYMENT_DETAIL;
        case 'export_deployment_yaml':
          return DEPLOYMENT_YAML;
        case 'get_resource_yaml':
          return SERVICE_YAML;
        case 'apply_resource_yaml':
          return SERVICE_YAML;
        case 'save_bytes_to_downloads':
          return 'C:\\Users\\operator\\Downloads\\preview.yaml';
        case 'get_pod_logs':
          return Array.from({ length: 40 }, (_, index) =>
            `2026-08-19T12:${String(index % 60).padStart(2, '0')}:03.117Z INFO  [checkout] startup step ${index + 1} complete`,
          ).join('\n');
        case 'start_log_stream':
          startPreviewStream((args as { streamId: string }).streamId);
          return null;
        case 'stop_log_stream':
          stopPreviewStream();
          return null;
        case 'plugin:event|listen': {
          const { event, handler } = args as { event: string; handler: number };
          const stored = pendingCallbacks.get(handler);
          if (stored) listeners.set(handler, { event, handler: stored });
          return handler;
        }
        case 'plugin:event|unlisten': {
          listeners.delete((args as { eventId: number }).eventId);
          return null;
        }
        case 'list_workloads':
          return WORKLOAD_INVENTORY;
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
