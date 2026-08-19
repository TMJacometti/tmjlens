import type { Severity } from './cluster';

export type KeyInfo = { key: string; bytes: number; binary: boolean };

export type ConfigMapInfo = {
  name: string;
  keys: KeyInfo[];
  total_bytes: number;
  immutable: boolean;
  used_by: string[];
  used_by_total: number;
  managed_by: string | null;
  age: string;
};

export type SecretInfo = ConfigMapInfo & {
  secret_type: string;
  purpose: string;
};

export type QuotaEntry = {
  resource: string;
  used: string;
  hard: string;
  percent: number | null;
  health: Severity | 'unknown';
};

export type QuotaInfo = {
  name: string;
  scopes: string[];
  entries: QuotaEntry[];
  health: Severity | 'unknown';
  age: string;
};

export type LimitRangeItemInfo = {
  item_type: string;
  resource: string;
  min: string | null;
  max: string | null;
  default_limit: string | null;
  default_request: string | null;
};

export type LimitRangeInfo = { name: string; items: LimitRangeItemInfo[]; age: string };

export type AutoscalerInfo = {
  name: string;
  target: string;
  min_replicas: number;
  max_replicas: number;
  current_replicas: number;
  desired_replicas: number;
  metrics: string[];
  health: Severity;
  reason: string;
  age: string;
};

export type DisruptionBudgetInfo = {
  name: string;
  requirement: string;
  current_healthy: number;
  desired_healthy: number;
  disruptions_allowed: number;
  expected_pods: number;
  health: Severity;
  reason: string;
  age: string;
};

export type LeaseInfo = {
  name: string;
  holder: string | null;
  renewed: string | null;
  duration_seconds: number | null;
  health: Severity;
  age: string;
};

export type PriorityClassInfo = {
  name: string;
  value: number;
  global_default: boolean;
  preemption: string;
  description: string;
  age: string;
};

export type RuntimeClassInfo = { name: string; handler: string; age: string };

export type WebhookInfo = {
  configuration: string;
  kind: 'Mutating' | 'Validating';
  webhook: string;
  failure_policy: string;
  timeout_seconds: number | null;
  rules: string[];
  service: string | null;
  service_exists: boolean | null;
  health: Severity | 'unknown';
  reason: string;
};

export type ConfigFinding = {
  severity: Severity;
  title: string;
  detail: string;
  targets: string[];
};

export type ConfigurationOverview = {
  namespace: string;
  config_maps: ConfigMapInfo[];
  secrets: SecretInfo[];
  quotas: QuotaInfo[];
  limit_ranges: LimitRangeInfo[];
  autoscalers: AutoscalerInfo[];
  disruption_budgets: DisruptionBudgetInfo[];
  leases: LeaseInfo[];
  priority_classes: PriorityClassInfo[];
  runtime_classes: RuntimeClassInfo[];
  webhooks: WebhookInfo[];
  findings: ConfigFinding[];
  degraded_collectors: string[];
};

/** One decoded value, fetched only when explicitly asked for. */
export type RevealedValue = {
  key: string;
  value: string | null;
  bytes: number;
  binary: boolean;
};

export const CONFIG_VIEWS = [
  'Config Maps',
  'Secrets',
  'Resource Quotas',
  'Limit Ranges',
  'Autoscalers',
  'Disruption Budgets',
  'Priority Classes',
  'Runtime Classes',
  'Leases',
  'Webhooks',
] as const;

export type ConfigView = (typeof CONFIG_VIEWS)[number];

export function configViewCount(data: ConfigurationOverview, view: ConfigView): number {
  switch (view) {
    case 'Config Maps': return data.config_maps.length;
    case 'Secrets': return data.secrets.length;
    case 'Resource Quotas': return data.quotas.length;
    case 'Limit Ranges': return data.limit_ranges.length;
    case 'Autoscalers': return data.autoscalers.length;
    case 'Disruption Budgets': return data.disruption_budgets.length;
    case 'Priority Classes': return data.priority_classes.length;
    case 'Runtime Classes': return data.runtime_classes.length;
    case 'Leases': return data.leases.length;
    case 'Webhooks': return data.webhooks.length;
  }
}

/** Which views hold something worth looking at, so the tab strip can say so. */
export function viewSeverity(data: ConfigurationOverview, view: ConfigView): Severity | null {
  const worst = (severities: Array<Severity | 'unknown'>): Severity | null => {
    const rank: Record<string, number> = { critical: 4, serious: 3, warning: 2, unknown: 1, good: 0 };
    const top = severities.reduce<string>((best, entry) => (rank[entry] > (rank[best] ?? 0) ? entry : best), 'good');
    return top === 'good' || top === 'unknown' ? null : (top as Severity);
  };

  switch (view) {
    case 'Resource Quotas': return worst(data.quotas.map((entry) => entry.health));
    case 'Autoscalers': return worst(data.autoscalers.map((entry) => entry.health));
    case 'Disruption Budgets': return worst(data.disruption_budgets.map((entry) => entry.health));
    case 'Leases': return worst(data.leases.map((entry) => entry.health));
    case 'Webhooks': return worst(data.webhooks.map((entry) => entry.health));
    default: return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * How a secret value is shown before it is revealed. A fixed-width mask rather than one
 * proportional to the value, because the length of a credential is itself a hint.
 */
export const SECRET_MASK = '••••••••••••';

/** Consumers, phrased so "nothing" is a sentence rather than an empty cell. */
export function describeConsumers(used: string[], total: number): string {
  if (total === 0) return 'No running pod references this';
  if (total <= used.length) return used.join(', ');
  return `${used.join(', ')} and ${total - used.length} more`;
}

/**
 * A lease is only meaningful while its holder keeps renewing it. Rendered as elapsed
 * time rather than a timestamp, because the question is always "how long ago".
 */
export function sinceRenewal(renewed: string | null, now: number): string {
  if (!renewed) return 'never renewed';
  const at = Date.parse(renewed);
  if (Number.isNaN(at)) return renewed;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
