import { useState } from 'react';
import { KyvernoPage } from '../components/kyverno/KyvernoPage';
import type { KyvernoOverview } from '../types/kyverno';

/**
 * The Kyverno screen against fixtures that cover the states the design exists
 * for: an Audit policy with failures (reporting, not blocking — the finding),
 * an Enforce policy with pre-existing violations, a policy Kyverno rejected,
 * and a healthy one. Invented names only.
 */
const OVERVIEW: KyvernoOverview = {
  installed: true,
  reason: null,
  pass: 412,
  fail: 14,
  warn: 3,
  violations_capped: false,
  degraded_collectors: [],
  policies: [
    {
      name: 'disallow-latest-tag', namespace: null, action: 'Audit', background: true,
      rule_kinds: ['validate'], rules: 1, ready: true, message: null,
      fail_count: 9, health: 'serious', age: '120d',
    },
    {
      name: 'require-resource-limits', namespace: null, action: 'Enforce', background: true,
      rule_kinds: ['validate'], rules: 2, ready: true, message: null,
      fail_count: 5, health: 'warning', age: '86d',
    },
    {
      name: 'add-default-netpol', namespace: 'payments', action: 'Audit', background: false,
      rule_kinds: ['generate'], rules: 1, ready: false,
      message: 'variable substitution failed in rule add-netpol',
      fail_count: 0, health: 'critical', age: '3d',
    },
    {
      name: 'verify-image-signatures', namespace: null, action: 'Enforce', background: true,
      rule_kinds: ['verifyImages'], rules: 1, ready: true, message: null,
      fail_count: 0, health: 'good', age: '200d',
    },
  ],
  violations: [
    {
      policy: 'disallow-latest-tag', rule: 'validate-tag', result: 'fail', severity: 'medium',
      kind: 'Deployment', namespace: 'payments', name: 'checkout-api',
      message: "image 'registry.example.com/acme/checkout-api:latest' uses the latest tag",
    },
    {
      policy: 'disallow-latest-tag', rule: 'validate-tag', result: 'fail', severity: 'medium',
      kind: 'Deployment', namespace: 'ledger', name: 'reconciler',
      message: "image 'registry.example.com/acme/reconciler:latest' uses the latest tag",
    },
    {
      policy: 'require-resource-limits', rule: 'check-limits', result: 'fail', severity: 'high',
      kind: 'StatefulSet', namespace: 'ledger', name: 'ledger-db',
      message: 'CPU and memory limits are required',
    },
    {
      policy: 'require-resource-limits', rule: 'check-limits', result: 'warn', severity: 'low',
      kind: 'CronJob', namespace: 'payments', name: 'nightly-report',
      message: 'memory limit is set but CPU limit is missing',
    },
  ],
  findings: [
    {
      severity: 'critical', title: 'Policies are not ready', targets: ['add-default-netpol'],
      detail: 'variable substitution failed in rule add-netpol',
    },
    {
      severity: 'serious', title: 'Reporting, not blocking', targets: ['disallow-latest-tag'],
      detail:
        'These policies are in Audit mode with failing resources — the same violations keep ' +
        'being admitted. Switching to Enforce blocks new ones (9 failure(s) recorded).',
    },
    {
      severity: 'warning', title: 'Existing violations under Enforce', targets: ['require-resource-limits'],
      detail:
        'Enforce blocks new admissions, but these resources were already in the cluster and ' +
        'still violate — they stay until someone fixes or replaces them.',
    },
  ],
};

const ABSENT: KyvernoOverview = {
  installed: false,
  reason:
    'Kyverno is not installed in this cluster, or its custom resources are absent — no ' +
    'ClusterPolicy definition was found.',
  policies: [], violations: [], pass: 0, fail: 0, warn: 0,
  violations_capped: false, findings: [], degraded_collectors: [],
};

export function KyvernoPreview({ installed }: { installed: boolean }) {
  const [note, setNote] = useState('');
  return (
    <>
      <div className="title-row">
        <div>
          <h1>Kyverno</h1>
          <p>Policies and their verdicts on <b>prod-shark</b></p>
        </div>
      </div>
      {note && <p role="status">{note}</p>}
      <KyvernoPage
        data={installed ? OVERVIEW : ABSENT}
        loading={false}
        error=""
        canToggle
        onRefresh={() => undefined}
        onToggleAction={async (policy, next) => `${policy.name} is now ${next} — preview`}
        notify={(text, detail) => setNote(detail ? `${text} — ${detail}` : text)}
      />
    </>
  );
}
