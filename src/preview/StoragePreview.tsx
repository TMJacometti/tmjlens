import { useState } from 'react';
import { StoragePage } from '../components/storage/StoragePage';
import type { StorageOverview } from '../types/storage';

/**
 * A namespace carrying every state the screen exists to surface: a claim doing work, a
 * claim bound to a volume nothing mounts, one still Pending, one whose volume is gone,
 * an over-provisioned claim, released volumes still being billed, and a storage class
 * that binds immediately.
 */
const FIXTURE: StorageOverview = {
  namespace: 'payments',
  claims: [
    {
      name: 'data-postgres-0', phase: 'Bound', health: 'good', reason: 'Mounted by 1 pod(s).',
      requested: '100Gi', provisioned: '100Gi', over_provisioned: null, storage_class: 'gp3',
      access_modes: ['ReadWriteOnce'], volume_mode: 'Filesystem', volume: 'pvc-8f3a2c11-4d5e-4a9b-9c11-2f7e6a1b3d40',
      used_by: ['postgres-0'], used_by_total: 1, age: '214d',
    },
    {
      name: 'data-postgres-1', phase: 'Bound', health: 'good', reason: 'Mounted by 1 pod(s).',
      requested: '100Gi', provisioned: '100Gi', over_provisioned: null, storage_class: 'gp3',
      access_modes: ['ReadWriteOnce'], volume_mode: 'Filesystem', volume: 'pvc-1c9b7e22-8a3f-4b21-b7c4-9d2e5f8a1c63',
      used_by: ['postgres-1'], used_by_total: 1, age: '214d',
    },
    {
      name: 'data-postgres-2', phase: 'Bound', health: 'warning',
      reason: 'Bound but not mounted by any running pod. The volume is provisioned and billed.',
      requested: '100Gi', provisioned: '100Gi', over_provisioned: null, storage_class: 'gp3',
      access_modes: ['ReadWriteOnce'], volume_mode: 'Filesystem', volume: 'pvc-5e2d9a44-1b8c-4f37-a0d9-6c4b2e9f7a15',
      used_by: [], used_by_total: 0, age: '214d',
    },
    {
      name: 'ledger-archive', phase: 'Bound', health: 'warning',
      reason: 'Bound but not mounted by any running pod. The volume is provisioned and billed.',
      requested: '500Gi', provisioned: '1000Gi', over_provisioned: '1000Gi provisioned for a 500Gi request',
      storage_class: 'io2', access_modes: ['ReadWriteOnce'], volume_mode: 'Filesystem',
      volume: 'pvc-9a7c3e55-6d2b-4c18-8e5a-3f1d7b9c2e46', used_by: [], used_by_total: 0, age: '61d',
    },
    {
      name: 'reporting-scratch', phase: 'Pending', health: 'serious',
      reason: 'No volume has been bound. Usually no storage class matched, or the class waits for a pod to be scheduled first.',
      requested: '20Gi', provisioned: null, over_provisioned: null, storage_class: 'fast-nvme',
      access_modes: ['ReadWriteOnce'], volume_mode: 'Filesystem', volume: null,
      used_by: [], used_by_total: 0, age: '2h',
    },
    {
      name: 'legacy-uploads', phase: 'Lost', health: 'critical',
      reason: 'The volume backing this claim no longer exists. Data written to it is gone.',
      requested: '50Gi', provisioned: '50Gi', over_provisioned: null, storage_class: 'gp2',
      access_modes: ['ReadWriteMany'], volume_mode: 'Filesystem', volume: 'pvc-deleted-by-hand',
      used_by: [], used_by_total: 0, age: '1y',
    },
  ],
  volumes: [
    {
      name: 'pvc-8f3a2c11-4d5e-4a9b-9c11-2f7e6a1b3d40', phase: 'Bound', health: 'good', reason: 'In use.',
      capacity: '100Gi', reclaim_policy: 'Delete', storage_class: 'gp3', access_modes: ['ReadWriteOnce'],
      claim: 'payments/data-postgres-0', claim_exists: true, source: 'ebs.csi.aws.com',
      handle: 'vol-0a1b2c3d4e5f60718', zones: ['eu-west-1a'], age: '214d',
    },
    {
      name: 'pvc-1c9b7e22-8a3f-4b21-b7c4-9d2e5f8a1c63', phase: 'Bound', health: 'good', reason: 'In use.',
      capacity: '100Gi', reclaim_policy: 'Delete', storage_class: 'gp3', access_modes: ['ReadWriteOnce'],
      claim: 'payments/data-postgres-1', claim_exists: true, source: 'ebs.csi.aws.com',
      handle: 'vol-0b2c3d4e5f6071829', zones: ['eu-west-1b'], age: '214d',
    },
    {
      name: 'pvc-3d1f8b66-2c9a-4e73-9b16-8a5d4c2f1e07', phase: 'Released', health: 'serious',
      reason: 'Its claim is gone but the disk is retained. Kubernetes will never reuse this volume, and the cloud provider keeps billing for it until it is deleted.',
      capacity: '500Gi', reclaim_policy: 'Retain', storage_class: 'io2', access_modes: ['ReadWriteOnce'],
      claim: 'payments/analytics-warehouse', claim_exists: false, source: 'ebs.csi.aws.com',
      handle: 'vol-0c3d4e5f60718293a', zones: ['eu-west-1a'], age: '311d',
    },
    {
      name: 'pvc-7b4e2a99-5f1d-4c86-a3e7-1d9c8b2f6a54', phase: 'Released', health: 'serious',
      reason: 'Its claim is gone but the disk is retained. Kubernetes will never reuse this volume, and the cloud provider keeps billing for it until it is deleted.',
      capacity: '200Gi', reclaim_policy: 'Retain', storage_class: 'io2', access_modes: ['ReadWriteOnce'],
      claim: 'payments/staging-restore-test', claim_exists: false, source: 'ebs.csi.aws.com',
      handle: 'vol-0d4e5f60718293a4b', zones: ['eu-west-1c'], age: '148d',
    },
    {
      name: 'nfs-shared-reports', phase: 'Available', health: 'good', reason: 'Free, waiting for a claim.',
      capacity: '2Ti', reclaim_policy: 'Retain', storage_class: null, access_modes: ['ReadWriteMany'],
      claim: null, claim_exists: null, source: 'nfs', handle: 'nfs.internal:/exports/reports',
      zones: [], age: '2y',
    },
  ],
  classes: [
    {
      name: 'gp3', provisioner: 'ebs.csi.aws.com', reclaim_policy: 'Delete',
      binding_mode: 'WaitForFirstConsumer', allow_expansion: true, is_default: true,
      parameters: ['type=gp3', 'iops=3000'], claims_using: 3, health: 'good',
      reason: 'Deleting a claim destroys the data behind it.', age: '1y',
    },
    {
      name: 'io2', provisioner: 'ebs.csi.aws.com', reclaim_policy: 'Retain',
      binding_mode: 'WaitForFirstConsumer', allow_expansion: true, is_default: false,
      parameters: ['type=io2', 'iopsPerGB=50'], claims_using: 1, health: 'good',
      reason: 'Waits for a pod, expandable, retains data.', age: '1y',
    },
    {
      name: 'fast-nvme', provisioner: 'ebs.csi.aws.com', reclaim_policy: 'Delete',
      binding_mode: 'Immediate', allow_expansion: false, is_default: false,
      parameters: ['type=io2'], claims_using: 1, health: 'warning',
      reason: 'Binds immediately, so the volume picks a zone before a pod is scheduled — on a multi-zone cluster this can leave pods unschedulable. Volumes from this class cannot be grown later. Deleting a claim destroys the data behind it.',
      age: '90d',
    },
    {
      name: 'gp2', provisioner: 'kubernetes.io/aws-ebs', reclaim_policy: 'Delete',
      binding_mode: 'Immediate', allow_expansion: false, is_default: false,
      parameters: ['type=gp2'], claims_using: 1, health: 'warning',
      reason: 'Binds immediately, so the volume picks a zone before a pod is scheduled — on a multi-zone cluster this can leave pods unschedulable. Volumes from this class cannot be grown later. Deleting a claim destroys the data behind it.',
      age: '2y',
    },
  ],
  findings: [
    {
      severity: 'critical',
      title: "A claim's volume no longer exists",
      detail: 'Whatever was written to it is gone. The claim has to be recreated and restored from a backup.',
      targets: ['legacy-uploads'],
    },
    {
      severity: 'serious',
      title: 'Released volumes are still being billed',
      detail: 'Their claims are gone and the reclaim policy is Retain, so Kubernetes will never reuse them and the cloud provider keeps charging. Each one has to be deleted by hand once its data is confirmed unneeded.',
      targets: [
        'pvc-3d1f8b66-2c9a-4e73-9b16-8a5d4c2f1e07 · 500Gi · vol-0c3d4e5f60718293a',
        'pvc-7b4e2a99-5f1d-4c86-a3e7-1d9c8b2f6a54 · 200Gi · vol-0d4e5f60718293a4b',
      ],
    },
    {
      severity: 'serious',
      title: 'A claim has no volume',
      detail: 'Any pod that mounts it stays Pending. Either no storage class matched, or the class waits for a pod to be scheduled and none can be.',
      targets: ['reporting-scratch'],
    },
    {
      severity: 'warning',
      title: 'Bound but not mounted',
      detail: 'No running pod mounts these claims, yet their volumes are provisioned and billed. A stopped StatefulSet or a scaled-down workload is the usual reason, and the data is still there.',
      targets: ['data-postgres-2 · 100Gi', 'ledger-archive · 1000Gi'],
    },
    {
      severity: 'warning',
      title: 'More storage provisioned than requested',
      detail: 'The bound volume is larger than the claim asked for, and the larger figure is what the provider bills.',
      targets: ['ledger-archive · 1000Gi provisioned for a 500Gi request'],
    },
  ],
  degraded_collectors: [],
};

export function StoragePreview() {
  const [data] = useState<StorageOverview>(() => FIXTURE);

  return (
    <>
      <div className="title-row">
        <div>
          <h1>Storage</h1>
          <p>Volume claims, volumes and storage classes for <b>payments</b></p>
        </div>
      </div>
      <StoragePage data={data} loading={false} error="" onRefresh={() => undefined} />
    </>
  );
}
