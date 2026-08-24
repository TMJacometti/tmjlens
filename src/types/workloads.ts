import type { Severity } from './cluster';

export type ContainerSpec = {
  name: string;
  image: string;
  /** `container` or `init` — init containers run to completion before the rest start. */
  kind: 'container' | 'init' | string;
};

export type WorkloadEvent = {
  reason: string;
  message: string;
  /** The object the event is about: Deployment, ReplicaSet or Pod. */
  kind: string;
  name: string;
  severity: Severity;
  count: number;
  timestamp?: string;
  age: string;
};

export type WorkloadCondition = {
  kind: string;
  status: string;
  reason?: string;
  message?: string;
  healthy: boolean;
};

export type DeploymentDetail = {
  name: string;
  namespace: string;
  replicas_desired: number;
  replicas_ready: number;
  replicas_updated: number;
  replicas_available: number;
  strategy: string;
  image_summary: string;
  selector: string[];
  containers: ContainerSpec[];
  pods: string[];
  conditions: WorkloadCondition[];
  events: WorkloadEvent[];
};

export type PodRow = { name: string; status: string; ready: string; age: string; created_at?: string | null };
export type DeploymentRow = { name: string; ready: number; desired: number; available: number; age: string };

/** A pod is only healthy when it is Running *and* every container is ready. */
export function podSeverity(pod: PodRow): Severity {
  if (pod.status === 'Succeeded') return 'good';
  if (pod.status === 'Failed' || pod.status === 'Unknown') return 'critical';
  if (pod.status !== 'Running') return 'warning';
  const [ready, total] = pod.ready.split('/').map(Number);
  if (Number.isFinite(ready) && Number.isFinite(total) && ready < total) return 'serious';
  return 'good';
}

export function deploymentSeverity(deployment: DeploymentRow): Severity {
  if (deployment.desired === 0) return 'good';
  if (deployment.ready === 0) return 'critical';
  if (deployment.ready < deployment.desired) return 'serious';
  return 'good';
}
