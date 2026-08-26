import { useState } from 'react';
import { ArgoPage } from '../components/argo/ArgoPage';
import type { ArgoOverview, ImageSlot } from '../types/argo';

/**
 * An Argo installation carrying the states the screen exists to surface: a failed run
 * with the step named, a run mid-flight with progress, a suspended cron, a template
 * whose containerSet holds several images, and one whose steps run no image at all.
 */
function fixture(): ArgoOverview {
  const now = Date.now();
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

  const etlImages: ImageSlot[] = [
    { template: 'extract', container: 'main', image: 'registry.example.com/acme/extractor:2.4.1' },
    { template: 'transform', container: 'main', image: 'registry.example.com/acme/transformer:2.4.1' },
    { template: 'load', container: 'main', image: 'registry.example.com/acme/loader:2.3.0' },
  ];

  return {
    installed: true,
    reason: null,
    degraded_collectors: [],
    workflows: [
      {
        name: 'nightly-etl-8kx2m', namespace: 'payments-jobs', phase: 'Failed', health: 'critical',
        reason: 'child node nightly-etl-8kx2m.transform failed: OOMKilled (exit code 137)',
        progress: '1/3', started_at: ago(95), duration: '12m 4s', from_template: 'nightly-etl', age: '1h',
      },
      {
        name: 'ledger-backfill-p9qrt', namespace: 'payments-jobs', phase: 'Running', health: 'warning',
        reason: 'Running · 2/5 nodes done.', progress: '2/5', started_at: ago(8), duration: null,
        from_template: 'ledger-backfill', age: '8m',
      },
      {
        name: 'nightly-etl-7ttw4', namespace: 'payments-jobs', phase: 'Succeeded', health: 'good',
        reason: 'Completed.', progress: '3/3', started_at: ago(60 * 25), duration: '9m 41s',
        from_template: 'nightly-etl', age: '1d',
      },
      {
        name: 'report-render-2zzq8', namespace: 'reporting', phase: 'Pending', health: 'warning',
        reason: 'Waiting to start — check quota and scheduling.', progress: null, started_at: null,
        duration: null, from_template: null, age: '22m',
      },
    ],
    cron_workflows: [
      {
        name: 'nightly-etl', namespace: 'payments-jobs', schedule: '0 2 * * *', suspended: false,
        health: 'good', reason: 'Scheduled.', last_scheduled: ago(95), images: etlImages, age: '214d',
      },
      {
        name: 'weekly-reconcile', namespace: 'payments-jobs', schedule: '0 4 * * 1', suspended: true,
        health: 'warning', reason: 'Suspended — it will not run on its schedule.',
        last_scheduled: ago(60 * 24 * 9),
        images: [{ template: 'reconcile', container: 'main', image: 'registry.example.com/acme/reconciler:5.1.0' }],
        age: '180d',
      },
    ],
    templates: [
      { name: 'ledger-backfill', namespace: 'payments-jobs', entrypoint: 'backfill', images: [
        { template: 'backfill', container: 'main', image: 'registry.example.com/acme/backfill:1.9.2' },
        { template: 'publish', container: 'push', image: 'registry.example.com/acme/pusher:3.1.0' },
        { template: 'publish', container: 'sign', image: 'registry.example.com/acme/signer:1.0.0' },
      ], age: '61d' },
      { name: 'nightly-etl', namespace: 'payments-jobs', entrypoint: 'etl', images: etlImages, age: '214d' },
      { name: 'orchestrator', namespace: 'reporting', entrypoint: 'flow', images: [], age: '90d' },
    ],
  };
}

const NOT_INSTALLED: ArgoOverview = {
  installed: false,
  reason: 'Argo Workflows is not installed in this cluster — its custom resources are absent.',
  workflows: [], cron_workflows: [], templates: [], degraded_collectors: [],
};

export function ArgoPreview({ installed = true }: { installed?: boolean }) {
  const [data, setData] = useState<ArgoOverview>(() => (installed ? fixture() : NOT_INSTALLED));

  return (
    <>
      <div className="title-row">
        <div>
          <h1>Argo Workflows</h1>
          <p>Runs, cron workflows and templates in <b>eks-cluster-prd</b>, read from the cluster</p>
        </div>
      </div>
      <ArgoPage
        data={data}
        loading={false}
        error=""
        capabilities={{ patchTemplates: true, patchCrons: true, createWorkflows: true, deleteWorkflows: true }}
        onRefresh={() => undefined}
        onSetImage={async (target, slot, image) => {
          // The preview applies the edit locally so the flow can be exercised end to end.
          setData((current) => ({
            ...current,
            templates: current.templates.map((row) =>
              row.name === target.name && target.kind === 'WorkflowTemplate'
                ? { ...row, images: row.images.map((entry) => (entry.template === slot.template && entry.container === slot.container ? { ...entry, image } : entry)) }
                : row,
            ),
          }));
        }}
        onSuspendCron={async () => undefined}
        onSubmitTemplate={async () => undefined}
        onStopWorkflow={async () => undefined}
        onDeleteWorkflow={async () => undefined}
      />
    </>
  );
}
