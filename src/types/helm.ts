import type { Severity } from './cluster';

export type ReleaseRow = {
  name: string;
  namespace: string;
  status: string;
  health: Severity;
  reason: string;
  revision: number;
  revisions: number;
  updated: string;
  updated_at: string | null;
};

export type HelmOverview = {
  releases: ReleaseRow[];
  cli_version: string | null;
  degraded_collectors: string[];
};

export type RevisionInfo = {
  revision: number;
  status: string;
  description: string;
  chart_version: string;
  updated: string;
};

export type ReleaseDetail = {
  name: string;
  namespace: string;
  revision: number;
  chart: string;
  chart_version: string;
  app_version: string;
  description: string;
  notes: string;
  values_yaml: string;
  manifest: string;
  first_deployed: string | null;
  last_deployed: string | null;
  history: RevisionInfo[];
};

export const DETAIL_TABS = ['Overview', 'History', 'Values', 'Manifest'] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

/** A release stuck in Helm's lock — the state operators actually get paged about. */
export function isStuck(status: string): boolean {
  return status === 'pending-install' || status === 'pending-upgrade' || status === 'pending-rollback';
}

/** Local time for the reader; the raw stamp stays available for tooling. */
export function formatDeployedAt(stamp: string | null): string {
  if (!stamp) return '—';
  const at = new Date(stamp);
  if (Number.isNaN(at.getTime())) return stamp;
  return at.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
