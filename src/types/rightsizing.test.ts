import { describe, expect, it } from 'vitest';
import { confidenceLabel, workloadKey, type WorkloadRow } from './rightsizing';

const row = (over: Partial<WorkloadRow> = {}): WorkloadRow => ({
  namespace: 'shop', kind: 'Deployment', name: 'checkout', container: 'api',
  cpu_request_milli: 500, cpu_p95_milli: 80, mem_request_bytes: 1, mem_max_bytes: 1,
  cpu_waste_milli: null, mem_waste_bytes: null, waste_usd_month: null,
  confidence: 'high', days_of_data: 9, limited_data: false, oom_kills: 0,
  throttle_ratio: null, recommended_cpu_milli: 110, recommended_mem_bytes: 1, live_spec: true, ...over,
});

describe('rightsizing labels', () => {
  it('identifies a container, never just a pod name', () => {
    expect(workloadKey(row())).toBe('shop/Deployment/checkout/api');
  });

  it('cold start is provisional in words, not a fake high', () => {
    expect(confidenceLabel('low')).toMatch(/cold start/i);
    expect(confidenceLabel('none')).toMatch(/No recommendation/);
  });
});
