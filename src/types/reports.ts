import type { Severity } from '../components/cluster/charts';

export type DeployedRow = {
  namespace: string;
  name: string;
  kind: string;
  deployed_at: string;
  age: string;
  images: string[];
  detail: string;
  health: Severity;
  reason: string;
  managed_by: string | null;
};

export type DeployReport = {
  window: string;
  namespaces: string[];
  items: DeployedRow[];
  degraded_collectors: string[];
};

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

export const REPORT_WINDOWS: Array<{ id: string; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
];

export function windowLabel(id: string): string {
  return REPORT_WINDOWS.find((entry) => entry.id === id)?.label ?? 'Today';
}

/** Registry paths are the same for every image in a cluster; the tag is what differs. */
export function shortImage(image: string): string {
  const withoutRegistry = image.includes('/') ? image.slice(image.lastIndexOf('/') + 1) : image;
  return withoutRegistry;
}

/** Local time, because a report is read against the reader's own day. */
export function formatDeployTime(stamp: string): string {
  const at = new Date(stamp);
  if (Number.isNaN(at.getTime())) return stamp;
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatDeployDate(stamp: string): string {
  const at = new Date(stamp);
  if (Number.isNaN(at.getTime())) return stamp;
  return at.toLocaleDateString(undefined, { month: 'short', day: '2-digit' });
}

/** Groups a report by namespace, so several selected namespaces stay legible. */
export function groupByNamespace(items: DeployedRow[]): Array<[string, DeployedRow[]]> {
  const groups = new Map<string, DeployedRow[]>();
  for (const item of items) {
    const bucket = groups.get(item.namespace);
    if (bucket) bucket.push(item);
    else groups.set(item.namespace, [item]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

/** The one line worth putting at the top of a report. */
export function summarise(report: DeployReport): string {
  const total = report.items.length;
  if (total === 0) return 'Nothing was deployed in the selected namespaces.';

  const broken = report.items.filter((item) => item.health === 'critical').length;
  const partial = report.items.filter((item) => item.health === 'warning').length;
  const noun = total === 1 ? 'workload' : 'workloads';
  const scope = report.namespaces.length === 1
    ? report.namespaces[0]
    : `${report.namespaces.length} namespaces`;

  if (broken > 0) return `${total} ${noun} in ${scope}, ${broken} not running.`;
  if (partial > 0) return `${total} ${noun} in ${scope}, ${partial} not fully ready.`;
  return `${total} ${noun} in ${scope}, all running.`;
}
