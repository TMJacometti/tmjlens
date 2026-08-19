use k8s_openapi::api::{
    core::v1::{Endpoints, Service},
    discovery::v1::EndpointSlice,
    networking::v1::{Ingress, IngressClass, NetworkPolicy},
};
use kube::{api::ListParams, Api, Client};
use serde::Serialize;
use std::collections::HashMap;

use crate::format_age;

const FINDING_TARGET_LIMIT: usize = 10;

#[derive(Serialize, Clone)]
pub struct NetworkOverview {
    pub namespace: String,
    pub services: Vec<ServiceInfo>,
    pub endpoint_slices: Vec<EndpointSliceInfo>,
    pub endpoints: Vec<EndpointsInfo>,
    pub ingresses: Vec<IngressInfo>,
    pub ingress_classes: Vec<IngressClassInfo>,
    pub network_policies: Vec<NetworkPolicyInfo>,
    pub findings: Vec<NetworkFinding>,
    pub degraded_collectors: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct EndpointSliceInfo {
    pub name: String,
    pub service: Option<String>,
    pub address_type: String,
    pub ports: Vec<String>,
    pub ready: usize,
    pub total: usize,
    pub endpoints: Vec<EndpointPod>,
    pub health: String,
    pub age: String,
}

/// The legacy core/v1 Endpoints object. Superseded by EndpointSlice but still written
/// by the control plane, and still what some older controllers read.
#[derive(Serialize, Clone)]
pub struct EndpointsInfo {
    pub name: String,
    pub addresses: Vec<String>,
    pub not_ready_addresses: Vec<String>,
    pub ports: Vec<String>,
    pub health: String,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct IngressClassInfo {
    pub name: String,
    pub controller: String,
    pub is_default: bool,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct NetworkPolicyInfo {
    pub name: String,
    /// Empty selector means the policy applies to every pod in the namespace.
    pub pod_selector: Vec<String>,
    pub applies_to_all: bool,
    pub policy_types: Vec<String>,
    pub ingress_rules: usize,
    pub egress_rules: usize,
    /// A policy type with no rules denies all traffic of that direction.
    pub effect: String,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct ServiceInfo {
    pub name: String,
    pub service_type: String,
    pub cluster_ip: String,
    pub external_address: Option<String>,
    pub ports: Vec<PortInfo>,
    pub selector: Vec<String>,
    pub ready_endpoints: usize,
    pub total_endpoints: usize,
    pub backing_pods: Vec<EndpointPod>,
    pub health: String,
    pub reason: String,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct PortInfo {
    pub name: Option<String>,
    pub port: i32,
    pub target_port: Option<String>,
    pub node_port: Option<i32>,
    pub protocol: String,
}

#[derive(Serialize, Clone)]
pub struct EndpointPod {
    pub address: String,
    pub pod: Option<String>,
    pub node: Option<String>,
    pub ready: bool,
    pub terminating: bool,
}

#[derive(Serialize, Clone)]
pub struct IngressInfo {
    pub name: String,
    pub class: String,
    pub address: Option<String>,
    pub tls_hosts: Vec<String>,
    pub rules: Vec<IngressRule>,
    pub health: String,
    pub reason: String,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct IngressRule {
    pub host: String,
    pub path: String,
    pub path_type: String,
    pub service: String,
    pub port: String,
    pub tls: bool,
    /// Set when the rule points at a Service that is missing, exposes no matching
    /// port, or has nothing ready behind it — the reasons a route returns 503.
    pub problem: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct NetworkFinding {
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub count: usize,
    pub targets: Vec<String>,
    pub hint: String,
}

/// A headless Service has no cluster IP by design and is not a fault.
fn is_headless(cluster_ip: &str) -> bool {
    cluster_ip == "None"
}

fn port_reference(port: &k8s_openapi::api::networking::v1::ServiceBackendPort) -> String {
    port.name
        .clone()
        .or_else(|| port.number.map(|number| number.to_string()))
        .unwrap_or_else(|| "unspecified".to_string())
}

/// Matches an Ingress backend port against what the Service actually exposes.
/// A rule may reference a port by name or by number, and both must resolve.
fn service_exposes(service: &ServiceInfo, reference: &str) -> bool {
    service.ports.iter().any(|port| {
        port.name.as_deref() == Some(reference) || port.port.to_string() == reference
    })
}

pub async fn collect(client: Client, namespace: &str) -> Result<NetworkOverview, String> {
    let mut degraded_collectors = Vec::new();

    let services_api: Api<Service> = Api::namespaced(client.clone(), namespace);
    let ingresses_api: Api<Ingress> = Api::namespaced(client.clone(), namespace);
    let slices_api: Api<EndpointSlice> = Api::namespaced(client.clone(), namespace);
    let endpoints_api: Api<Endpoints> = Api::namespaced(client.clone(), namespace);
    let policies_api: Api<NetworkPolicy> = Api::namespaced(client.clone(), namespace);
    // IngressClass is cluster-scoped: which controllers exist is not a namespace fact.
    let classes_api: Api<IngressClass> = Api::all(client);
    let params = ListParams::default();

    let (services, ingresses, slices, endpoints, policies, classes) = tokio::join!(
        services_api.list(&params),
        ingresses_api.list(&params),
        slices_api.list(&params),
        endpoints_api.list(&params),
        policies_api.list(&params),
        classes_api.list(&params),
    );

    let services = services.map_err(|error| format!("Unable to list Services: {error}"))?;

    // EndpointSlices carry the Service they belong to as a label. Grouping by it is
    // what turns "the Service exists" into "something is actually serving it".
    let mut endpoints_by_service: HashMap<String, Vec<EndpointPod>> = HashMap::new();
    let mut slice_infos: Vec<EndpointSliceInfo> = Vec::new();
    match slices {
        Ok(list) => {
            for slice in list.items {
                let service_name = slice
                    .metadata
                    .labels
                    .as_ref()
                    .and_then(|labels| labels.get("kubernetes.io/service-name"))
                    .cloned();

                let pods: Vec<EndpointPod> = slice
                    .endpoints
                    .iter()
                    .map(|endpoint| {
                        let conditions = endpoint.conditions.clone().unwrap_or_default();
                        EndpointPod {
                            address: endpoint.addresses.first().cloned().unwrap_or_default(),
                            pod: endpoint.target_ref.as_ref().and_then(|target| target.name.clone()),
                            node: endpoint.node_name.clone(),
                            // An absent `ready` means ready, per the EndpointSlice contract.
                            ready: conditions.ready.unwrap_or(true),
                            terminating: conditions.terminating.unwrap_or(false),
                        }
                    })
                    .collect();

                if let Some(service_name) = service_name.clone() {
                    endpoints_by_service.entry(service_name).or_default().extend(pods.clone());
                }

                let ready = pods.iter().filter(|pod| pod.ready).count();
                slice_infos.push(EndpointSliceInfo {
                    name: slice.metadata.name.clone().unwrap_or_default(),
                    service: service_name,
                    address_type: slice.address_type.clone(),
                    ports: slice
                        .ports
                        .iter()
                        .flatten()
                        .map(|port| match (port.name.as_deref(), port.port) {
                            (Some(name), Some(number)) if !name.is_empty() => format!("{name}:{number}"),
                            (_, Some(number)) => number.to_string(),
                            _ => "unnamed".to_string(),
                        })
                        .collect(),
                    health: if pods.is_empty() {
                        "warning".to_string()
                    } else if ready == 0 {
                        "critical".to_string()
                    } else if ready < pods.len() {
                        "serious".to_string()
                    } else {
                        "good".to_string()
                    },
                    age: slice
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|stamp| format_age(stamp.0))
                        .unwrap_or_else(|| "n/a".to_string()),
                    ready,
                    total: pods.len(),
                    endpoints: pods,
                });
            }
            slice_infos.sort_by(|left, right| left.name.cmp(&right.name));
        }
        Err(error) => degraded_collectors
            .push(format!("EndpointSlices could not be listed ({error}). Service backing is unknown.")),
    }

    let endpoint_infos = match endpoints {
        Ok(list) => list
            .items
            .into_iter()
            .map(|entry| {
                let subsets = entry.subsets.unwrap_or_default();
                let addresses: Vec<String> = subsets
                    .iter()
                    .flat_map(|subset| subset.addresses.iter().flatten())
                    .map(|address| address.ip.clone())
                    .collect();
                let not_ready: Vec<String> = subsets
                    .iter()
                    .flat_map(|subset| subset.not_ready_addresses.iter().flatten())
                    .map(|address| address.ip.clone())
                    .collect();
                EndpointsInfo {
                    name: entry.metadata.name.unwrap_or_default(),
                    health: if addresses.is_empty() { "critical".to_string() } else if not_ready.is_empty() { "good".to_string() } else { "serious".to_string() },
                    ports: subsets
                        .iter()
                        .flat_map(|subset| subset.ports.iter().flatten())
                        .map(|port| match port.name.as_deref() {
                            Some(name) if !name.is_empty() => format!("{name}:{}", port.port),
                            _ => port.port.to_string(),
                        })
                        .collect(),
                    age: entry
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|stamp| format_age(stamp.0))
                        .unwrap_or_else(|| "n/a".to_string()),
                    addresses,
                    not_ready_addresses: not_ready,
                }
            })
            .collect(),
        Err(error) => {
            degraded_collectors.push(format!("Endpoints could not be listed ({error})."));
            Vec::new()
        }
    };

    let class_infos = match classes {
        Ok(list) => list
            .items
            .into_iter()
            .map(|class| IngressClassInfo {
                is_default: class
                    .metadata
                    .annotations
                    .as_ref()
                    .and_then(|annotations| annotations.get("ingressclass.kubernetes.io/is-default-class"))
                    .map(|value| value == "true")
                    .unwrap_or(false),
                controller: class
                    .spec
                    .as_ref()
                    .and_then(|spec| spec.controller.clone())
                    .unwrap_or_else(|| "unknown".to_string()),
                age: class
                    .metadata
                    .creation_timestamp
                    .as_ref()
                    .map(|stamp| format_age(stamp.0))
                    .unwrap_or_else(|| "n/a".to_string()),
                name: class.metadata.name.unwrap_or_default(),
            })
            .collect(),
        Err(error) => {
            degraded_collectors.push(format!("IngressClasses could not be listed ({error})."));
            Vec::new()
        }
    };

    let policy_infos = match policies {
        Ok(list) => list.items.into_iter().map(build_policy).collect(),
        Err(error) => {
            degraded_collectors.push(format!("NetworkPolicies could not be listed ({error})."));
            Vec::new()
        }
    };

    let service_infos: Vec<ServiceInfo> = services
        .items
        .into_iter()
        .filter_map(|service| {
            let name = service.metadata.name.clone()?;
            let spec = service.spec.clone().unwrap_or_default();
            let service_type = spec.type_.clone().unwrap_or_else(|| "ClusterIP".to_string());
            let cluster_ip = spec.cluster_ip.clone().unwrap_or_else(|| "None".to_string());

            let selector: Vec<String> = spec
                .selector
                .clone()
                .map(|labels| labels.iter().map(|(key, value)| format!("{key}={value}")).collect())
                .unwrap_or_default();

            let ports: Vec<PortInfo> = spec
                .ports
                .clone()
                .unwrap_or_default()
                .into_iter()
                .map(|port| PortInfo {
                    name: port.name,
                    port: port.port,
                    target_port: port.target_port.map(|value| match value {
                        k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(number) => number.to_string(),
                        k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(text) => text,
                    }),
                    node_port: port.node_port,
                    protocol: port.protocol.unwrap_or_else(|| "TCP".to_string()),
                })
                .collect();

            let external_address = service
                .status
                .as_ref()
                .and_then(|status| status.load_balancer.as_ref())
                .and_then(|balancer| balancer.ingress.as_ref())
                .and_then(|entries| entries.first())
                .and_then(|entry| entry.ip.clone().or_else(|| entry.hostname.clone()))
                .or_else(|| spec.external_ips.clone().and_then(|ips| ips.first().cloned()));

            let backing_pods = endpoints_by_service.get(&name).cloned().unwrap_or_default();
            let ready_endpoints = backing_pods.iter().filter(|pod| pod.ready).count();
            let total_endpoints = backing_pods.len();

            // An ExternalName Service resolves through DNS and never has endpoints;
            // a selector-less Service is wired by hand. Neither is broken.
            let (health, reason) = if service_type == "ExternalName" {
                ("good", format!("Resolves to {}", spec.external_name.clone().unwrap_or_default()))
            } else if selector.is_empty() {
                if total_endpoints > 0 {
                    ("good", "Manually managed endpoints".to_string())
                } else {
                    ("warning", "No selector and no endpoints".to_string())
                }
            } else if total_endpoints == 0 {
                ("critical", "Selector matches no pods".to_string())
            } else if ready_endpoints == 0 {
                ("critical", format!("{total_endpoints} endpoint(s), none ready"))
            } else if ready_endpoints < total_endpoints {
                ("serious", format!("{ready_endpoints} of {total_endpoints} endpoints ready"))
            } else if service_type == "LoadBalancer" && external_address.is_none() {
                ("warning", "Load balancer address still pending".to_string())
            } else {
                ("good", format!("{ready_endpoints} endpoint(s) ready"))
            };

            // A headless Service is a distinct routing model — DNS returns the pod
            // addresses directly instead of a virtual IP — so it is named as one.
            let service_type = if is_headless(&cluster_ip) && service_type == "ClusterIP" {
                "Headless".to_string()
            } else {
                service_type
            };

            Some(ServiceInfo {
                age: service
                    .metadata
                    .creation_timestamp
                    .as_ref()
                    .map(|stamp| format_age(stamp.0))
                    .unwrap_or_else(|| "n/a".to_string()),
                health: health.to_string(),
                reason,
                name,
                service_type,
                cluster_ip,
                external_address,
                ports,
                selector,
                ready_endpoints,
                total_endpoints,
                backing_pods,
            })
        })
        .collect();

    let ingress_infos = match ingresses {
        Ok(list) => build_ingresses(list.items, &service_infos),
        Err(error) => {
            degraded_collectors.push(format!("Ingresses could not be listed ({error})."));
            Vec::new()
        }
    };

    let findings = build_findings(&service_infos, &ingress_infos);

    Ok(NetworkOverview {
        namespace: namespace.to_string(),
        services: service_infos,
        endpoint_slices: slice_infos,
        endpoints: endpoint_infos,
        ingresses: ingress_infos,
        ingress_classes: class_infos,
        network_policies: policy_infos,
        findings,
        degraded_collectors,
    })
}

/// A NetworkPolicy's effect is easy to misread: naming a policy type but giving it no
/// rules is what denies all traffic in that direction, and an empty pod selector means
/// the policy covers every pod in the namespace rather than none.
fn build_policy(policy: NetworkPolicy) -> NetworkPolicyInfo {
    let spec = policy.spec.clone().unwrap_or_default();
    let pod_selector: Vec<String> = spec
        .pod_selector
        .match_labels
        .clone()
        .map(|labels| labels.iter().map(|(key, value)| format!("{key}={value}")).collect())
        .unwrap_or_default();
    let applies_to_all = pod_selector.is_empty();

    let ingress_rules = spec.ingress.as_ref().map(Vec::len).unwrap_or(0);
    let egress_rules = spec.egress.as_ref().map(Vec::len).unwrap_or(0);
    let declared = spec.policy_types.clone().unwrap_or_default();

    let denies_ingress = declared.iter().any(|entry| entry == "Ingress") && ingress_rules == 0;
    let denies_egress = declared.iter().any(|entry| entry == "Egress") && egress_rules == 0;
    let effect = match (denies_ingress, denies_egress) {
        (true, true) => "Denies all ingress and egress".to_string(),
        (true, false) => "Denies all ingress".to_string(),
        (false, true) => "Denies all egress".to_string(),
        (false, false) => format!("Allows {ingress_rules} ingress and {egress_rules} egress rule(s)"),
    };

    NetworkPolicyInfo {
        name: policy.metadata.name.unwrap_or_default(),
        age: policy
            .metadata
            .creation_timestamp
            .as_ref()
            .map(|stamp| format_age(stamp.0))
            .unwrap_or_else(|| "n/a".to_string()),
        pod_selector,
        applies_to_all,
        policy_types: declared,
        ingress_rules,
        egress_rules,
        effect,
    }
}

fn build_ingresses(items: Vec<Ingress>, services: &[ServiceInfo]) -> Vec<IngressInfo> {
    items
        .into_iter()
        .filter_map(|ingress| {
            let name = ingress.metadata.name.clone()?;
            let spec = ingress.spec.clone().unwrap_or_default();

            let tls_hosts: Vec<String> = spec
                .tls
                .clone()
                .unwrap_or_default()
                .into_iter()
                .flat_map(|entry| entry.hosts.unwrap_or_default())
                .collect();

            let address = ingress
                .status
                .as_ref()
                .and_then(|status| status.load_balancer.as_ref())
                .and_then(|balancer| balancer.ingress.as_ref())
                .and_then(|entries| entries.first())
                .and_then(|entry| entry.ip.clone().or_else(|| entry.hostname.clone()));

            let mut rules = Vec::new();
            for rule in spec.rules.clone().unwrap_or_default() {
                let host = rule.host.clone().unwrap_or_else(|| "*".to_string());
                let tls = tls_hosts.iter().any(|entry| entry == &host);
                for path in rule.http.map(|http| http.paths).unwrap_or_default() {
                    let backend = path.backend.service.clone();
                    let service_name = backend.as_ref().map(|value| value.name.clone()).unwrap_or_default();
                    let port = backend
                        .as_ref()
                        .and_then(|value| value.port.as_ref())
                        .map(port_reference)
                        .unwrap_or_else(|| "unspecified".to_string());

                    let target = services.iter().find(|service| service.name == service_name);
                    let problem = match target {
                        None if service_name.is_empty() => Some("The rule declares no backend Service".to_string()),
                        None => Some(format!("Service {service_name} does not exist in this namespace")),
                        Some(service) if !service_exposes(service, &port) => {
                            Some(format!("Service {service_name} does not expose port {port}"))
                        }
                        Some(service) if service.ready_endpoints == 0 && service.service_type != "ExternalName" => {
                            Some(format!("Service {service_name} has no ready endpoints"))
                        }
                        Some(_) => None,
                    };

                    rules.push(IngressRule {
                        host: host.clone(),
                        path: path.path.clone().unwrap_or_else(|| "/".to_string()),
                        path_type: path.path_type.clone(),
                        service: service_name,
                        port,
                        tls,
                        problem,
                    });
                }
            }

            let broken = rules.iter().filter(|rule| rule.problem.is_some()).count();
            let (health, reason) = if broken > 0 {
                ("critical", format!("{broken} of {} route(s) cannot serve", rules.len()))
            } else if address.is_none() {
                ("warning", "No address assigned by the controller yet".to_string())
            } else if rules.is_empty() {
                ("warning", "No routing rules defined".to_string())
            } else {
                ("good", format!("{} route(s) reachable", rules.len()))
            };

            Some(IngressInfo {
                age: ingress
                    .metadata
                    .creation_timestamp
                    .as_ref()
                    .map(|stamp| format_age(stamp.0))
                    .unwrap_or_else(|| "n/a".to_string()),
                class: spec
                    .ingress_class_name
                    .clone()
                    .or_else(|| {
                        ingress
                            .metadata
                            .annotations
                            .as_ref()
                            .and_then(|annotations| annotations.get("kubernetes.io/ingress.class").cloned())
                    })
                    .unwrap_or_else(|| "default".to_string()),
                health: health.to_string(),
                reason,
                name,
                address,
                tls_hosts,
                rules,
            })
        })
        .collect()
}

fn build_findings(services: &[ServiceInfo], ingresses: &[IngressInfo]) -> Vec<NetworkFinding> {
    let mut findings = Vec::new();

    let dead: Vec<&ServiceInfo> = services
        .iter()
        .filter(|service| service.health == "critical")
        .collect();
    if !dead.is_empty() {
        findings.push(NetworkFinding {
            severity: "critical".to_string(),
            title: "Services with nothing ready behind them".to_string(),
            detail: "These Services resolve and accept connections, but no ready pod is backing them — every request returns a connection error or a 503. This is the most common cause of an outage that looks like a networking fault.".to_string(),
            count: dead.len(),
            targets: dead
                .iter()
                .take(FINDING_TARGET_LIMIT)
                .map(|service| format!("{} — {}", service.name, service.reason))
                .collect(),
            hint: "Check that the Service selector still matches the pod labels, and that the pods are passing their readiness probe.".to_string(),
        });
    }

    let degraded: Vec<&ServiceInfo> = services.iter().filter(|service| service.health == "serious").collect();
    if !degraded.is_empty() {
        findings.push(NetworkFinding {
            severity: "serious".to_string(),
            title: "Services serving on reduced capacity".to_string(),
            detail: "Some endpoints are not ready, so traffic concentrates on the remainder.".to_string(),
            count: degraded.len(),
            targets: degraded
                .iter()
                .take(FINDING_TARGET_LIMIT)
                .map(|service| format!("{} — {}", service.name, service.reason))
                .collect(),
            hint: "A rolling update explains this briefly; anything longer points at a failing readiness probe.".to_string(),
        });
    }

    let pending: Vec<&ServiceInfo> = services
        .iter()
        .filter(|service| service.service_type == "LoadBalancer" && service.external_address.is_none())
        .collect();
    if !pending.is_empty() {
        findings.push(NetworkFinding {
            severity: "warning".to_string(),
            title: "Load balancers without an address".to_string(),
            detail: "The cloud controller has not assigned an external address. On a cluster with no load balancer provider this never resolves.".to_string(),
            count: pending.len(),
            targets: pending.iter().take(FINDING_TARGET_LIMIT).map(|service| service.name.clone()).collect(),
            hint: "Check the cloud controller manager, or the Service events for a quota or subnet error.".to_string(),
        });
    }

    let broken_routes: Vec<String> = ingresses
        .iter()
        .flat_map(|ingress| {
            ingress.rules.iter().filter_map(move |rule| {
                rule.problem
                    .as_ref()
                    .map(|problem| format!("{}: {}{} — {problem}", ingress.name, rule.host, rule.path))
            })
        })
        .collect();
    if !broken_routes.is_empty() {
        findings.push(NetworkFinding {
            severity: "critical".to_string(),
            title: "Ingress routes that cannot serve".to_string(),
            detail: "These routes are published but point at a Service that is missing, does not expose the referenced port, or has no ready endpoints.".to_string(),
            count: broken_routes.len(),
            targets: broken_routes.into_iter().take(FINDING_TARGET_LIMIT).collect(),
            hint: "The ingress controller returns 503 for these paths. Fix the backend before looking at the controller.".to_string(),
        });
    }

    let unaddressed: Vec<&IngressInfo> = ingresses.iter().filter(|ingress| ingress.address.is_none()).collect();
    if !unaddressed.is_empty() {
        findings.push(NetworkFinding {
            severity: "warning".to_string(),
            title: "Ingresses with no address".to_string(),
            detail: "No controller has claimed these Ingresses, so nothing is routing to them.".to_string(),
            count: unaddressed.len(),
            targets: unaddressed
                .iter()
                .take(FINDING_TARGET_LIMIT)
                .map(|ingress| format!("{} (class {})", ingress.name, ingress.class))
                .collect(),
            hint: "Verify that an ingress controller is installed and that its class matches the one requested.".to_string(),
        });
    }

    if findings.is_empty() {
        findings.push(NetworkFinding {
            severity: "good".to_string(),
            title: "Every route reaches something".to_string(),
            detail: "Each Service has ready endpoints and each Ingress rule points at a Service that exposes the port it references.".to_string(),
            count: 0,
            targets: Vec::new(),
            hint: "This reflects the namespace the console is pointed at, not the whole cluster.".to_string(),
        });
    }

    let rank = |severity: &str| match severity {
        "critical" => 0,
        "serious" => 1,
        "warning" => 2,
        _ => 3,
    };
    findings.sort_by_key(|finding| rank(&finding.severity));
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(name: &str, ports: Vec<(Option<&str>, i32)>) -> ServiceInfo {
        ServiceInfo {
            name: name.into(),
            service_type: "ClusterIP".into(),
            cluster_ip: "10.0.0.1".into(),
            external_address: None,
            ports: ports
                .into_iter()
                .map(|(port_name, port)| PortInfo {
                    name: port_name.map(str::to_string),
                    port,
                    target_port: None,
                    node_port: None,
                    protocol: "TCP".into(),
                })
                .collect(),
            selector: vec!["app=x".into()],
            ready_endpoints: 1,
            total_endpoints: 1,
            backing_pods: Vec::new(),
            health: "good".into(),
            reason: String::new(),
            age: "1d".into(),
        }
    }

    #[test]
    fn matches_an_ingress_backend_port_by_name_or_number() {
        let target = service("api", vec![(Some("http"), 8080)]);
        assert!(service_exposes(&target, "http"));
        assert!(service_exposes(&target, "8080"));
        assert!(!service_exposes(&target, "https"));
        assert!(!service_exposes(&target, "80"));
    }

    #[test]
    fn recognises_a_headless_service() {
        assert!(is_headless("None"));
        assert!(!is_headless("10.96.0.1"));
    }

    #[test]
    fn reports_a_service_with_no_ready_endpoints_as_critical() {
        let mut dead = service("api", vec![(None, 80)]);
        dead.health = "critical".into();
        dead.reason = "Selector matches no pods".into();

        let findings = build_findings(&[dead], &[]);
        assert_eq!(findings[0].severity, "critical");
        assert!(findings[0].title.contains("nothing ready"));
    }

    #[test]
    fn says_so_when_nothing_is_wrong() {
        let findings = build_findings(&[service("api", vec![(None, 80)])], &[]);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].severity, "good");
    }

    #[test]
    fn sorts_findings_by_severity() {
        let mut dead = service("dead", vec![(None, 80)]);
        dead.health = "critical".into();
        let mut degraded = service("degraded", vec![(None, 80)]);
        degraded.health = "serious".into();
        let mut pending = service("pending", vec![(None, 80)]);
        pending.service_type = "LoadBalancer".into();

        let findings = build_findings(&[pending, degraded, dead], &[]);
        let severities: Vec<&str> = findings.iter().map(|finding| finding.severity.as_str()).collect();
        assert_eq!(severities, vec!["critical", "serious", "warning"]);
    }
}
