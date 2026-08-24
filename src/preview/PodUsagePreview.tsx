import { PodLiveUsage } from '../components/workloads/PodLiveUsage';
import type { PodUsageRow } from '../types/metrics';

/**
 * The live usage tab against a pod carrying its three states: a container inside its
 * limits, one at 96% of its memory limit (the OOMKill range), and one with no limits
 * at all, whose numbers appear in words rather than behind a bar with no edge.
 */
const USAGE: PodUsageRow = {
  name: 'checkout-api-7d9f8b6c4d-9wq8p',
  cpu_milli: 612,
  memory_bytes: 1.62 * 1024 * 1024 * 1024,
  cpu_request_milli: 400,
  cpu_limit_milli: 1000,
  memory_request_bytes: 1024 * 1024 * 1024,
  memory_limit_bytes: 2 * 1024 * 1024 * 1024,
  sampled_at: new Date(Date.now() - 14_000).toISOString(),
  window: '30s',
  containers: [
    {
      name: 'api',
      cpu_milli: 520, memory_bytes: 0.96 * 1024 * 1024 * 1024,
      cpu_request_milli: 200, cpu_limit_milli: 500,
      memory_request_bytes: 512 * 1024 * 1024, memory_limit_bytes: 1024 * 1024 * 1024,
    },
    {
      name: 'cache-warmer',
      cpu_milli: 80, memory_bytes: 300 * 1024 * 1024,
      cpu_request_milli: 100, cpu_limit_milli: 500,
      memory_request_bytes: 256 * 1024 * 1024, memory_limit_bytes: 1024 * 1024 * 1024,
    },
    {
      name: 'log-shipper',
      cpu_milli: 12, memory_bytes: 380 * 1024 * 1024,
      cpu_request_milli: 0, cpu_limit_milli: 0,
      memory_request_bytes: 0, memory_limit_bytes: 0,
    },
  ],
};

export function PodUsagePreview() {
  return (
    <>
      <div className="title-row">
        <div>
          <h1>Pod usage</h1>
          <p>The detail panel's Usage tab, per container against requests and limits</p>
        </div>
      </div>
      <div style={{ maxWidth: 760, border: '1px solid #272d37', borderRadius: 10, background: '#0f1319' }}>
        <PodLiveUsage usage={USAGE} available reason="" />
      </div>
    </>
  );
}
