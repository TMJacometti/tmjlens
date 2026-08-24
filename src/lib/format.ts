/** Millicores in, an operator-readable CPU string out: 250m, 1.5, 12 cores. */
export function formatCpu(milli: number | undefined): string {
  if (milli === undefined || Number.isNaN(milli)) return '—';
  if (milli < 1000) return `${Math.round(milli)}m`;
  const cores = milli / 1000;
  return cores < 10 ? `${cores.toFixed(1)} cores` : `${Math.round(cores)} cores`;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || Number.isNaN(bytes)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value < 10 && unit > 0 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function percent(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return (part / whole) * 100;
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  return `${Math.round(value)}%`;
}

export function formatClock(timestamp?: string): string {
  if (!timestamp) return '—';
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleTimeString();
}

export function formatRelative(timestamp?: string): string {
  if (!timestamp) return '—';
  const parsed = new Date(timestamp).getTime();
  if (Number.isNaN(parsed)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** Shortens ip-10-0-12-34.ec2.internal to something that fits an axis label. */
export function shortNodeName(name: string): string {
  const withoutDomain = name.split('.')[0];
  return withoutDomain.replace(/^ip-/, '');
}

/**
 * A pod's age from its creation time, mirroring the backend's format exactly.
 *
 * The watch only re-sends a pod when it changes, so the server-built age string
 * freezes at the last event. Rendering from the timestamp with a ticking clock keeps
 * ages honest without any traffic.
 */
export function ageFrom(createdAt: string, nowMs: number): string {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return 'n/a';
  const seconds = Math.max(0, Math.floor((nowMs - created) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
