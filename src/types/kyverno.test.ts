import { describe, expect, it } from 'vitest';
import { enforceSplit, toggleWarning, violationTarget, type PolicyRow } from './kyverno';

const policy = (overrides: Partial<PolicyRow> = {}): PolicyRow => ({
  name: 'require-limits',
  namespace: null,
  action: 'Audit',
  background: true,
  rule_kinds: ['validate'],
  rules: 1,
  ready: true,
  message: null,
  fail_count: 0,
  health: 'good',
  age: '30d',
  ...overrides,
});

describe('enforce split', () => {
  it('separates what blocks from what merely reports', () => {
    const split = enforceSplit([
      policy({ action: 'Enforce' }),
      policy({ name: 'b' }),
      policy({ name: 'c' }),
    ]);
    expect(split).toEqual({ enforce: 1, audit: 2 });
  });
});

describe('the switch never happens on a silent click', () => {
  it('going Enforce warns that admissions will be rejected', () => {
    expect(toggleWarning(policy(), 'Enforce')).toContain('REJECTED');
  });

  it('going Enforce with existing failures says deploys will start bouncing', () => {
    const warning = toggleWarning(policy({ fail_count: 12 }), 'Enforce');
    expect(warning).toContain('12 existing resource(s)');
    expect(warning).toContain('bouncing');
  });

  it('going Audit says protection stops', () => {
    expect(toggleWarning(policy({ action: 'Enforce' }), 'Audit')).toContain('stop blocking');
  });
});

describe('violation targets', () => {
  it('reads the way an operator would type it', () => {
    expect(
      violationTarget({
        policy: 'p', rule: 'r', result: 'fail', kind: 'Deployment',
        namespace: 'payments', name: 'checkout-api', message: '',
      }),
    ).toBe('deployment payments/checkout-api');
  });

  it('cluster-scoped resources carry no namespace prefix', () => {
    expect(
      violationTarget({
        policy: 'p', rule: 'r', result: 'fail', kind: 'ClusterRole',
        namespace: null, name: 'wide-open', message: '',
      }),
    ).toBe('clusterrole wide-open');
  });
});
