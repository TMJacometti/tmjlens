import type { Severity } from './cluster';

/**
 * One row shape for every controller kind. What "ready" counts differs per kind —
 * replicas, eligible nodes, completions — so the unit travels with the numbers.
 */
export type WorkloadRow = {
  kind: string;
  name: string;
  namespace: string;
  ready: number;
  desired: number;
  unit: string;
  detail: string;
  health: Severity;
  suspended: boolean;
  images: string[];
  age: string;
};

export type WorkloadInventory = {
  rows: WorkloadRow[];
  degraded_collectors: string[];
};

export const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'ReplicaSet'] as const;
