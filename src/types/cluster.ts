export type Severity = 'good' | 'warning' | 'serious' | 'critical';

export type Provider = 'eks' | 'aks' | 'gke' | 'generic';

export type ControlPlane = {
  provider: Provider;
  /** Display name for the distribution, e.g. "Amazon EKS" or "Kubernetes". */
  distribution: string;
  endpoint: string;
  kubernetes_version: string;
  control_plane_minor?: number;
  cluster_name?: string;
  region?: string;
  /** AWS account, Azure subscription, or GCP project, depending on the provider. */
  account_id?: string;
  account_label?: string;
  provider_status?: string;
  /** Provider-specific control plane build, e.g. the EKS platform version. */
  provider_version?: string;
  oidc_issuer?: string;
  metrics_available: boolean;
};

export type HealthSignal = {
  name: string;
  score: number;
  weight: number;
  detail: string;
  severity: Severity;
};

export type HealthSummary = {
  score: number;
  grade: string;
  headline: string;
  signals: HealthSignal[];
};

/** CPU is millicores, memory is bytes. The backend never pre-formats. */
export type ResourceAxis = {
  allocatable: number;
  requested: number;
  limits: number;
  used?: number;
};

export type CapacitySummary = {
  cpu: ResourceAxis;
  memory: ResourceAxis;
  pod_slots: { used: number; allocatable: number };
};

export type NodeCondition = {
  kind: string;
  status: string;
  reason?: string;
  message?: string;
  healthy: boolean;
};

export type TaintEffect = 'NoExecute' | 'NoSchedule' | 'PreferNoSchedule';

export type NodeTaint = {
  key: string;
  value?: string;
  effect: TaintEffect | string;
  /** `key=value:Effect`, the form kubectl prints and tolerations are written against. */
  label: string;
};

export type NodePodInfo = {
  name: string;
  namespace: string;
  status: string;
  restarts: number;
  cpu_requested_milli: number;
  memory_requested_bytes: number;
};

export type NodeInfo = {
  name: string;
  ready: boolean;
  health: Severity;
  roles: string[];
  kubelet_version: string;
  kubelet_minor?: number;
  instance_type: string;
  capacity_type: string;
  node_pool?: string;
  zone: string;
  architecture: string;
  os_image: string;
  container_runtime: string;
  age: string;
  cpu_allocatable_milli: number;
  cpu_requested_milli: number;
  cpu_limit_milli: number;
  cpu_used_milli?: number;
  memory_allocatable_bytes: number;
  memory_requested_bytes: number;
  memory_limit_bytes: number;
  memory_used_bytes?: number;
  pod_count: number;
  pod_capacity: number;
  conditions: NodeCondition[];
  taints: NodeTaint[];
  pressure_reasons: string[];
  pressure: boolean;
  unschedulable: boolean;
  pods: NodePodInfo[];
};

export type ProblemPod = {
  name: string;
  namespace: string;
  node?: string;
  phase: string;
  reason: string;
  message?: string;
  restarts: number;
  age: string;
  severity: Severity;
};

export type PodUsage = {
  name: string;
  namespace: string;
  cpu_used_milli: number;
  cpu_requested_milli: number;
};

export type Bucket = { label: string; value: number };

export type PodSummary = {
  total: number;
  running: number;
  ready: number;
  pending: number;
  failed: number;
  succeeded: number;
  unknown: number;
  total_restarts: number;
  by_phase: Bucket[];
  by_namespace: Bucket[];
  problems: ProblemPod[];
  top_restarts: ProblemPod[];
  top_cpu: PodUsage[];
};

export type WorkloadBucket = { total: number; degraded: number };

export type DegradedWorkload = {
  kind: string;
  namespace: string;
  name: string;
  ready: number;
  desired: number;
};

export type WorkloadSummary = {
  deployments: WorkloadBucket;
  statefulsets: WorkloadBucket;
  daemonsets: WorkloadBucket;
  degraded: DegradedWorkload[];
};

export type ZoneBucket = {
  zone: string;
  nodes: number;
  ready_nodes: number;
  pods: number;
  cpu_allocatable_milli: number;
  memory_allocatable_bytes: number;
};

export type Distribution = {
  zones: ZoneBucket[];
  instance_types: Bucket[];
  capacity_types: Bucket[];
  node_pools: Bucket[];
  taints: Bucket[];
  kubelet_versions: Bucket[];
};

export type WarningEvent = {
  reason: string;
  message: string;
  kind: string;
  name: string;
  namespace?: string;
  count: number;
  timestamp?: string;
};

export type EventSummary = {
  warning_count: number;
  truncated: boolean;
  by_reason: Bucket[];
  recent: WarningEvent[];
};

export type Finding = {
  severity: Severity;
  title: string;
  detail: string;
  count: number;
  targets: string[];
  hint: string;
};

export type ClusterOverview = {
  context: string;
  generated_at: string;
  control_plane: ControlPlane;
  health: HealthSummary;
  capacity: CapacitySummary;
  nodes: NodeInfo[];
  pods: PodSummary;
  workloads: WorkloadSummary;
  distribution: Distribution;
  events: EventSummary;
  findings: Finding[];
  degraded_collectors: string[];
};

export type NodeAction = 'cordon' | 'uncordon' | 'drain' | 'delete';
