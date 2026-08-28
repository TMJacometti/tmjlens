import { useState } from 'react';
import { ConfigurationPage } from '../components/configuration/ConfigurationPage';
import type { ConfigurationOverview, RevealedValue } from '../types/configuration';

/**
 * A namespace carrying every state the screen exists to surface: a ConfigMap nothing
 * references, a Helm-owned Secret an edit would be reverted on, an immutable one, a
 * quota almost consumed, an autoscaler pinned at its ceiling, a disruption budget that
 * blocks node drains, a stale lease, and a webhook whose service has been deleted.
 */
function fixture(): ConfigurationOverview {
  const now = Date.now();
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  return {
    namespace: 'payments',
    config_maps: [
      {
        name: 'checkout-api-config', keys: [
          { key: 'application.yaml', bytes: 2310, binary: false },
          { key: 'logback.xml', bytes: 840, binary: false },
        ],
        total_bytes: 3150, immutable: false, used_by: ['checkout-api-7d9f8b6c4d-5kx2m', 'checkout-api-7d9f8b6c4d-9wq8p'],
        used_by_total: 3, managed_by: 'Helm', age: '31d',
      },
      {
        name: 'feature-flags', keys: [{ key: 'flags.json', bytes: 512, binary: false }],
        total_bytes: 512, immutable: false, used_by: ['checkout-api-7d9f8b6c4d-5kx2m'], used_by_total: 1,
        managed_by: null, age: '9d',
      },
      {
        name: 'legacy-migration-map', keys: [
          { key: 'map.properties', bytes: 1180, binary: false },
          { key: 'truststore.jks', bytes: 4096, binary: true },
        ],
        total_bytes: 5276, immutable: false, used_by: [], used_by_total: 0, managed_by: null, age: '214d',
      },
      {
        name: 'kube-root-ca.crt', keys: [{ key: 'ca.crt', bytes: 1099, binary: false }],
        total_bytes: 1099, immutable: false, used_by: [], used_by_total: 0, managed_by: null, age: '1y',
      },
    ],
    secrets: [
      {
        name: 'checkout-api-db', secret_type: 'Opaque', purpose: 'Application data',
        keys: [
          { key: 'password', bytes: 24, binary: false },
          { key: 'username', bytes: 8, binary: false },
        ],
        total_bytes: 32, immutable: false, used_by: ['checkout-api-7d9f8b6c4d-5kx2m', 'checkout-api-7d9f8b6c4d-9wq8p'],
        used_by_total: 3, managed_by: null, age: '31d',
      },
      {
        name: 'payments-tls', secret_type: 'kubernetes.io/tls', purpose: 'TLS certificate and private key',
        keys: [
          { key: 'tls.crt', bytes: 1834, binary: false },
          { key: 'tls.key', bytes: 1704, binary: false },
        ],
        total_bytes: 3538, immutable: false, used_by: ['checkout-api-7d9f8b6c4d-5kx2m'], used_by_total: 1,
        managed_by: null, age: '88d',
      },
      {
        name: 'registry-pull', secret_type: 'kubernetes.io/dockerconfigjson', purpose: 'Registry pull credentials',
        keys: [{ key: '.dockerconfigjson', bytes: 412, binary: false }],
        total_bytes: 412, immutable: true, used_by: ['checkout-api-7d9f8b6c4d-5kx2m', 'ledger-reconciler-6d4b9c7f8d-2xk9p'],
        used_by_total: 4, managed_by: null, age: '1y',
      },
      {
        name: 'stripe-webhook-signing', secret_type: 'Opaque', purpose: 'Application data',
        keys: [{ key: 'signing-secret', bytes: 44, binary: false }],
        total_bytes: 44, immutable: false, used_by: [], used_by_total: 0, managed_by: 'Helm', age: '120d',
      },
      {
        name: 'sh.helm.release.v1.payments.v41', secret_type: 'helm.sh/release.v1',
        purpose: 'Helm release history, written by Helm',
        keys: [{ key: 'release', bytes: 184320, binary: false }],
        total_bytes: 184320, immutable: false, used_by: [], used_by_total: 0, managed_by: null, age: '4d',
      },
    ],
    quotas: [
      {
        name: 'payments-quota', scopes: [], health: 'serious', age: '214d',
        entries: [
          { resource: 'requests.memory', used: '92Gi', hard: '96Gi', percent: 95.8, health: 'serious' },
          { resource: 'requests.cpu', used: '31', hard: '40', percent: 77.5, health: 'warning' },
          { resource: 'pods', used: '48', hard: '120', percent: 40, health: 'good' },
          { resource: 'count/jobs.batch', used: '3', hard: '0', percent: null, health: 'unknown' },
        ],
      },
    ],
    limit_ranges: [
      {
        name: 'payments-limits', age: '214d',
        items: [
          { item_type: 'Container', resource: 'cpu', min: '10m', max: '4', default_limit: '500m', default_request: '100m' },
          { item_type: 'Container', resource: 'memory', min: '32Mi', max: '8Gi', default_limit: '512Mi', default_request: '128Mi' },
        ],
      },
    ],
    autoscalers: [
      {
        name: 'checkout-api', target: 'Deployment/checkout-api', min_replicas: 3, max_replicas: 12,
        current_replicas: 12, desired_replicas: 12, metrics: ['cpu at 70%', 'requests_per_second per pod at 250'],
        health: 'warning', reason: 'At its ceiling of 12; it cannot scale further.', age: '31d',
      },
      {
        name: 'ledger-reconciler', target: 'Deployment/ledger-reconciler', min_replicas: 1, max_replicas: 6,
        current_replicas: 2, desired_replicas: 2, metrics: ['cpu at 60%'],
        health: 'good', reason: 'Between 1 and 6 replicas.', age: '19d',
      },
    ],
    disruption_budgets: [
      {
        name: 'checkout-api-pdb', requirement: 'at least 100% available', current_healthy: 12, desired_healthy: 12,
        disruptions_allowed: 0, expected_pods: 12, health: 'serious',
        reason: 'No pod may be evicted right now, so draining a node running these pods will block. 12 of 12 pods are healthy.',
        age: '31d',
      },
      {
        name: 'ledger-pdb', requirement: 'at most 1 unavailable', current_healthy: 2, desired_healthy: 1,
        disruptions_allowed: 1, expected_pods: 2, health: 'good', reason: '1 eviction(s) allowed.', age: '19d',
      },
    ],
    leases: [
      { name: 'ledger-reconciler-leader', holder: 'ledger-reconciler-6d4b9c7f8d-2xk9p', renewed: ago(4), duration_seconds: 15, health: 'good', age: '19d' },
      { name: 'payments-migrator-leader', holder: 'payments-migrator-5f7c8d9b4c-xk2mp', renewed: ago(3600), duration_seconds: 15, health: 'warning', age: '61d' },
    ],
    priority_classes: [
      { name: 'system-cluster-critical', value: 2000000000, global_default: false, preemption: 'PreemptLowerPriority', description: 'Used for system critical pods that must run in the cluster, but can be moved to another node if necessary.', age: '1y' },
      { name: 'payments-high', value: 100000, global_default: false, preemption: 'PreemptLowerPriority', description: 'Payment path workloads. Preempts batch.', age: '214d' },
      { name: 'batch-low', value: 1000, global_default: true, preemption: 'Never', description: 'Default for everything else.', age: '214d' },
    ],
    runtime_classes: [
      { name: 'gvisor', handler: 'runsc', age: '180d' },
    ],
    webhooks: [
      {
        configuration: 'gatekeeper-validating-webhook-configuration', kind: 'Validating',
        webhook: 'validation.gatekeeper.sh', failure_policy: 'Fail', timeout_seconds: 3,
        rules: ['CREATE,UPDATE *'], service: 'gatekeeper-system/gatekeeper-webhook-service',
        service_exists: false, health: 'critical',
        reason: 'Its service gatekeeper-system/gatekeeper-webhook-service does not exist, and the policy is Fail — every matching API write is rejected until this is fixed.',
      },
      {
        configuration: 'istio-sidecar-injector', kind: 'Mutating', webhook: 'sidecar-injector.istio.io',
        failure_policy: 'Fail', timeout_seconds: 10, rules: ['CREATE pods'],
        service: 'istio-system/istiod', service_exists: true, health: 'good',
        reason: 'Rejects matching writes if it cannot be reached.',
      },
      {
        configuration: 'cert-manager-webhook', kind: 'Validating', webhook: 'webhook.cert-manager.io',
        failure_policy: 'Fail', timeout_seconds: 10, rules: ['CREATE,UPDATE certificates,issuers'],
        service: 'cert-manager/cert-manager-webhook', service_exists: true, health: 'good',
        reason: 'Rejects matching writes if it cannot be reached.',
      },
    ],
    findings: [
      {
        severity: 'critical',
        title: 'An admission webhook points at a service that does not exist',
        detail: 'Its failure policy is Fail, so the API server rejects every write that matches its rules. Deleting the webhook configuration, or restoring the service, unblocks it.',
        targets: ['gatekeeper-validating-webhook-configuration · validation.gatekeeper.sh'],
      },
      {
        severity: 'serious',
        title: 'A disruption budget allows no evictions',
        detail: 'Draining a node that runs these pods will block until the budget is satisfied. This is the usual reason a node drain never finishes.',
        targets: ['checkout-api-pdb'],
      },
      {
        severity: 'serious',
        title: 'A resource quota is nearly or fully consumed',
        detail: 'New pods in this namespace will be rejected once the hard limit is reached.',
        targets: ['payments-quota · requests.memory at 92Gi'],
      },
      {
        severity: 'warning',
        title: 'An autoscaler is at its ceiling',
        detail: 'It has no room left to scale, so additional load is absorbed as latency rather than as replicas.',
        targets: ['checkout-api at 12 replicas'],
      },
      {
        severity: 'warning',
        title: 'Not referenced by any running pod',
        detail: 'No pod in this namespace mounts these or reads them as environment variables. They may still be read by a controller, a Job that is not running, or something outside the namespace — check before deleting.',
        targets: ['legacy-migration-map', 'stripe-webhook-signing'],
      },
    ],
    degraded_collectors: [],
  };
}

