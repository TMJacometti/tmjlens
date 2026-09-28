export type Confidence = 'none' | 'low' | 'medium' | 'high';

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
};

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
