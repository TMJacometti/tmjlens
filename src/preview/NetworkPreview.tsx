import { useState } from 'react';
import { NetworkPage } from '../components/network/NetworkPage';
import { YamlEditor } from '../components/YamlEditor';
import type { NetworkOverview } from '../types/network';

/**
 * A namespace carrying every failure the screen exists to surface: a Service whose
 * selector matches nothing, one serving on reduced capacity, a LoadBalancer with no
 * address, and Ingress routes pointing at each of them.
 */
const FIXTURE: NetworkOverview = {
  namespace: 'payments',
  services: [
    {
      name: 'checkout-api', service_type: 'ClusterIP', cluster_ip: '10.96.14.22',
      ports: [{ name: 'http', port: 80, target_port: '8080', protocol: 'TCP' }],
      selector: ['app=checkout-api'], ready_endpoints: 3, total_endpoints: 3,
      health: 'good', reason: '3 endpoint(s) ready', age: '31d',
      backing_pods: [
        { address: '10.244.1.17', pod: 'checkout-api-7d9f8b6c4d-5kx2m', node: 'ip-10-0-12-34', ready: true, terminating: false },
        { address: '10.244.2.31', pod: 'checkout-api-7d9f8b6c4d-9wq8p', node: 'ip-10-0-31-207', ready: true, terminating: false },
        { address: '10.244.3.9', pod: 'checkout-api-7d9f8b6c4d-mm4tq', node: 'ip-10-0-52-9', ready: true, terminating: false },
      ],
    },
    {
      name: 'fraud-scoring', service_type: 'ClusterIP', cluster_ip: '10.96.201.7',
      ports: [{ name: 'http', port: 8080, target_port: '8080', protocol: 'TCP' }],
      selector: ['app=fraud-scoring'], ready_endpoints: 0, total_endpoints: 0,
      health: 'critical', reason: 'Selector matches no pods', age: '12d', backing_pods: [],
    },
    {
      name: 'ledger-reconciler', service_type: 'ClusterIP', cluster_ip: '10.96.88.4',
      ports: [{ port: 9000, protocol: 'TCP' }],
      selector: ['app=ledger'], ready_endpoints: 1, total_endpoints: 3,
      health: 'serious', reason: '1 of 3 endpoints ready', age: '5d',
      backing_pods: [
        { address: '10.244.1.44', pod: 'ledger-reconciler-6d4b9c7f8d-2xk9p', node: 'ip-10-0-12-34', ready: true, terminating: false },
        { address: '10.244.2.51', pod: 'ledger-reconciler-6d4b9c7f8d-8plkm', node: 'ip-10-0-31-207', ready: false, terminating: false },
        { address: '10.244.3.62', pod: 'ledger-reconciler-6d4b9c7f8d-qq18z', node: 'ip-10-0-52-9', ready: false, terminating: true },
      ],
    },
    {
      name: 'payments-edge', service_type: 'LoadBalancer', cluster_ip: '10.96.30.11',
      ports: [{ name: 'https', port: 443, target_port: '8443', node_port: 31544, protocol: 'TCP' }],
      selector: ['app=edge'], ready_endpoints: 2, total_endpoints: 2,
      health: 'warning', reason: 'Load balancer address still pending', age: '2h',
      backing_pods: [
        { address: '10.244.1.90', pod: 'edge-6c9d8f7b5a-mn2kq', node: 'ip-10-0-12-34', ready: true, terminating: false },
        { address: '10.244.2.14', pod: 'edge-6c9d8f7b5a-tt41z', node: 'ip-10-0-31-207', ready: true, terminating: false },
      ],
    },
    {
      name: 'postgres', service_type: 'Headless', cluster_ip: 'None',
      ports: [{ port: 5432, protocol: 'TCP' }],
      selector: ['app=postgres'], ready_endpoints: 2, total_endpoints: 2,
      health: 'good', reason: '2 endpoint(s) ready', age: '90d',
      backing_pods: [
        { address: '10.244.1.5', pod: 'postgres-0', node: 'ip-10-0-12-34', ready: true, terminating: false },
        { address: '10.244.2.6', pod: 'postgres-1', node: 'ip-10-0-31-207', ready: true, terminating: false },
      ],
    },
  ],
  endpoint_slices: [
    {
      name: 'checkout-api-x7k2p', service: 'checkout-api', address_type: 'IPv4', ports: ['http:8080'],
      ready: 3, total: 3, health: 'good', age: '31d',
      endpoints: [
        { address: '10.244.1.17', pod: 'checkout-api-7d9f8b6c4d-5kx2m', node: 'ip-10-0-12-34', ready: true, terminating: false },
        { address: '10.244.2.31', pod: 'checkout-api-7d9f8b6c4d-9wq8p', node: 'ip-10-0-31-207', ready: true, terminating: false },
        { address: '10.244.3.9', pod: 'checkout-api-7d9f8b6c4d-mm4tq', node: 'ip-10-0-52-9', ready: true, terminating: false },
      ],
    },
    { name: 'fraud-scoring-9m4qz', service: 'fraud-scoring', address_type: 'IPv4', ports: ['http:8080'], ready: 0, total: 0, health: 'warning', age: '12d', endpoints: [] },
    {
      name: 'ledger-reconciler-2b8wt', service: 'ledger-reconciler', address_type: 'IPv4', ports: ['9000'],
      ready: 1, total: 3, health: 'serious', age: '5d',
      endpoints: [
        { address: '10.244.1.44', pod: 'ledger-reconciler-6d4b9c7f8d-2xk9p', node: 'ip-10-0-12-34', ready: true, terminating: false },
        { address: '10.244.2.51', pod: 'ledger-reconciler-6d4b9c7f8d-8plkm', node: 'ip-10-0-31-207', ready: false, terminating: false },
        { address: '10.244.3.62', pod: 'ledger-reconciler-6d4b9c7f8d-qq18z', node: 'ip-10-0-52-9', ready: false, terminating: true },
      ],
    },
    {
      name: 'postgres-t4nx8', service: 'postgres', address_type: 'IPv4', ports: ['5432'], ready: 2, total: 2, health: 'good', age: '90d',
      endpoints: [
        { address: '10.244.1.5', pod: 'postgres-0', node: 'ip-10-0-12-34', ready: true, terminating: false },
        { address: '10.244.2.6', pod: 'postgres-1', node: 'ip-10-0-31-207', ready: true, terminating: false },
      ],
    },
  ],
  endpoints: [
    { name: 'checkout-api', addresses: ['10.244.1.17', '10.244.2.31', '10.244.3.9'], not_ready_addresses: [], ports: ['http:8080'], health: 'good', age: '31d' },
    { name: 'fraud-scoring', addresses: [], not_ready_addresses: [], ports: [], health: 'critical', age: '12d' },
    { name: 'ledger-reconciler', addresses: ['10.244.1.44'], not_ready_addresses: ['10.244.2.51', '10.244.3.62'], ports: ['9000'], health: 'serious', age: '5d' },
    { name: 'postgres', addresses: ['10.244.1.5', '10.244.2.6'], not_ready_addresses: [], ports: ['5432'], health: 'good', age: '90d' },
  ],
  ingresses: [
    {
      name: 'payments-public', class: 'nginx', address: 'a1b2c3.elb.sa-east-1.amazonaws.com',
      tls_hosts: ['pay.example.com'], health: 'critical', reason: '2 of 4 route(s) cannot serve', age: '31d',
      rules: [
        { host: 'pay.example.com', path: '/checkout', path_type: 'Prefix', service: 'checkout-api', port: 'http', tls: true },
        { host: 'pay.example.com', path: '/fraud', path_type: 'Prefix', service: 'fraud-scoring', port: 'http', tls: true, problem: 'Service fraud-scoring has no ready endpoints' },
        { host: 'pay.example.com', path: '/ledger', path_type: 'Prefix', service: 'ledger-reconciler', port: '8080', tls: true, problem: 'Service ledger-reconciler does not expose port 8080' },
        { host: 'pay.example.com', path: '/db', path_type: 'Prefix', service: 'postgres', port: '5432', tls: true },
      ],
    },
    {
      name: 'payments-internal', class: 'nginx', tls_hosts: [], health: 'warning',
      reason: 'No address assigned by the controller yet', age: '4h',
      rules: [{ host: 'internal.payments.svc', path: '/', path_type: 'Prefix', service: 'reporting-api', port: '80', tls: false, problem: 'Service reporting-api does not exist in this namespace' }],
    },
  ],
  ingress_classes: [
    { name: 'nginx', controller: 'k8s.io/ingress-nginx', is_default: true, age: '210d' },
    { name: 'alb', controller: 'ingress.k8s.aws/alb', is_default: false, age: '210d' },
  ],
  network_policies: [
    { name: 'default-deny-ingress', pod_selector: [], applies_to_all: true, policy_types: ['Ingress'], ingress_rules: 0, egress_rules: 0, effect: 'Denies all ingress', age: '120d' },
    { name: 'allow-checkout-from-edge', pod_selector: ['app=checkout-api'], applies_to_all: false, policy_types: ['Ingress'], ingress_rules: 2, egress_rules: 0, effect: 'Allows 2 ingress and 0 egress rule(s)', age: '31d' },
    { name: 'restrict-ledger-egress', pod_selector: ['app=ledger'], applies_to_all: false, policy_types: ['Egress'], ingress_rules: 0, egress_rules: 0, effect: 'Denies all egress', age: '5d' },
  ],
  findings: [
    { severity: 'critical', title: 'Services with nothing ready behind them', detail: 'These Services resolve and accept connections, but no ready pod is backing them — every request returns a connection error or a 503. This is the most common cause of an outage that looks like a networking fault.', count: 1, targets: ['fraud-scoring — Selector matches no pods'], hint: 'Check that the Service selector still matches the pod labels, and that the pods are passing their readiness probe.' },
    { severity: 'critical', title: 'Ingress routes that cannot serve', detail: 'These routes are published but point at a Service that is missing, does not expose the referenced port, or has no ready endpoints.', count: 3, targets: ['payments-public: pay.example.com/fraud — Service fraud-scoring has no ready endpoints', 'payments-public: pay.example.com/ledger — Service ledger-reconciler does not expose port 8080', 'payments-internal: internal.payments.svc/ — Service reporting-api does not exist in this namespace'], hint: 'The ingress controller returns 503 for these paths. Fix the backend before looking at the controller.' },
    { severity: 'serious', title: 'Services serving on reduced capacity', detail: 'Some endpoints are not ready, so traffic concentrates on the remainder.', count: 1, targets: ['ledger-reconciler — 1 of 3 endpoints ready'], hint: 'A rolling update explains this briefly; anything longer points at a failing readiness probe.' },
    { severity: 'warning', title: 'Load balancers without an address', detail: 'The cloud controller has not assigned an external address. On a cluster with no load balancer provider this never resolves.', count: 1, targets: ['payments-edge'], hint: 'Check the cloud controller manager, or the Service events for a quota or subnet error.' },
  ],
  degraded_collectors: [],
};

export function NetworkPreview() {
  const [target, setTarget] = useState<{ kind: string; name: string } | null>({ kind: 'Service', name: 'fraud-scoring' });
  return (
    <>
      <div className="breadcrumbs">Cluster / payments / Network</div>
      <div className="title-row">
        <div>
          <h1>Network</h1>
          <p>
            Services, endpoints and ingress routes in <b>payments</b>
          </p>
        </div>
      </div>
      <NetworkPage data={FIXTURE} loading={false} error="" onRefresh={() => undefined} onEditYaml={(kind, name) => setTarget({ kind, name })} />
      {target && (
        <YamlEditor
          context="prod-shark"
          namespace="payments"
          kind={target.kind}
          name={target.name}
          canEdit
          onClose={() => setTarget(null)}
          onSaved={() => undefined}
          notify={(text, detail) => console.log('[toast]', text, detail)}
          confirmSave={() => true}
        />
      )}
    </>
  );
}
