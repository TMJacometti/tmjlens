import type { Severity } from './cluster';

export type ClaimInfo = {
  name: string;
  phase: string;
  health: Severity;
  reason: string;
  requested: string | null;
  provisioned: string | null;
  over_provisioned: string | null;
  storage_class: string | null;
  access_modes: string[];
  volume_mode: string;
  volume: string | null;
  used_by: string[];
  used_by_total: number;
  age: string;
};

export type VolumeInfo = {
  name: string;
  phase: string;
  health: Severity;
  reason: string;
  capacity: string | null;
  reclaim_policy: string;
  storage_class: string | null;
  access_modes: string[];
  claim: string | null;
  claim_exists: boolean | null;
  source: string;
  handle: string | null;
  zones: string[];
  age: string;
};

export type StorageClassInfo = {
  name: string;
  provisioner: string;
  reclaim_policy: string;
  binding_mode: string;
  allow_expansion: boolean;
  is_default: boolean;
  parameters: string[];
  claims_using: number;
  health: Severity;
  reason: string;
  age: string;
};

export type StorageFinding = {
  severity: Severity;
  title: string;
  detail: string;
  targets: string[];
};

export type StorageOverview = {
  namespace: string;
  claims: ClaimInfo[];
  volumes: VolumeInfo[];
  classes: StorageClassInfo[];
  findings: StorageFinding[];
  degraded_collectors: string[];
};

export const STORAGE_VIEWS = ['Volume Claims', 'Volumes', 'Storage Classes'] as const;
export type StorageView = (typeof STORAGE_VIEWS)[number];

export function storageViewCount(data: StorageOverview, view: StorageView): number {
  if (view === 'Volume Claims') return data.claims.length;
  if (view === 'Volumes') return data.volumes.length;
  return data.classes.length;
}

/**
 * Parses a Kubernetes quantity into bytes. Mirrors the Rust parser, because the totals
 * on this screen are summed in the browser.
 *
 * Returns null for anything unrecognised, so an unparsed value is left out of a total
 * rather than counted as zero — a total that silently under-reports is worse than one
 * that says it is incomplete.
 */
export function parseStorage(raw: string | null): number | null {
  if (!raw) return null;
  const match = /^(-?[\d.]+)\s*([A-Za-z]*)$/.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;

  const multipliers: Record<string, number> = {
    '': 1,
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
    k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
    m: 1e-3,
  };
  const multiplier = multipliers[match[2]];
  return multiplier === undefined ? null : value * multiplier;
}

export function formatStorage(bytes: number): string {
  const units: Array<[number, string]> = [
    [1024 ** 5, 'Pi'], [1024 ** 4, 'Ti'], [1024 ** 3, 'Gi'], [1024 ** 2, 'Mi'], [1024, 'Ki'],
  ];
  for (const [size, suffix] of units) {
    if (bytes >= size) {
      const value = bytes / size;
      return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}${suffix}`;
    }
  }
  return `${Math.round(bytes)}B`;
}

export type CapacitySummary = {
  /** Capacity that is provisioned and mounted by something. */
  inUse: number;
  /** Bound to a claim, but no pod mounts it. Provisioned and billed regardless. */
  idle: number;
  /** Released volumes the cluster will never reuse. */
  stranded: number;
  total: number;
  /** Objects whose size could not be parsed, so the totals above exclude them. */
  unmeasured: number;
};

/**
 * Splits provisioned capacity into what is doing work and what is not.
 *
 * The claim side and the volume side describe the same disks, so counting both would
 * double. Claims are counted for anything bound, and volumes only for those no claim
 * covers any more.
 */
export function summariseCapacity(data: StorageOverview): CapacitySummary {
  let inUse = 0;
  let idle = 0;
  let stranded = 0;
  let unmeasured = 0;

  for (const claim of data.claims) {
    if (claim.phase !== 'Bound') continue;
    const bytes = parseStorage(claim.provisioned ?? claim.requested);
    if (bytes === null) {
      unmeasured += 1;
      continue;
    }
    if (claim.used_by_total > 0) inUse += bytes;
    else idle += bytes;
  }

  for (const volume of data.volumes) {
    if (volume.phase !== 'Released' && volume.phase !== 'Failed') continue;
    const bytes = parseStorage(volume.capacity);
    if (bytes === null) {
      unmeasured += 1;
      continue;
    }
    stranded += bytes;
  }

  return { inUse, idle, stranded, total: inUse + idle + stranded, unmeasured };
}

/**
 * How a volume's disk is named outside Kubernetes, shortened for a table cell.
 *
 * Azure and GCE hand back long resource paths whose last segment is the disk itself.
 * An NFS export or a URL also contains slashes but every part of it is needed to find
 * the thing again, so anything carrying a host is left whole.
 */
export function shortHandle(handle: string | null): string {
  if (!handle) return '—';
  if (handle.includes(':')) return handle;
  const segments = handle.split('/').filter(Boolean);
  return segments.length > 3 ? segments[segments.length - 1] : handle;
}

export function describeMounts(used: string[], total: number): string {
  if (total === 0) return 'Not mounted';
  if (total <= used.length) return used.join(', ');
  return `${used.join(', ')} and ${total - used.length} more`;
}
