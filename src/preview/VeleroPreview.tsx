import { useState } from 'react';
import { VeleroPage } from '../components/velero/VeleroPage';
import type { VeleroStatus } from '../types/velero';

/**
 * A Velero installation carrying every state the screen exists to surface: a healthy
 * nightly backup, one that finished partially, one that failed outright, one about to
 * expire, a paused schedule, and a storage location Velero cannot reach.
 *
 * Timestamps are relative to render so "expires within 24h" is exercised rather than
 * being frozen at a date that has since passed.
 */
function fixture(): VeleroStatus {
  const now = Date.now();
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const inHours = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

  return {
    installed: true,
    namespace: 'velero',
    reason: null,
    backups: [
      {
        name: 'nightly-full-20260819-020000', phase: 'Completed', health: 'good',
        included_namespaces: ['all namespaces'], storage_location: 'default',
        started: at(11), completed: at(10.9), expires: inHours(24 * 30),
        age: '11h', items_backed_up: 4218, errors: 0, warnings: 0, caveat: null,
      },
      {
        name: 'payments-preupgrade-20260818-1640', phase: 'PartiallyFailed', health: 'serious',
        included_namespaces: ['payments', 'payments-jobs'], storage_location: 'default',
        started: at(20), completed: at(19.6), expires: inHours(9),
        age: '20h', items_backed_up: 611, errors: 4, warnings: 2,
        caveat: 'Finished with 4 error(s): some resources are missing from this backup.',
      },
      {
        name: 'ledger-adhoc-20260818-0912', phase: 'Failed', health: 'critical',
        included_namespaces: ['ledger'], storage_location: 'cold-archive',
        started: at(28), completed: at(27.9), expires: inHours(24 * 6),
        age: '28h', items_backed_up: null, errors: 1, warnings: 0,
        caveat: 'This backup did not complete. Do not restore from it.',
      },
      {
        name: 'nightly-full-20260818-020000', phase: 'Completed', health: 'good',
        included_namespaces: ['all namespaces'], storage_location: 'default',
        started: at(35), completed: at(34.8), expires: at(2),
        age: '35h', items_backed_up: 4190, errors: 0, warnings: 3,
        caveat: '3 warning(s) during backup.',
      },
      {
        name: 'checkout-api-manual-20260819-1130', phase: 'InProgress', health: 'warning',
        included_namespaces: ['payments'], storage_location: 'default',
        started: at(0.3), completed: null, expires: null,
        age: '18m', items_backed_up: 140, errors: 0, warnings: 0, caveat: null,
      },
    ],
    restores: [
      {
        name: 'restore-payments-20260818-1712', backup: 'payments-preupgrade-20260818-1640',
        phase: 'Completed', health: 'good', started: at(19), completed: at(18.7),
        age: '19h', errors: 0, warnings: 5,
      },
      {
        name: 'restore-ledger-20260818-0950', backup: 'ledger-adhoc-20260818-0912',
        phase: 'PartiallyFailed', health: 'serious', started: at(27), completed: at(26.8),
        age: '27h', errors: 9, warnings: 1,
      },
    ],
    schedules: [
      { name: 'nightly-full', cron: '0 2 * * *', paused: false, last_backup: at(11), phase: 'Enabled', health: 'good', age: '214d' },
      { name: 'hourly-payments', cron: '0 * * * *', paused: true, last_backup: at(96), phase: 'Enabled', health: 'warning', age: '61d' },
    ],
    locations: [
      {
        name: 'default', provider: 'aws', bucket: 'acme-velero-prod', prefix: 'clusters/prod-eu',
        phase: 'Available', health: 'good', is_default: true, last_synced: at(0.15), access_mode: 'ReadWrite',
      },
      {
        name: 'cold-archive', provider: 'aws', bucket: 'acme-velero-archive', prefix: null,
        phase: 'Unavailable', health: 'serious', is_default: false, last_synced: at(51), access_mode: 'ReadOnly',
      },
    ],
    degraded_collectors: [],
  };
}

const NOT_INSTALLED: VeleroStatus = {
  installed: false,
  namespace: 'velero',
  reason: 'Velero is not installed in this cluster, or its custom resources are absent (looked in namespace velero).',
  backups: [], restores: [], schedules: [], locations: [], degraded_collectors: [],
};

/** The exact error an operator sees once their cloud session lapses, as tmjLens explains it. */
const EXPIRED_SESSION = [
  'Your AWS session has expired. Sign in again in a terminal with `aws sso login`, then select Try again.',
  'tmjLens does not hold cloud credentials. It runs the command your kubeconfig names and passes the token ' +
    'straight to the cluster, keeping nothing on disk — so the sign-in has to happen in that tool.',
  `auth error: auth exec command '"aws" "--region" "us-west-2" "eks" "get-token" "--cluster-name" ` +
    `"eks-cluster-prd" "--output" "json"' failed with status exit code: 255`,
].join('\n\n');

export function VeleroPreview({ installed = true, expired = false }: { installed?: boolean; expired?: boolean }) {
  const [status] = useState<VeleroStatus | null>(() => (expired ? null : installed ? fixture() : NOT_INSTALLED));

  return (
    <>
      <div className="title-row">
        <div>
          <h1>Velero</h1>
          <p>Backups, restores and schedules read from the cluster</p>
        </div>
      </div>
      <VeleroPage
        status={status}
        loading={false}
        error={expired ? EXPIRED_SESSION : ''}
        namespaces={['default', 'payments', 'payments-jobs', 'ledger', 'kube-system', 'velero', 'observability']}
        canBackup
        canRestore
        onRefresh={() => undefined}
        onCreateBackup={async () => undefined}
        onCreateRestore={async () => undefined}
      />
    </>
  );
}