/** Stand-in values, so the reveal and edit paths can be exercised without a cluster. */
const VALUES: Record<string, string> = {
  'checkout-api-db/password': 's3cr3t-do-not-share',
  'checkout-api-db/username': 'checkout',
  'payments-tls/tls.crt': '-----BEGIN CERTIFICATE-----\nMIIDazCCAlOgAwIBAgIUEXAMPLE...\n-----END CERTIFICATE-----',
  'payments-tls/tls.key': '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BEXAMPLE...\n-----END PRIVATE KEY-----',
  'registry-pull/.dockerconfigjson': '{"auths":{"registry.example.com":{"auth":"ZXhhbXBsZTpleGFtcGxl"}}}',
  'stripe-webhook-signing/signing-secret': 'whsec_EXAMPLEEXAMPLEEXAMPLEEXAMPLE',
  'sh.helm.release.v1.payments.v41/release': 'H4sIAAAAAAAA/… (gzipped release manifest)',
  'checkout-api-config/application.yaml': 'server:\n  port: 8080\nspring:\n  datasource:\n    url: jdbc:postgresql://payments-db:5432/checkout\n',
  'checkout-api-config/logback.xml': '<configuration>\n  <root level="INFO"/>\n</configuration>',
  'feature-flags/flags.json': '{\n  "new-checkout": true,\n  "retry-on-timeout": false\n}',
  'legacy-migration-map/map.properties': 'old.table=new_table\nold.column=new_column',
  'kube-root-ca.crt/ca.crt': '-----BEGIN CERTIFICATE-----\nMIIC/EXAMPLE...\n-----END CERTIFICATE-----',
};

