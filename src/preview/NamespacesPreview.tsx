import { useState } from 'react';
import { NamespacesPage } from '../components/namespaces/NamespacesPage';
import type { NamespaceOverview } from '../types/reports';

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
  // The app's toast lives in App; the preview mirrors it with a plain line so
  // notification behaviour is assertable here too.
  const [note, setNote] = useState('');
  const [current, setCurrent] = useState('payments');
  return (
    <>
      <div className="title-row">
        <div>
          <h1>Namespaces</h1>
          <p>Every namespace in <b>eks-cluster-prd</b>, and what is inside it</p>
        </div>
      </div>
      {note && <p className="ns-preview-note" role="status">{note}</p>}
      <NamespacesPage
        data={NAMESPACE_FIXTURE}
        loading={false}
        error=""
        current={current}
        canManage onRefresh={() => undefined} onCreate={async () => undefined} onDelete={async () => undefined} onForceFinalize={async () => 'Removed the finalizers holding datadog: datadoghq.com/agent-cleanup'} notify={(text, detail) => setNote(detail ? `${text} — ${detail}` : text)}
        onSelect={setCurrent}
      />
    </>
  );
}
