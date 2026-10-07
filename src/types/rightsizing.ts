export type Confidence = 'none' | 'low' | 'medium' | 'high';

export type MissingNode = { node: string; reason: string };

export type CollectorCoverage = {
  nodes_total: number;
  nodes_covered: number;
  missing: MissingNode[];
  collector_found: boolean;
};

export type WorkloadRow = {
  namespace: string;
  kind: string;
  name: string;
  container: string;
  cpu_request_milli: number | null;
  cpu_p95_milli: number | null;
  mem_request_bytes: number | null;
  mem_max_bytes: number | null;
  cpu_waste_milli: number | null;
  mem_waste_bytes: number | null;
  waste_usd_month: number | null;
  confidence: Confidence;
  days_of_data: number;
  limited_data: boolean;
  oom_kills: number;
  throttle_ratio: number | null;
  recommended_cpu_milli: number | null;
  recommended_mem_bytes: number | null;
  /** False when the workload no longer exists live; the row is history. */
  live_spec: boolean;
};

export type SortKey = 'name' | 'cpu' | 'mem' | 'waste' | 'confidence';
export type SortDir = 'asc' | 'desc';
export const DETAIL_TABS = ['Overview', 'HPA', 'Resources'] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

/** One number for "how much is over-requested", so rows compare even without a price. */
export function wasteScore(row: WorkloadRow): number {
  if (row.waste_usd_month != null) return row.waste_usd_month;
  const cpu = (row.cpu_waste_milli ?? 0) / 1000;
  const mem = (row.mem_waste_bytes ?? 0) / (1024 * 1024 * 1024);
  return cpu + mem;
}

const CONFIDENCE_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3 };

export function sortRows(rows: WorkloadRow[], key: SortKey, dir: SortDir): WorkloadRow[] {
  const value = (row: WorkloadRow): number | string => {
    switch (key) {
      case 'name': return `${row.namespace}/${row.name}/${row.container}`;
      case 'cpu': return row.cpu_request_milli ?? -1;
      case 'mem': return row.mem_request_bytes ?? -1;
      case 'confidence': return CONFIDENCE_RANK[row.confidence] ?? 0;
      default: return wasteScore(row);
    }
  };
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a); const vb = value(b);
    const cmp = typeof va === 'string' && typeof vb === 'string'
      ? va.localeCompare(vb)
      : (va as number) - (vb as number);
    return cmp * sign || `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`);
  });
}

export function namespacesOf(rows: WorkloadRow[]): string[] {
  return [...new Set(rows.map((row) => row.namespace))].sort();
}

export type Recommendation = {
  cpu_request_milli: number | null;
  mem_request_bytes: number | null;
  confidence: Confidence;
  days_of_data: number;
  reason: string;
  would_reduce_cpu: boolean;
  would_reduce_mem: boolean;
};

export type WorkloadDetail = {
  row: WorkloadRow;
  recommendation: Recommendation;
  notice: string;
};

export type HpaSuggestion = {
  min_replicas: number;
  max_replicas: number;
  target_cpu_utilization: number;
  reason: string;
};

export type HpaStatus = {
  present: boolean;
  name: string | null;
  ours: boolean;
  yaml: string | null;
  desired_replicas: number | null;
  current_replicas: number | null;
  suggestion: HpaSuggestion;
  warnings: string[];
  blocks: string[];
  manager_enabled: boolean;
};

export type HpaPreview = {
  yaml: string;
  before: string;
  after: string;
  warnings: string[];
  blocks: string[];
};

/** Requests and limits for one container; null means not set, never zero. */
export type ResourceSet = {
  cpu_request_milli: number | null;
  cpu_limit_milli: number | null;
  mem_request_bytes: number | null;
  mem_limit_bytes: number | null;
};

export type ResourcesStatus = {
  current: ResourceSet;
  recommended: ResourceSet;
  replicas: number;
  ours: boolean;
  editor_enabled: boolean;
  warnings: string[];
  blocks: string[];
};

export type ResourcesPreview = {
  before: string;
  after: string;
  warnings: string[];
  blocks: string[];
};

/** What the editor form sends: the same four numbers, in the same units. */
export type ResourcesInput = {
  cpuRequestMilli: number | null;
  cpuLimitMilli: number | null;
  memRequestBytes: number | null;
  memLimitBytes: number | null;
};

const MIB = 1024 * 1024;

/** Inputs are edited in millicores and MiB; blank means "leave unset". */
export function resourcesInputFrom(set: ResourceSet): {
  cpuRequest: string; cpuLimit: string; memRequest: string; memLimit: string;
} {
  const milli = (v: number | null) => (v == null ? '' : String(Math.ceil(v)));
  const mib = (v: number | null) => (v == null ? '' : String(Math.ceil(v / MIB)));
  return {
    cpuRequest: milli(set.cpu_request_milli),
    cpuLimit: milli(set.cpu_limit_milli),
    memRequest: mib(set.mem_request_bytes),
    memLimit: mib(set.mem_limit_bytes),
  };
}

export function resourcesInputToRequest(fields: {
  cpuRequest: string; cpuLimit: string; memRequest: string; memLimit: string;
}): ResourcesInput {
  const num = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
  };
  const mibToBytes = (raw: string): number | null => {
    const value = num(raw);
    return value == null ? null : value * MIB;
  };
  return {
    cpuRequestMilli: num(fields.cpuRequest),
    cpuLimitMilli: num(fields.cpuLimit),
    memRequestBytes: mibToBytes(fields.memRequest),
    memLimitBytes: mibToBytes(fields.memLimit),
  };
}

export function workloadKey(row: WorkloadRow): string {
  return `${row.namespace}/${row.kind}/${row.name}/${row.container}`;
}

export function confidenceLabel(value: Confidence): string {
  switch (value) {
    case 'high': return 'High — a week or more of samples';
    case 'medium': return 'Medium — a few days of samples';
    case 'low': return 'Low — cold start, treat numbers as provisional';
    default: return 'No recommendation for this kind';
  }
}
