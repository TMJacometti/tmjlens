import { describe, expect, it } from 'vitest';
import {
  configViewCount, describeConsumers, formatBytes, sinceRenewal, viewSeverity,
  type ConfigurationOverview,
} from './configuration';

const empty: ConfigurationOverview = {
  namespace: 'payments',
  config_maps: [], secrets: [], quotas: [], limit_ranges: [], autoscalers: [],
  disruption_budgets: [], leases: [], priority_classes: [], runtime_classes: [],
  webhooks: [], findings: [], degraded_collectors: [],
};

describe('consumers', () => {
  it('says nothing references it as a sentence, not an empty cell', () => {
    expect(describeConsumers([], 0)).toBe('No running pod references this');
  });

  it('lists them when they all fit', () => {
    expect(describeConsumers(['a', 'b'], 2)).toBe('a, b');
  });

  it('counts the rest rather than truncating silently', () => {
    // A ConfigMap mounted by 40 pods must not read as one mounted by 6.
    expect(describeConsumers(['a', 'b'], 40)).toBe('a, b and 38 more');
  });
});

describe('tab severity', () => {
  it('is null when nothing in that view needs attention', () => {
    expect(viewSeverity(empty, 'Webhooks')).toBeNull();
    expect(viewSeverity(empty, 'Resource Quotas')).toBeNull();
  });

  it('reports the worst state in the view, not the first', () => {
    const data: ConfigurationOverview = {
      ...empty,
      webhooks: [
        { configuration: 'a', kind: 'Validating', webhook: 'a', failure_policy: 'Ignore', timeout_seconds: 10, rules: [], service: null, service_exists: null, health: 'good', reason: '' },
        { configuration: 'b', kind: 'Validating', webhook: 'b', failure_policy: 'Fail', timeout_seconds: 10, rules: [], service: 'x/y', service_exists: false, health: 'critical', reason: '' },
        { configuration: 'c', kind: 'Mutating', webhook: 'c', failure_policy: 'Ignore', timeout_seconds: 10, rules: [], service: 'x/z', service_exists: false, health: 'warning', reason: '' },
      ],
    };
    expect(viewSeverity(data, 'Webhooks')).toBe('critical');
  });

  it('does not raise a dot for an unmeasurable quota', () => {
    // "unknown" means not measured; flagging it as a problem would be a false alarm.
    const data: ConfigurationOverview = {
      ...empty,
      quotas: [{ name: 'q', scopes: [], health: 'unknown', age: '1d', entries: [] }],
    };
    expect(viewSeverity(data, 'Resource Quotas')).toBeNull();
  });

  it('never raises a dot for views that hold no state', () => {
    expect(viewSeverity(empty, 'Secrets')).toBeNull();
    expect(viewSeverity(empty, 'Config Maps')).toBeNull();
    expect(viewSeverity(empty, 'Priority Classes')).toBeNull();
  });
});

describe('tab counts', () => {
  it('counts every view independently', () => {
    const data: ConfigurationOverview = {
      ...empty,
      config_maps: [{ name: 'a', keys: [], total_bytes: 0, immutable: false, used_by: [], used_by_total: 0, managed_by: null, age: '1d' }],
      leases: [{ name: 'l', holder: null, renewed: null, duration_seconds: null, health: 'good', age: '1d' }],
    };
    expect(configViewCount(data, 'Config Maps')).toBe(1);
    expect(configViewCount(data, 'Leases')).toBe(1);
    expect(configViewCount(data, 'Secrets')).toBe(0);
    expect(configViewCount(data, 'Webhooks')).toBe(0);
  });
});

describe('sizes', () => {
  it('scales the unit to the value', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.0 MB');
  });
});

describe('lease renewal', () => {
  const now = Date.parse('2026-08-19T12:00:00Z');

  it('reads as elapsed time, which is the question being asked', () => {
    expect(sinceRenewal('2026-08-19T11:59:56Z', now)).toBe('4s ago');
    expect(sinceRenewal('2026-08-19T11:30:00Z', now)).toBe('30m ago');
    expect(sinceRenewal('2026-08-19T06:00:00Z', now)).toBe('6h ago');
    expect(sinceRenewal('2026-08-17T12:00:00Z', now)).toBe('2d ago');
  });

  it('states that a lease was never renewed rather than showing a dash', () => {
    expect(sinceRenewal(null, now)).toBe('never renewed');
  });

  it('does not render a negative age from clock skew', () => {
    expect(sinceRenewal('2026-08-19T12:00:30Z', now)).toBe('0s ago');
  });
});
