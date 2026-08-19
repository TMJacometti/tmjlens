import type { Severity } from './cluster';

export type PortInfo = {
  name?: string;
  port: number;
  target_port?: string;
  node_port?: number;
  protocol: string;
};

export type EndpointPod = {
  address: string;
  pod?: string;
  node?: string;
  ready: boolean;
  terminating: boolean;
};

export type ServiceInfo = {
  name: string;
  service_type: string;
  cluster_ip: string;
  external_address?: string;
  ports: PortInfo[];
  selector: string[];
  ready_endpoints: number;
  total_endpoints: number;
  backing_pods: EndpointPod[];
  health: Severity;
  reason: string;
  age: string;
};

export type IngressRule = {
  host: string;
  path: string;
  path_type: string;
  service: string;
  port: string;
  tls: boolean;
  /** Why this route cannot serve, when it cannot. */
  problem?: string;
};

export type IngressInfo = {
  name: string;
  class: string;
  address?: string;
  tls_hosts: string[];
  rules: IngressRule[];
  health: Severity;
  reason: string;
  age: string;
};

export type NetworkFinding = {
  severity: Severity;
  title: string;
  detail: string;
  count: number;
  targets: string[];
  hint: string;
};

export type EndpointSliceInfo = {
  name: string;
  service?: string;
  address_type: string;
  ports: string[];
  ready: number;
  total: number;
  endpoints: EndpointPod[];
  health: Severity;
  age: string;
};

/** The legacy core/v1 Endpoints object, superseded by EndpointSlice. */
export type EndpointsInfo = {
  name: string;
  addresses: string[];
  not_ready_addresses: string[];
  ports: string[];
  health: Severity;
  age: string;
};

export type IngressClassInfo = {
  name: string;
  controller: string;
  is_default: boolean;
  age: string;
};

export type NetworkPolicyInfo = {
  name: string;
  pod_selector: string[];
  applies_to_all: boolean;
  policy_types: string[];
  ingress_rules: number;
  egress_rules: number;
  effect: string;
  age: string;
};

export type NetworkOverview = {
  namespace: string;
  services: ServiceInfo[];
  endpoint_slices: EndpointSliceInfo[];
  endpoints: EndpointsInfo[];
  ingresses: IngressInfo[];
  ingress_classes: IngressClassInfo[];
  network_policies: NetworkPolicyInfo[];
  findings: NetworkFinding[];
  degraded_collectors: string[];
};

export type NetworkView =
  | 'Services'
  | 'Endpoint Slices'
  | 'Endpoints'
  | 'Ingresses'
  | 'Ingress Classes'
  | 'Network Policies';

export const NETWORK_VIEWS: NetworkView[] = [
  'Services',
  'Endpoint Slices',
  'Endpoints',
  'Ingresses',
  'Ingress Classes',
  'Network Policies',
];

export function viewCount(data: NetworkOverview, view: NetworkView): number {
  switch (view) {
    case 'Services':
      return data.services.length;
    case 'Endpoint Slices':
      return data.endpoint_slices.length;
    case 'Endpoints':
      return data.endpoints.length;
    case 'Ingresses':
      return data.ingresses.length;
    case 'Ingress Classes':
      return data.ingress_classes.length;
    case 'Network Policies':
      return data.network_policies.length;
  }
}

export function formatPorts(ports: PortInfo[]): string {
  if (ports.length === 0) return 'none';
  return ports
    .map((port) => {
      const target = port.target_port && port.target_port !== String(port.port) ? `→${port.target_port}` : '';
      const node = port.node_port ? ` (node ${port.node_port})` : '';
      return `${port.port}${target}/${port.protocol}${node}`;
    })
    .join(', ');
}
