import type { CsvColumn } from '../lib/csv';
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

/**
 * The exported shape. Wider than the table on screen: an export is read in a
 * spreadsheet where extra columns cost nothing, and the full image reference matters
 * more there than the shortened one that fits a cell.
 */
export const DEPLOY_CSV_COLUMNS: Array<CsvColumn<DeployedRow>> = [
  { header: 'Namespace', value: (row) => row.namespace },
  { header: 'Workload', value: (row) => row.name },
  { header: 'Kind', value: (row) => row.kind },
  { header: 'State', value: (row) => row.health },
  { header: 'Detail', value: (row) => row.detail },
  { header: 'Reason', value: (row) => row.reason },
  { header: 'Images', value: (row) => row.images },
  { header: 'Deployed by', value: (row) => row.managed_by ?? 'by hand' },
  // Both forms: the local one is what a person reads, the ISO one is what sorts and
  // what another tool can parse.
  { header: 'Deployed at (local)', value: (row) => new Date(row.deployed_at).toLocaleString() },
  { header: 'Deployed at (UTC)', value: (row) => row.deployed_at },
];