export function ConfigurationPreview() {
  const [data, setData] = useState<ConfigurationOverview>(() => fixture());

  const read = async (kind: 'ConfigMap' | 'Secret', name: string, key: string): Promise<RevealedValue> => {
    const value = VALUES[`${name}/${key}`] ?? null;
    return { key, value, bytes: value ? new TextEncoder().encode(value).length : 0, binary: value === null };
  };

  return (
    <>
      <div className="title-row">
        <div>
          <h1>Configuration</h1>
          <p>Config maps, secrets, quotas and admission control for <b>payments</b></p>
        </div>
      </div>
      <ConfigurationPage
        data={data}
        loading={false}
        error=""
        canEditConfigMaps
        canEditSecrets
        onRefresh={() => undefined}
        onRead={read}
        onSave={async (kind, name, key, value) => {
          // Mirror what the cluster would do, so an added key shows up in the panel.
          VALUES[`${name}/${key}`] = value;
          setData((current) => {
            const bump = <T extends { name: string; keys: { key: string; bytes: number; binary: boolean }[] }>(items: T[]): T[] =>
              items.map((item) =>
                item.name === name && !item.keys.some((entry) => entry.key === key)
                  ? { ...item, keys: [...item.keys, { key, bytes: value.length, binary: false }] }
                  : item,
              );
            return kind === 'Secret'
              ? { ...current, secrets: bump(current.secrets) }
              : { ...current, config_maps: bump(current.config_maps) };
          });
        }}
        onDelete={async () => undefined}
        notify={() => undefined}
      />
    </>
  );
}
