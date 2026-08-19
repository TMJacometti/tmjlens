import { useState } from 'react';
import { DeployReportPage } from '../components/reports/DeployReportPage';
import { NamespacesPage } from '../components/namespaces/NamespacesPage';
import type { DeployReport, NamespaceOverview } from '../types/reports';

const NAMESPACES = [
  'default', 'kube-system', 'kube-public', 'payments', 'payments-jobs', 'ledger',
  'checkout', 'observability', 'argocd', 'cert-manager', 'istio-system', 'velero',
];

function report(namespaces: string[], window: string): DeployReport {
  const now = Date.now();
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

  const all = [
    {
      namespace: 'payments', name: 'checkout-api', kind: 'Deployment', deployed_at: at(42), age: '42m',
      images: ['registry.example.com/acme/checkout-api:1.9.0'], detail: '3/3 ready', health: 'good' as const,
      reason: 'All 3 replicas ready.', managed_by: 'Argo CD',
    },
    {
      namespace: 'payments', name: 'fraud-scoring', kind: 'Deployment', deployed_at: at(96), age: '1h',
      images: ['registry.example.com/acme/fraud-scoring:0.3.1'], detail: '0/2 ready', health: 'critical' as const,
      reason: 'None of 2 replicas are ready.', managed_by: 'Argo CD',
    },
    {
      namespace: 'payments', name: 'settlement-nightly', kind: 'CronJob', deployed_at: at(150), age: '2h',
      images: ['registry.example.com/acme/settlement:2.2.0'], detail: '0 2 * * *', health: 'good' as const,
      reason: 'Runs on schedule 0 2 * * *.', managed_by: 'Helm',
    },
    {
      namespace: 'payments-jobs', name: 'reindex-2026-08-19', kind: 'Job', deployed_at: at(28), age: '28m',
      images: ['registry.example.com/acme/reindex:1.0.4'], detail: '1/1 complete', health: 'good' as const,
      reason: 'Completed.', managed_by: null,
    },
    {
      namespace: 'payments-jobs', name: 'ledger-backfill', kind: 'Workflow', deployed_at: at(15), age: '15m',
      images: [], detail: 'Running', health: 'warning' as const,
      reason: 'Argo workflow, phase Running.', managed_by: null,
    },
    {
      namespace: 'ledger', name: 'ledger-reconciler', kind: 'StatefulSet', deployed_at: at(310), age: '5h',
      images: ['registry.example.com/acme/ledger:4.1.0'], detail: '2/2 ready', health: 'good' as const,
      reason: 'All 2 replicas ready.', managed_by: 'Helm',
    },
    {
      namespace: 'ledger', name: 'ledger-migrate-once', kind: 'Job', deployed_at: at(320), age: '5h',
      images: ['registry.example.com/acme/ledger:4.1.0'], detail: '0/1 complete', health: 'critical' as const,
      reason: '3 attempt(s) failed.', managed_by: null,
    },
    {
      namespace: 'observability', name: 'otel-collector', kind: 'DaemonSet', deployed_at: at(500), age: '8h',
      images: ['otel/opentelemetry-collector:0.104.0'], detail: '6/6 ready', health: 'good' as const,
      reason: 'All 6 replicas ready.', managed_by: 'Helm',
    },
  ];

  return {
    window,
    namespaces,
    items: all.filter((item) => namespaces.includes(item.namespace)),
    degraded_collectors: [],
  };
}

export function ReportPickerPreview() {
  const [result, setResult] = useState<DeployReport | null>(null);

  return (
    <>
      <div className="title-row">
        <div>
          <h1>Deploy report</h1>
          <p>What landed in <b>eks-cluster-prd</b>, for the namespaces you choose</p>
        </div>
      </div>
      <DeployReportPage
        namespaces={NAMESPACES}
        report={result}
        loading={false}
        error=""
        onRun={(chosen, window) => setResult(report(chosen, window))}
      />
    </>
  );
}

const NAMESPACE_FIXTURE: NamespaceOverview = {
  items: [
    {
      name: 'analytics-old', phase: 'Terminating', health: 'serious',
      reason: 'Deleting for 6d, held open by metrics.k8s.io/v1beta1. The controller behind that finalizer has to clear it — usually an API service or an operator that is no longer running.',
      pods: 0, pods_not_running: 0, has_quota: false, labels: [],
      finalizers: ['metrics.k8s.io/v1beta1'], age: '6d',
    },
    {
      name: 'argocd', phase: 'Active', health: 'good', reason: 'Active.', pods: 7, pods_not_running: 0,
      has_quota: false, labels: [], finalizers: [], age: '1y',
    },
    {
      name: 'default', phase: 'Active', health: 'good', reason: 'Active.', pods: 0, pods_not_running: 0,
      has_quota: false, labels: [], finalizers: [], age: '1y',
    },
    {
      name: 'kube-system', phase: 'Active', health: 'good', reason: 'Active.', pods: 24, pods_not_running: 1,
      has_quota: false, labels: [], finalizers: [], age: '1y',
    },
    {
      name: 'ledger', phase: 'Active', health: 'good', reason: 'Active.', pods: 6, pods_not_running: 0,
      has_quota: true, labels: ['pod-security.kubernetes.io/enforce=baseline'], finalizers: [], age: '214d',
    },
    {
      name: 'payments', phase: 'Active', health: 'good', reason: 'Active.', pods: 48, pods_not_running: 3,
      has_quota: true, labels: ['pod-security.kubernetes.io/enforce=restricted', 'app.kubernetes.io/part-of=payments'],
      finalizers: [], age: '214d',
    },
    {
      name: 'observability', phase: 'Active', health: 'good', reason: 'Active.', pods: 12, pods_not_running: 0,
      has_quota: false, labels: [], finalizers: [], age: '180d',
    },
  ],
  degraded_collectors: [],
};

export function NamespacesPreview() {
  const [current, setCurrent] = useState('payments');
  return (
    <>
      <div className="title-row">
        <div>
          <h1>Namespaces</h1>
          <p>Every namespace in <b>eks-cluster-prd</b>, and what is inside it</p>
        </div>
      </div>
      <NamespacesPage
        data={NAMESPACE_FIXTURE}
        loading={false}
        error=""
        current={current}
        onRefresh={() => undefined}
        onSelect={setCurrent}
      />
    </>
  );
}
