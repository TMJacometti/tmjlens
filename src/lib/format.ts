/** Millicores in, an operator-readable CPU string out: 250m, 1.5, 12 cores. */
// The == null guards catch BOTH null and undefined: Rust's Option<f64> arrives
// over the wire as JSON null, which `=== undefined` lets straight through to
// .toFixed — a node the metrics server has not measured yet must render as
// '—', not take the whole overview down.
export function formatCpu(milli: number | null | undefined): string {
  if (milli == null || Number.isNaN(milli)) return '—';
  if (milli < 1000) return `${Math.round(milli)}m`;
  const cores = milli / 1000;
  return cores < 10 ? `${cores.toFixed(1)} cores` : `${Math.round(cores)} cores`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return '—';
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

const MI = 1024 * 1024;
const GI = MI * 1024;

/**
 * Memory the way kubectl prints a quantity: a whole number of Gi is "4Gi", a
 * whole number of Mi is "3000Mi" — never "2.9 GiB" for what the manifest
 * says is 3000Mi. Anything that is not a whole binary unit falls back to
 * formatBytes.
 */
export function formatMemoryQuantity(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes >= GI && Number.isInteger(bytes / GI)) return `${bytes / GI}Gi`;
  if (bytes >= MI && Number.isInteger(bytes / MI)) return `${bytes / MI}Mi`;
  return formatBytes(bytes);
}

/**
 * A request beside a measurement, e.g. "3000Mi / 2252Mi": the measurement is
 * printed in the request's unit so the two compare at a glance.
 */
export function formatMemoryPair(request: number | null | undefined, measured: number | null | undefined): string {
  const left = formatMemoryQuantity(request);
  if (measured == null || Number.isNaN(measured)) return `${left} / —`;
  if (left.endsWith('Gi')) return `${left} / ${(measured / GI).toFixed(measured / GI < 10 ? 1 : 0)}Gi`;
  if (left.endsWith('Mi')) return `${left} / ${Math.round(measured / MI)}Mi`;
  return `${left} / ${formatBytes(measured)}`;
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

export function formatPercent(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
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
