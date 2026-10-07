import { describe, expect, it } from 'vitest';
import { namespacesOf, sortRows, wasteScore, type WorkloadRow } from './rightsizing';

const row = (over: Partial<WorkloadRow>): WorkloadRow => ({
  namespace: 'shop', kind: 'Deployment', name: 'x', container: 'app',
  cpu_request_milli: 100, cpu_p95_milli: 50, mem_request_bytes: 100, mem_max_bytes: 50,
  cpu_waste_milli: null, mem_waste_bytes: null, waste_usd_month: null,
  confidence: 'high', days_of_data: 9, limited_data: false, oom_kills: 0, throttle_ratio: null,
  recommended_cpu_milli: null, recommended_mem_bytes: null, live_spec: true,
  ...over,
});

describe('waste ordering', () => {
  it('ranks by dollars when priced, by cores+GiB otherwise', () => {
    expect(wasteScore(row({ waste_usd_month: 42 }))).toBe(42);
    expect(wasteScore(row({ cpu_waste_milli: 500, mem_waste_bytes: 1024 ** 3 }))).toBe(1.5);
    expect(wasteScore(row({}))).toBe(0);
  });

  it('puts the biggest waste first by default and flips on demand', () => {
    const rows = [row({ name: 'small', waste_usd_month: 3 }), row({ name: 'big', waste_usd_month: 42 }), row({ name: 'none' })];
    expect(sortRows(rows, 'waste', 'desc').map((r) => r.name)).toEqual(['big', 'small', 'none']);
    expect(sortRows(rows, 'waste', 'asc').map((r) => r.name)).toEqual(['none', 'small', 'big']);
  });

  it('sorts confidence by meaning, not alphabetically', () => {
    const rows = [row({ name: 'l', confidence: 'low' }), row({ name: 'h', confidence: 'high' }), row({ name: 'm', confidence: 'medium' })];
    expect(sortRows(rows, 'confidence', 'desc').map((r) => r.name)).toEqual(['h', 'm', 'l']);
  });

  it('lists namespaces once, sorted', () => {
    expect(namespacesOf([row({ namespace: 'ledger' }), row({ namespace: 'shop' }), row({ namespace: 'ledger' })])).toEqual(['ledger', 'shop']);
  });
});
