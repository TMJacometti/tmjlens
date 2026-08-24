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

/**
 * Which kinds each action applies to. Mirrors the dispatch in the Rust commands, so a
 * menu never offers what the backend would refuse.
 *
 * Scaling is only for kinds whose replica count is the operator's to set: a ReplicaSet
 * owned by a Deployment is scaled straight back by its controller, and a DaemonSet's
 * count is the node list.
 */
export function canScaleKind(kind: string): boolean {
  return kind === 'Deployment' || kind === 'StatefulSet';
}

/** Rollout restart rolls the pod template, which Jobs and CronJobs do not have live. */
export function canRestartKind(kind: string): boolean {
  return kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet';
}
