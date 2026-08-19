import type { Severity } from './cluster';

export type NamespaceInfo = {
  name: string;
  phase: string;
  health: Severity;
  reason: string;
  pods: number;
  pods_not_running: number;
  has_quota: boolean;
  labels: string[];
  finalizers: string[];
  age: string;
};

export type NamespaceOverview = {
  items: NamespaceInfo[];
  degraded_collectors: string[];
};
