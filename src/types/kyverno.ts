import type { Severity } from './cluster';

export type PolicyRow = {
  name: string;
  /** Absent for a ClusterPolicy. */
  namespace?: string | null;
  /** "Enforce" blocks admission; "Audit" only reports. */
  action: string;
  background: boolean;
  rule_kinds: string[];
  rules: number;
  ready: boolean;
  message?: string | null;
  fail_count: number;
  health: Severity;
  age: string;
};

export type ViolationRow = {
  policy: string;
  rule: string;
  result: string;
  severity?: string | null;
  kind: string;
  namespace?: string | null;
  name: string;
  message: string;
};

export type KyvernoFinding = {
  severity: Severity;
  title: string;
  targets: string[];
  detail: string;
};

export type KyvernoOverview = {
  installed: boolean;
  reason?: string | null;
  policies: PolicyRow[];
  violations: ViolationRow[];
  pass: number;
  fail: number;
  warn: number;
  violations_capped: boolean;
  findings: KyvernoFinding[];
  degraded_collectors: string[];
};

export const KYVERNO_VIEWS = ['Policies', 'Violations'] as const;
export type KyvernoView = (typeof KYVERNO_VIEWS)[number];

export function kyvernoViewCount(data: KyvernoOverview, view: KyvernoView): number {
  return view === 'Policies' ? data.policies.length : data.violations.length;
}

/** How many policies actually block, versus merely report. */
export function enforceSplit(policies: PolicyRow[]): { enforce: number; audit: number } {
  let enforce = 0;
  for (const policy of policies) if (policy.action === 'Enforce') enforce += 1;
  return { enforce, audit: policies.length - enforce };
}

/**
 * The confirmation each direction of the switch deserves. Enforce can start
 * rejecting deploys that used to pass; Audit stops protecting. Neither is a
 * silent click.
 */
export function toggleWarning(policy: PolicyRow, next: string): string {
  if (next === 'Enforce') {
    return policy.fail_count > 0
      ? `Make ${policy.name} Enforce?\n\nNew admissions violating it will be REJECTED. ` +
          `${policy.fail_count} existing resource(s) already fail this policy — deploys that ` +
          `recreate them will start bouncing.`
      : `Make ${policy.name} Enforce?\n\nNew admissions violating it will be REJECTED.`;
  }
  return (
    `Make ${policy.name} Audit?\n\nIt will stop blocking anything — violations are only ` +
    `reported from then on.`
  );
}

/** A violation's resource, as an operator would type it. */
export function violationTarget(violation: ViolationRow): string {
  const prefix = violation.namespace ? `${violation.namespace}/` : '';
  return `${violation.kind.toLowerCase()} ${prefix}${violation.name}`;
}
