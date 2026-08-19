import { useState } from 'react';
import { ReportsPage, type RunRequest } from '../components/reports/ReportsPage';
import type { ReportKind, ReportResult, ReportRow } from '../types/insights';

const NAMESPACES = [
  'default', 'kube-system', 'payments', 'payments-jobs', 'ledger',
  'observability', 'argocd', 'cert-manager', 'istio-system', 'velero',
];

const KINDS: ReportKind[] = [
  { id: 'deployed', title: 'What was deployed', purpose: 'Workloads that did not exist in the cluster before the window began.', filters_namespaces: true, needs_window: true, needs_second_context: false },
  { id: 'change-trail', title: 'Change trail', purpose: 'What changed version, with the image it replaced. The report to open after an incident.', filters_namespaces: true, needs_window: true, needs_second_context: false },
  { id: 'idle-cost', title: 'Idle cost', purpose: 'Storage, config and workloads that are provisioned, billed, and doing nothing.', filters_namespaces: true, needs_window: false, needs_second_context: false },
  { id: 'upgrade-readiness', title: 'Upgrade readiness', purpose: 'What will block or disrupt a rolling node drain, before you start one.', filters_namespaces: true, needs_window: false, needs_second_context: false },
  { id: 'security-posture', title: 'Security posture', purpose: 'What runs with more privilege than it needs, per container.', filters_namespaces: true, needs_window: false, needs_second_context: false },
  { id: 'image-hygiene', title: 'Image hygiene', purpose: 'Every distinct image running and where, so a CVE can be traced in one pass.', filters_namespaces: true, needs_window: false, needs_second_context: false },
  { id: 'context-drift', title: 'Context comparison', purpose: 'The same namespaces in two clusters, and every way they differ.', filters_namespaces: true, needs_window: false, needs_second_context: true },
];

const row = (key: string, severity: ReportRow['severity'], cells: Record<string, string>): ReportRow =>
  ({ key, severity, cells });

