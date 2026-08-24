import { useState } from 'react';
import { HelmPage } from '../components/helm/HelmPage';
import type { HelmOverview, ReleaseDetail, ReleaseRow } from '../types/helm';

/**
 * A cluster carrying every release state the screen exists to surface: healthy
 * releases, one whose upgrade failed, one stuck holding Helm's lock, and one already
 * uninstalled but keeping history. `?view=helm-nocli` renders the same data with no
 * helm binary on PATH, where uninstall and rollback explain themselves instead of
 * half-working.
 */
function fixture(cli: boolean): HelmOverview {
  return {
    cli_version: cli ? 'v3.15.2' : null,
    degraded_collectors: [],
    releases: [
      {
        name: 'payments-api', namespace: 'payments', status: 'failed', health: 'critical',
        reason: 'The last install or upgrade failed. Its resources may be mixed between versions.',
        revision: 41, revisions: 10, updated: '2h', updated_at: '2026-08-24T08:10:00Z',
      },
      {
        name: 'ledger-cache', namespace: 'ledger', status: 'pending-upgrade', health: 'serious',
        reason: "Stuck in pending-upgrade. This is Helm's lock: every new operation on this release is refused until it clears — usually by rolling back to the previous revision.",
        revision: 7, revisions: 7, updated: '3d', updated_at: '2026-08-21T09:00:00Z',
      },
      {
        name: 'cert-manager', namespace: 'cert-manager', status: 'deployed', health: 'good',
        reason: 'Deployed.', revision: 3, revisions: 3, updated: '88d', updated_at: '2026-05-28T10:00:00Z',
      },
      {
        name: 'ingress-nginx', namespace: 'ingress-nginx', status: 'deployed', health: 'good',
        reason: 'Deployed.', revision: 12, revisions: 10, updated: '19d', updated_at: '2026-08-05T15:30:00Z',
      },
      {
        name: 'legacy-exporter', namespace: 'observability', status: 'uninstalled', health: 'warning',
        reason: 'Uninstalled but its history is kept. Uninstalling it again removes the history too.',
        revision: 5, revisions: 5, updated: '61d', updated_at: '2026-06-24T12:00:00Z',
      },
    ],
  };
}

const DETAIL: ReleaseDetail = {
  name: 'payments-api',
  namespace: 'payments',
  revision: 41,
  chart: 'payments-api',
  chart_version: '5.3.0',
  app_version: '1.9.1',
  description: 'Upgrade "payments-api" failed: post-upgrade hooks failed: job payments-api-migrate failed',
  notes: 'Get the application URL:\n  https://payments.example.com\nDatabase migrations run as a post-upgrade hook.',
  values_yaml: 'image:\n  tag: 1.9.1\nreplicaCount: 4\nresources:\n  requests:\n    memory: 512Mi\n',
  manifest: '---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: payments-api\nspec:\n  replicas: 4\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: payments-api\n',
  first_deployed: '2026-01-12T09:00:00Z',
  last_deployed: '2026-08-24T08:10:00Z',
  history: [
    { revision: 41, status: 'failed', description: 'Upgrade "payments-api" failed: post-upgrade hooks failed: job payments-api-migrate failed', chart_version: '5.3.0', updated: '2h' },
    { revision: 40, status: 'superseded', description: 'Upgrade complete', chart_version: '5.2.1', updated: '6d' },
    { revision: 39, status: 'superseded', description: 'Upgrade complete', chart_version: '5.2.0', updated: '13d' },
  ],
};

export function HelmPreview({ cli = true }: { cli?: boolean }) {
  const [data] = useState<HelmOverview>(() => fixture(cli));

  const openDetail = async (row: ReleaseRow): Promise<ReleaseDetail> =>
    ({ ...DETAIL, name: row.name, namespace: row.namespace, revision: row.revision });

  return (
    <>
      <div className="title-row">
        <div>
          <h1>Helm</h1>
          <p>Releases installed in <b>eks-cluster-prd</b>, read from the cluster</p>
        </div>
      </div>
      <HelmPage
        data={data}
        loading={false}
        error=""
        onRefresh={() => undefined}
        onOpenDetail={openDetail}
        onUninstall={async () => undefined}
        onRollback={async () => undefined}
        notify={() => undefined}
      />
    </>
  );
}
