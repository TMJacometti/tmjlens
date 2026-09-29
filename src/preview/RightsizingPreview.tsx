import { RightsizingPage } from '../components/rightsizing/RightsizingPage';
import type { HpaStatus, WorkloadDetail, WorkloadRow } from '../types/rightsizing';

const ROWS: WorkloadRow[] = [
  {
    namespace: 'shop', kind: 'Deployment', name: 'checkout', container: 'api',
    cpu_request_milli: 500, cpu_p95_milli: 80, mem_request_bytes: 512 * 1024 * 1024,
    mem_max_bytes: 120 * 1024 * 1024, cpu_waste_milli: 390, mem_waste_bytes: 300 * 1024 * 1024,
    waste_usd_month: 42, confidence: 'high', days_of_data: 9, limited_data: false,
    oom_kills: 0, throttle_ratio: 0.01, recommended_cpu_milli: 110, recommended_mem_bytes: 144 * 1024 * 1024,
  },
  {
    namespace: 'shop', kind: 'Deployment', name: 'payments', container: 'api',
    cpu_request_milli: 200, cpu_p95_milli: 190, mem_request_bytes: 256 * 1024 * 1024,
    mem_max_bytes: 240 * 1024 * 1024, cpu_waste_milli: null, mem_waste_bytes: null,
    waste_usd_month: null, confidence: 'low', days_of_data: 0.5, limited_data: true,
    oom_kills: 1, throttle_ratio: 0.2, recommended_cpu_milli: 200, recommended_mem_bytes: 256 * 1024 * 1024,
  },
];

const DETAIL: WorkloadDetail = {
  row: ROWS[0],
  recommendation: {
    cpu_request_milli: 110, mem_request_bytes: 144 * 1024 * 1024, confidence: 'high',
    days_of_data: 9,
    reason: 'CPU request ≈ p95 (80m) + 10% headroom. Memory request ≈ peak working set + 20% headroom. Mean is not used. 9.0 day(s) of data; confidence is high.',
    would_reduce_cpu: true, would_reduce_mem: true,
  },
  notice: 'Reducing requests only lowers the bill if the node autoscaler consolidates nodes.',
};

const HPA: HpaStatus = {
  present: false, name: null, ours: false, yaml: null, desired_replicas: null, current_replicas: 2,
  suggestion: { min_replicas: 1, max_replicas: 4, target_cpu_utilization: 70, reason: 'Target CPU utilisation is p95 relative to the current request.' },
  warnings: [], blocks: ['HPA manager is disabled on this install (hpaManager.enabled=false).'],
  manager_enabled: false,
};

export function RightsizingPreview() {
  return (
    <>
      <div className="breadcrumbs">Cluster / in-cluster / Rightsizing</div>
      <div className="title-row">
        <div>
          <h1>Rightsizing</h1>
          <p>Request vs usage, waste, and Admin-only HPA</p>
        </div>
      </div>
      <RightsizingPage
        rows={ROWS}
        coverage={{
          nodes_total: 9,
          nodes_covered: 5,
          collector_found: true,
          missing: [
            { node: 'ip-10-42-7-11.sa-east-1.compute.internal', reason: 'Too many pods' },
            { node: 'ip-10-42-7-12.sa-east-1.compute.internal', reason: 'Too many pods' },
            { node: 'ip-10-42-8-20.sa-east-1.compute.internal', reason: 'Too many pods' },
            { node: 'ip-10-42-8-21.sa-east-1.compute.internal', reason: 'Too many pods' },
          ],
        }}
        loading={false}
        error=""
        selected={ROWS[0]}
        detail={DETAIL}
        hpa={HPA}
        preview={null}
        applying={false}
        onRefresh={() => undefined}
        onSelect={() => undefined}
        onPreview={() => undefined}
        onApply={() => undefined}
        onUndo={() => undefined}
      />
    </>
  );
}