/** One worked example per report, carrying the states each one exists to surface. */
const RESULTS: Record<string, ReportResult> = {
  deployed: {
    id: 'deployed', title: 'What was deployed',
    summary: '3 workload(s) deployed, 1 of them not running.',
    columns: [
      { key: 'namespace', header: 'Namespace', mono: true },
      { key: 'name', header: 'Workload', mono: true },
      { key: 'kind', header: 'Kind', mono: false },
      { key: 'detail', header: 'Detail', mono: true },
      { key: 'reason', header: 'State', mono: false },
      { key: 'by', header: 'Deployed by', mono: false },
      { key: 'at', header: 'At', mono: false },
    ],
    rows: [
      row('a', 'critical', { namespace: 'payments', name: 'fraud-scoring', kind: 'Deployment', detail: '0/2 ready', reason: 'None of 2 replicas are ready.', by: 'Argo CD', at: '2026-08-19 13:35' }),
      row('b', 'good', { namespace: 'payments', name: 'checkout-api', kind: 'Deployment', detail: '3/3 ready', reason: 'All 3 replicas ready.', by: 'Argo CD', at: '2026-08-19 14:29' }),
      row('c', 'good', { namespace: 'payments', name: 'settlement-nightly', kind: 'CronJob', detail: '0 2 * * *', reason: 'Runs on schedule 0 2 * * *.', by: 'Helm', at: '2026-08-19 12:41' }),
    ],
    degraded_collectors: [],
  },
  'idle-cost': {
    id: 'idle-cost', title: 'Idle cost',
    summary: '5 idle item(s), holding 1.7Ti of storage that is provisioned and billed.',
    columns: [
      { key: 'namespace', header: 'Namespace', mono: true },
      { key: 'kind', header: 'Kind', mono: false },
      { key: 'name', header: 'Name', mono: true },
      { key: 'amount', header: 'Amount', mono: true },
      { key: 'why', header: 'Why it is idle', mono: false },
      { key: 'age', header: 'Age', mono: false },
    ],
    rows: [
      row('a', 'critical', { namespace: 'payments', kind: 'PersistentVolume', name: 'pvc-3d1f8b66-2c9a-4e73', amount: '500Gi', why: 'Released with Retain: never reused, and billed until deleted by hand.', age: '311d' }),
      row('b', 'critical', { namespace: 'payments', kind: 'PersistentVolume', name: 'pvc-7b4e2a99-5f1d-4c86', amount: '200Gi', why: 'Released with Retain: never reused, and billed until deleted by hand.', age: '148d' }),
      row('c', 'serious', { namespace: 'payments', kind: 'PersistentVolumeClaim', name: 'ledger-archive', amount: '1000Gi', why: 'Bound to a volume that no running pod mounts.', age: '61d' }),
      row('d', 'warning', { namespace: 'payments', kind: 'Secret', name: 'stripe-webhook-signing', amount: '1 keys', why: 'No running pod reads it. It may still be read by something else.', age: '120d' }),
      row('e', 'warning', { namespace: 'payments-jobs', kind: 'Job', name: 'reindex-2026-07-02', amount: '48 days old', why: 'Completed long ago and never cleaned up. Set ttlSecondsAfterFinished.', age: '48d' }),
    ],
    degraded_collectors: [],
  },
  'upgrade-readiness': {
    id: 'upgrade-readiness', title: 'Upgrade readiness',
    summary: '4 item(s) to handle before upgrading, 2 of which will block a drain outright.',
    columns: [
      { key: 'namespace', header: 'Namespace', mono: true },
      { key: 'kind', header: 'Kind', mono: false },
      { key: 'name', header: 'Name', mono: true },
      { key: 'risk', header: 'Risk', mono: false },
      { key: 'effect', header: 'What happens on drain', mono: false },
    ],
    rows: [
      row('a', 'critical', { namespace: 'payments', kind: 'PodDisruptionBudget', name: 'checkout-api-pdb', risk: 'Allows no eviction', effect: 'A drain of any node running these pods blocks until the budget is met. 12 of 12 healthy.' }),
      row('b', 'critical', { namespace: 'ledger', kind: 'Pod', name: 'debug-shell', risk: 'No controller', effect: 'Draining its node deletes it permanently. Nothing will recreate it.' }),
      row('c', 'serious', { namespace: 'ledger', kind: 'StatefulSet', name: 'ledger-cache', risk: 'Single replica', effect: 'Stateful and unreplicated: the drain takes it offline with no standby.' }),
      row('d', 'warning', { namespace: 'cluster', kind: 'Node', name: 'ip-10-0-52-9', risk: 'Cordoned', effect: 'Already unschedulable. Evicted pods cannot land here.' }),
    ],
    degraded_collectors: [],
  },
  'security-posture': {
    id: 'security-posture', title: 'Security posture',
    summary: '5 finding(s), 2 of them serious enough to be a way onto the node.',
    columns: [
      { key: 'namespace', header: 'Namespace', mono: true },
      { key: 'workload', header: 'Workload', mono: true },
      { key: 'container', header: 'Container', mono: true },
      { key: 'risk', header: 'Risk', mono: false },
      { key: 'detail', header: 'Detail', mono: false },
    ],
    rows: [
      row('a', 'critical', { namespace: 'observability', workload: 'DaemonSet/otel-collector', container: '—', risk: 'hostNetwork', detail: "Shares the node's network stack, so it can reach anything the node can and bypasses NetworkPolicy." }),
      row('b', 'critical', { namespace: 'observability', workload: 'DaemonSet/otel-collector', container: 'collector', risk: 'Privileged', detail: 'Effectively root on the node, with every capability.' }),
      row('c', 'serious', { namespace: 'payments', workload: 'Deployment/checkout-api', container: 'api', risk: 'Unpinned image', detail: 'acme/checkout-api:latest is not pinned to a version, so what runs after a restart is not what runs now.' }),
      row('d', 'serious', { namespace: 'ledger', workload: '—', container: '—', risk: 'No network policy', detail: 'Nothing restricts traffic in or out of this namespace; every pod can reach every other.' }),
      row('e', 'warning', { namespace: 'payments', workload: 'Deployment/checkout-api', container: 'api', risk: 'Mounts its API token', detail: 'The service account token is mounted whether or not it is used. Set automountServiceAccountToken: false unless it calls the API.' }),
    ],
    degraded_collectors: [],
  },
  'image-hygiene': {
    id: 'image-hygiene', title: 'Image hygiene',
    summary: '4 distinct image(s) running, 1 not pinned to a version.',
    columns: [
      { key: 'registry', header: 'Registry', mono: true },
      { key: 'repository', header: 'Repository', mono: true },
      { key: 'tag', header: 'Tag', mono: true },
      { key: 'namespaces', header: 'Namespaces', mono: true },
      { key: 'workloads', header: 'Workloads', mono: true },
      { key: 'pods', header: 'Pods', mono: false },
      { key: 'note', header: 'Note', mono: false },
    ],
    rows: [
      row('a', 'serious', { registry: 'registry.example.com', repository: 'acme/checkout-api', tag: 'latest', namespaces: 'payments', workloads: 'Deployment/checkout-api', pods: '3', note: 'Not pinned. What runs after the next restart is not necessarily what runs now.' }),
      row('b', 'warning', { registry: 'docker.io', repository: 'library/postgres', tag: '16.2', namespaces: 'ledger', workloads: 'StatefulSet/postgres', pods: '3', note: 'Pulled from Docker Hub, which rate-limits and is outside your control.' }),
      row('c', 'good', { registry: 'registry.example.com', repository: 'acme/ledger', tag: '4.1.0', namespaces: 'ledger', workloads: 'StatefulSet/ledger-reconciler', pods: '2', note: 'Pinned to a version.' }),
      row('d', 'good', { registry: 'otel', repository: 'opentelemetry-collector', tag: '0.104.0', namespaces: 'observability', workloads: 'DaemonSet/otel-collector', pods: '6', note: 'Pinned to a version.' }),
    ],
    degraded_collectors: [],
  },
  'change-trail': {
    id: 'change-trail', title: 'Change trail',
    summary: '3 rollout(s) in the selected namespaces.',
    columns: [
      { key: 'namespace', header: 'Namespace', mono: true },
      { key: 'workload', header: 'Workload', mono: true },
      { key: 'revision', header: 'Revision', mono: false },
      { key: 'changed', header: 'What changed', mono: true },
      { key: 'at', header: 'At', mono: false },
    ],
    rows: [
      row('a', 'warning', { namespace: 'payments', workload: 'checkout-api', revision: '48', changed: 'api: checkout-api:1.8.4 → checkout-api:1.9.0', at: '2026-08-19 14:29' }),
      row('b', 'warning', { namespace: 'payments', workload: 'fraud-scoring', revision: '12', changed: 'scorer: fraud-scoring:0.3.0 → fraud-scoring:0.3.1', at: '2026-08-19 13:35' }),
      row('c', 'warning', { namespace: 'ledger', workload: 'ledger-api', revision: '31', changed: 'no image change — configuration or a restart', at: '2026-08-19 09:12' }),
    ],
    degraded_collectors: [],
  },
  'context-drift': {
    id: 'context-drift', title: 'Context comparison',
    summary: '3 difference(s) between eks-cluster-prd and eks-cluster-hml, 1 of them a different image.',
    columns: [
      { key: 'namespace', header: 'Namespace', mono: true },
      { key: 'kind', header: 'Kind', mono: false },
      { key: 'name', header: 'Name', mono: true },
      { key: 'here', header: 'eks-cluster-prd', mono: true },
      { key: 'there', header: 'eks-cluster-hml', mono: true },
      { key: 'difference', header: 'Difference', mono: false },
    ],
    rows: [
      row('a', 'critical', { namespace: 'payments', kind: 'Deployment', name: 'checkout-api', here: 'checkout-api:1.9.0', there: 'checkout-api:1.8.4', difference: 'Different image.' }),
      row('b', 'serious', { namespace: 'payments', kind: 'CronJob', name: 'settlement-nightly', here: 'present', there: 'absent', difference: 'Missing from eks-cluster-hml.' }),
      row('c', 'warning', { namespace: 'ledger', kind: 'Deployment', name: 'ledger-api', here: '6 replicas', there: '1 replicas', difference: 'Different replica count.' }),
    ],
    degraded_collectors: [],
  },
};

export function ReportsPreview() {
  const [result, setResult] = useState<ReportResult | null>(null);

  const run = (request: RunRequest) => setResult(RESULTS[request.report] ?? null);

  return (
    <>
      <div className="title-row">
        <div>
          <h1>Reports</h1>
          <p>Seven questions about <b>eks-cluster-prd</b>, answered on demand</p>
        </div>
      </div>
      <ReportsPage
        kinds={KINDS}
        namespaces={NAMESPACES}
        contexts={['eks-cluster-prd', 'eks-cluster-hml', 'aks-shared-dev']}
        currentContext="eks-cluster-prd"
        result={result}
        loading={false}
        error=""
        exporting={false}
        onRun={run}
        onExport={() => undefined}
      />
    </>
  );
}
