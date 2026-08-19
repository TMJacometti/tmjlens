import { describe, expect, it } from 'vitest';
import {
  groupByNamespace, shortImage, summarise, windowLabel,
  type DeployReport, type DeployedRow,
} from './reports';

const row = (overrides: Partial<DeployedRow>): DeployedRow => ({
  namespace: 'payments', name: 'checkout-api', kind: 'Deployment',
  deployed_at: '2026-08-19T14:29:00Z', age: '42m', images: ['acme/checkout:1.0'],
  detail: '3/3 ready', health: 'good', reason: 'All 3 replicas ready.', managed_by: 'Argo CD',
  ...overrides,
});

const report = (items: DeployedRow[], namespaces: string[], window = 'today'): DeployReport => ({
  window, namespaces, items, degraded_collectors: [],
});

describe('the summary line', () => {
  it('says nothing happened when nothing did', () => {
    expect(summarise(report([], ['payments']))).toBe('Nothing was deployed in the selected namespaces.');
  });

  it('leads with what is broken rather than with the count', () => {
    const text = summarise(report(
      [row({}), row({ name: 'b', health: 'critical' })],
      ['payments'],
    ));
    expect(text).toBe('2 workloads in payments, 1 not running.');
  });

  it('reports partial readiness when nothing is outright broken', () => {
    const text = summarise(report([row({ health: 'warning' })], ['payments']));
    expect(text).toContain('not fully ready');
  });

  it('says everything is running when it is', () => {
    expect(summarise(report([row({})], ['payments']))).toBe('1 workload in payments, all running.');
  });

  it('names the namespace when there is one and counts them when there are several', () => {
    expect(summarise(report([row({})], ['payments']))).toContain('in payments,');
    expect(summarise(report([row({})], ['a', 'b', 'c']))).toContain('in 3 namespaces,');
  });
});

describe('grouping', () => {
  it('groups by namespace in alphabetical order', () => {
    const groups = groupByNamespace([
      row({ namespace: 'payments', name: 'a' }),
      row({ namespace: 'ledger', name: 'b' }),
      row({ namespace: 'payments', name: 'c' }),
    ]);
    expect(groups.map(([name]) => name)).toEqual(['ledger', 'payments']);
    expect(groups[1][1]).toHaveLength(2);
  });

  it('keeps the order items arrived in within a group', () => {
    // The backend sorts newest first; regrouping must not reshuffle that.
    const groups = groupByNamespace([row({ name: 'newest' }), row({ name: 'older' })]);
    expect(groups[0][1].map((item) => item.name)).toEqual(['newest', 'older']);
  });

  it('returns nothing for an empty report', () => {
    expect(groupByNamespace([])).toEqual([]);
  });
});

describe('images', () => {
  it('drops the registry path and keeps the tag', () => {
    expect(shortImage('registry.example.com/acme/checkout-api:1.9.0')).toBe('checkout-api:1.9.0');
  });

  it('leaves an image that has no registry path alone', () => {
    expect(shortImage('nginx:1.25')).toBe('nginx:1.25');
  });
});

describe('window labels', () => {
  it('names each window', () => {
    expect(windowLabel('today')).toBe('Today');
    expect(windowLabel('yesterday')).toBe('Yesterday');
    expect(windowLabel('7d')).toBe('Last 7 days');
  });

  it('falls back to Today rather than showing a raw id', () => {
    expect(windowLabel('nonsense')).toBe('Today');
  });
});
