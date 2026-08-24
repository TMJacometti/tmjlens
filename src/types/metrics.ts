import type { Severity } from './cluster';
import { formatStorage } from './storage';

export type ContainerUsage = {
  name: string;
  cpu_milli: number | null;
  memory_bytes: number | null;
  cpu_request_milli: number;
  cpu_limit_milli: number;
  memory_request_bytes: number;
  memory_limit_bytes: number;
};

export type PodUsageRow = {
  name: string;
  cpu_milli: number | null;
  memory_bytes: number | null;
  cpu_request_milli: number;
  cpu_limit_milli: number;
  memory_request_bytes: number;
  memory_limit_bytes: number;
  containers: ContainerUsage[];
  sampled_at: string | null;
  window: string | null;
};

export type PodMetricsSnapshot = {
  available: boolean;
  reason: string | null;
  pods: PodUsageRow[];
};

export function formatCpuMilli(milli: number): string {
  if (milli < 1) return '<1m';
  if (milli < 1000) return `${Math.round(milli)}m`;
  const cores = milli / 1000;
  return cores >= 10 ? `${Math.round(cores)} cores` : `${cores.toFixed(1)} cores`;
}

/** Memory reuses the storage formatter so 512Mi reads the same on every screen. */
export function formatMemoryBytes(bytes: number): string {
  return formatStorage(bytes);
}

/** Percent of a bound, or null when there is no bound — a meter needs a real edge. */
export function pctOf(value: number | null, bound: number): number | null {
  if (value === null || bound <= 0) return null;
  return (value / bound) * 100;
}

/**
 * Memory against its limit is the OOMKill distance: the kernel kills the container at
 * 100%, so proximity is a real state, not a style.
 */
export function memorySeverity(pct: number | null): Severity | null {
  if (pct === null) return null;
  if (pct >= 95) return 'critical';
  if (pct >= 85) return 'serious';
  if (pct >= 70) return 'warning';
  return 'good';
}

/**
 * CPU at its limit is throttling — latency, not death. It never outranks warning,
 * because painting a compressible resource critical would bury the memory rows that
 * actually kill pods.
 */
export function cpuSeverity(pct: number | null): Severity | null {
  if (pct === null) return null;
  return pct >= 100 ? 'warning' : 'good';
}

export function sampleAgeSeconds(sampledAt: string | null, nowMs: number): number | null {
  if (!sampledAt) return null;
  const at = new Date(sampledAt).getTime();
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((nowMs - at) / 1000));
}

/** "sample 12s old · 30s window" — the screen says how live "live" actually is. */
export function describeSample(row: PodUsageRow, nowMs: number): string {
  const age = sampleAgeSeconds(row.sampled_at, nowMs);
  const parts: string[] = [];
  if (age !== null) parts.push(`sample ${age}s old`);
  if (row.window) parts.push(`${row.window} window`);
  return parts.join(' · ');
}
