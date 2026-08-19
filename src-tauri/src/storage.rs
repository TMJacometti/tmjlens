use k8s_openapi::api::{
    core::v1::{PersistentVolume, PersistentVolumeClaim, Pod},
    storage::v1::StorageClass,
};
use kube::{api::ListParams, Api, Client};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};

use crate::configuration::parse_quantity;
use crate::format_age;

/// Annotations Kubernetes writes to mark the cluster's default class. The beta key is
/// still present on clusters upgraded from older versions.
const DEFAULT_CLASS_KEYS: [&str; 2] = [
    "storageclass.kubernetes.io/is-default-class",
    "storageclass.beta.kubernetes.io/is-default-class",
];

#[derive(Serialize, Clone)]
pub struct StorageOverview {
    pub namespace: String,
    pub claims: Vec<ClaimInfo>,
    pub volumes: Vec<VolumeInfo>,
    pub classes: Vec<StorageClassInfo>,
    pub findings: Vec<StorageFinding>,
    pub degraded_collectors: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ClaimInfo {
    pub name: String,
    pub phase: String,
    pub health: String,
    pub reason: String,
    pub requested: Option<String>,
    /// What the bound volume actually provides, which is not always what was asked for.
    pub provisioned: Option<String>,
    /// Set when the bound volume is larger than the request, since that is billed.
    pub over_provisioned: Option<String>,
    pub storage_class: Option<String>,
    pub access_modes: Vec<String>,
    pub volume_mode: String,
    pub volume: Option<String>,
    pub used_by: Vec<String>,
    pub used_by_total: usize,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct VolumeInfo {
    pub name: String,
    pub phase: String,
    pub health: String,
    pub reason: String,
    pub capacity: Option<String>,
    pub reclaim_policy: String,
    pub storage_class: Option<String>,
    pub access_modes: Vec<String>,
    /// The claim this volume is bound to, whether or not that claim still exists.
    pub claim: Option<String>,
    pub claim_exists: Option<bool>,
    /// The disk in the cloud provider, so it can be found outside Kubernetes.
    pub source: String,
    pub handle: Option<String>,
    pub zones: Vec<String>,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct StorageClassInfo {
    pub name: String,
    pub provisioner: String,
    pub reclaim_policy: String,
    pub binding_mode: String,
    pub allow_expansion: bool,
    pub is_default: bool,
    pub parameters: Vec<String>,
    pub claims_using: usize,
    pub health: String,
    pub reason: String,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct StorageFinding {
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub targets: Vec<String>,
}

// ---------------------------------------------------------------- helpers

fn quantity_of(map: Option<&std::collections::BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>>) -> Option<String> {
    map?.get("storage").map(|value| value.0.clone())
}

/// Names the actual disk behind a volume, so it can be found in the cloud console.
///
/// A PV row that says only "csi" answers nothing; the handle is what an operator pastes
/// into the provider's search box when deciding whether a released volume is safe to
/// delete.
fn describe_source(volume: &PersistentVolume) -> (String, Option<String>) {
    let Some(spec) = &volume.spec else {
        return ("unknown".to_string(), None);
    };

    if let Some(csi) = &spec.csi {
        return (csi.driver.clone(), Some(csi.volume_handle.clone()));
    }
    if let Some(disk) = &spec.aws_elastic_block_store {
        return ("aws-ebs".to_string(), Some(disk.volume_id.clone()));
    }
    if let Some(disk) = &spec.azure_disk {
        return ("azure-disk".to_string(), Some(disk.disk_uri.clone()));
    }
    if let Some(disk) = &spec.gce_persistent_disk {
        return ("gce-pd".to_string(), Some(disk.pd_name.clone()));
    }
    if let Some(nfs) = &spec.nfs {
        return ("nfs".to_string(), Some(format!("{}:{}", nfs.server, nfs.path)));
    }
    if let Some(path) = &spec.host_path {
        return ("hostPath".to_string(), Some(path.path.clone()));
    }
    if spec.local.is_some() {
        return (
            "local".to_string(),
            spec.local.as_ref().map(|local| local.path.clone()),
        );
    }
    ("unknown".to_string(), None)
}

/// The zones a volume is pinned to, from its node affinity.
///
/// A volume bound to one zone can only ever be mounted by a pod scheduled in that zone,
/// which is why an unschedulable pod is so often a storage problem rather than a
/// capacity one.
fn zones_of(volume: &PersistentVolume) -> Vec<String> {
    let mut zones = BTreeSet::new();
    let terms = volume
        .spec
        .as_ref()
        .and_then(|spec| spec.node_affinity.as_ref())
        .and_then(|affinity| affinity.required.as_ref());

    for term in terms.iter().flat_map(|required| required.node_selector_terms.iter()) {
        for expression in term.match_expressions.iter().flatten() {
            if expression.key.ends_with("/zone") || expression.key.ends_with("/region") {
                for value in expression.values.iter().flatten() {
                    zones.insert(value.clone());
                }
            }
        }
    }
    zones.into_iter().collect()
}

fn claim_health(phase: &str, used_by_total: usize) -> (&'static str, String) {
    match phase {
        "Bound" if used_by_total == 0 => (
            "warning",
            "Bound but not mounted by any running pod. The volume is provisioned and billed."
                .to_string(),
        ),
        "Bound" => ("good", format!("Mounted by {used_by_total} pod(s).")),
        "Pending" => (
            "serious",
            "No volume has been bound. Usually no storage class matched, or the class waits \
             for a pod to be scheduled first."
                .to_string(),
        ),
        "Lost" => (
            "critical",
            "The volume backing this claim no longer exists. Data written to it is gone."
                .to_string(),
        ),
        other => ("warning", format!("Phase {other}.")),
    }
}

fn volume_health(phase: &str, reclaim: &str, claim_exists: Option<bool>) -> (&'static str, String) {
    match phase {
        // The expensive one: released volumes are never reused, and with Retain the
        // cloud disk stays allocated and billed until someone deletes it by hand.
        "Released" if reclaim == "Retain" => (
            "serious",
            "Its claim is gone but the disk is retained. Kubernetes will never reuse this \
             volume, and the cloud provider keeps billing for it until it is deleted."
                .to_string(),
        ),
        "Released" => (
            "warning",
            "Its claim is gone. The volume is waiting to be reclaimed.".to_string(),
        ),
        "Failed" => (
            "critical",
            "Reclaiming this volume failed. It is neither usable nor cleaned up.".to_string(),
        ),
        "Available" => ("good", "Free, waiting for a claim.".to_string()),
        "Bound" if claim_exists == Some(false) => (
            "critical",
            "Bound to a claim that no longer exists. The volume is stranded.".to_string(),
        ),
        "Bound" => ("good", "In use.".to_string()),
        other => ("warning", format!("Phase {other}.")),
    }
}

fn class_health(binding_mode: &str, allow_expansion: bool, reclaim: &str) -> (&'static str, String) {
    let mut notes = Vec::new();

    // Immediate binding provisions the disk before a pod is scheduled, so the volume
    // picks a zone first and the scheduler is then forced into it. On a multi-zone
    // cluster this is a common cause of pods that never schedule.
    if binding_mode == "Immediate" {
        notes.push(
            "Binds immediately, so the volume picks a zone before a pod is scheduled — on a \
             multi-zone cluster this can leave pods unschedulable."
                .to_string(),
        );
    }
    if !allow_expansion {
        notes.push("Volumes from this class cannot be grown later.".to_string());
    }
    if reclaim == "Delete" {
        notes.push("Deleting a claim destroys the data behind it.".to_string());
    }

    if notes.is_empty() {
        return ("good", "Waits for a pod, expandable, retains data.".to_string());
    }
    let severity = if binding_mode == "Immediate" { "warning" } else { "good" };
    (severity, notes.join(" "))
}

// ---------------------------------------------------------------- collectors

fn claim_consumers(pods: &[Pod]) -> HashMap<String, BTreeSet<String>> {
    let mut found: HashMap<String, BTreeSet<String>> = HashMap::new();
    for pod in pods {
        let name = pod.metadata.name.clone().unwrap_or_default();
        for volume in pod.spec.iter().flat_map(|spec| spec.volumes.iter().flatten()) {
            if let Some(claim) = &volume.persistent_volume_claim {
                found.entry(claim.claim_name.clone()).or_default().insert(name.clone());
            }
        }
    }
    found
}

fn claim_info(item: PersistentVolumeClaim, consumers: &HashMap<String, BTreeSet<String>>) -> ClaimInfo {
    let spec = item.spec.unwrap_or_default();
    let status = item.status.unwrap_or_default();
    let phase = status.phase.unwrap_or_else(|| "Unknown".to_string());

    let name = item.metadata.name.clone().unwrap_or_default();
    let pods: Vec<String> = consumers.get(&name).map(|set| set.iter().cloned().collect()).unwrap_or_default();
    let used_by_total = pods.len();

    let requested = spec.resources.as_ref().and_then(|resources| quantity_of(resources.requests.as_ref()));
    let provisioned = quantity_of(status.capacity.as_ref());

    // A claim for 10Gi bound to a 100Gi volume is billed for 100Gi. Kubernetes reports
    // both numbers and never compares them.
    let over_provisioned = match (
        requested.as_deref().and_then(parse_quantity),
        provisioned.as_deref().and_then(parse_quantity),
    ) {
        (Some(asked), Some(given)) if given > asked * 1.05 => Some(format!(
            "{} provisioned for a {} request",
            provisioned.clone().unwrap_or_default(),
            requested.clone().unwrap_or_default()
        )),
        _ => None,
    };

    let (health, reason) = claim_health(&phase, used_by_total);

    ClaimInfo {
        storage_class: spec.storage_class_name,
        access_modes: spec.access_modes.unwrap_or_default(),
        volume_mode: spec.volume_mode.unwrap_or_else(|| "Filesystem".to_string()),
        volume: spec.volume_name,
        age: item.metadata.creation_timestamp.as_ref().map(|stamp| format_age(stamp.0)).unwrap_or_default(),
        used_by: pods.into_iter().take(6).collect(),
        health: health.to_string(),
        used_by_total,
        over_provisioned,
        provisioned,
        requested,
        reason,
        phase,
        name,
    }
}

fn volume_info(item: PersistentVolume, known_claims: Option<&BTreeSet<String>>) -> VolumeInfo {
    let (source, handle) = describe_source(&item);
    let zones = zones_of(&item);
    let spec = item.spec.clone().unwrap_or_default();
    let status = item.status.unwrap_or_default();
    let phase = status.phase.unwrap_or_else(|| "Unknown".to_string());
    let reclaim = spec.persistent_volume_reclaim_policy.unwrap_or_else(|| "Delete".to_string());

    let claim = spec.claim_ref.as_ref().and_then(|reference| {
        Some(format!("{}/{}", reference.namespace.clone()?, reference.name.clone()?))
    });
    // Only decidable when the claim list could be read for that namespace.
    let claim_exists = match (&claim, known_claims) {
        (Some(key), Some(known)) => Some(known.contains(key)),
        _ => None,
    };

    let (health, reason) = volume_health(&phase, &reclaim, claim_exists);

    VolumeInfo {
        capacity: quantity_of(spec.capacity.as_ref()),
        access_modes: spec.access_modes.unwrap_or_default(),
        storage_class: spec.storage_class_name,
        age: item.metadata.creation_timestamp.as_ref().map(|stamp| format_age(stamp.0)).unwrap_or_default(),
        name: item.metadata.name.unwrap_or_default(),
        health: health.to_string(),
        reclaim_policy: reclaim,
        claim_exists,
        source,
        handle,
        zones,
        reason,
        claim,
        phase,
    }
}

fn class_info(item: StorageClass, claims_using: usize) -> StorageClassInfo {
    let is_default = item
        .metadata
        .annotations
        .as_ref()
        .is_some_and(|annotations| {
            DEFAULT_CLASS_KEYS
                .iter()
                .any(|key| annotations.get(*key).map(String::as_str) == Some("true"))
        });

    let reclaim = item.reclaim_policy.unwrap_or_else(|| "Delete".to_string());
    let binding_mode = item.volume_binding_mode.unwrap_or_else(|| "Immediate".to_string());
    let allow_expansion = item.allow_volume_expansion.unwrap_or(false);
    let (health, reason) = class_health(&binding_mode, allow_expansion, &reclaim);

    StorageClassInfo {
        parameters: item
            .parameters
            .unwrap_or_default()
            .into_iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect(),
        age: item.metadata.creation_timestamp.as_ref().map(|stamp| format_age(stamp.0)).unwrap_or_default(),
        name: item.metadata.name.unwrap_or_default(),
        provisioner: item.provisioner,
        health: health.to_string(),
        reclaim_policy: reclaim,
        allow_expansion,
        binding_mode,
        claims_using,
        is_default,
        reason,
    }
}

// ---------------------------------------------------------------- findings

fn build_findings(overview: &StorageOverview) -> Vec<StorageFinding> {
    let mut findings = Vec::new();

    let retained: Vec<String> = overview
        .volumes
        .iter()
        .filter(|volume| volume.phase == "Released" && volume.reclaim_policy == "Retain")
        .map(|volume| {
            let size = volume.capacity.clone().unwrap_or_else(|| "unknown size".to_string());
            match &volume.handle {
                Some(handle) => format!("{} · {size} · {handle}", volume.name),
                None => format!("{} · {size}", volume.name),
            }
        })
        .collect();
    if !retained.is_empty() {
        findings.push(StorageFinding {
            severity: "serious".to_string(),
            title: "Released volumes are still being billed".to_string(),
            detail: "Their claims are gone and the reclaim policy is Retain, so Kubernetes will \
                     never reuse them and the cloud provider keeps charging. Each one has to be \
                     deleted by hand once its data is confirmed unneeded."
                .to_string(),
            targets: retained,
        });
    }

    let pending: Vec<String> = overview
        .claims
        .iter()
        .filter(|claim| claim.phase == "Pending")
        .map(|claim| claim.name.clone())
        .collect();
    if !pending.is_empty() {
        findings.push(StorageFinding {
            severity: "serious".to_string(),
            title: "A claim has no volume".to_string(),
            detail: "Any pod that mounts it stays Pending. Either no storage class matched, or \
                     the class waits for a pod to be scheduled and none can be."
                .to_string(),
            targets: pending,
        });
    }

    let lost: Vec<String> = overview
        .claims
        .iter()
        .filter(|claim| claim.phase == "Lost")
        .map(|claim| claim.name.clone())
        .collect();
    if !lost.is_empty() {
        findings.push(StorageFinding {
            severity: "critical".to_string(),
            title: "A claim's volume no longer exists".to_string(),
            detail: "Whatever was written to it is gone. The claim has to be recreated and \
                     restored from a backup."
                .to_string(),
            targets: lost,
        });
    }

    let idle: Vec<String> = overview
        .claims
        .iter()
        .filter(|claim| claim.phase == "Bound" && claim.used_by_total == 0)
        .map(|claim| {
            let size = claim.provisioned.clone().or_else(|| claim.requested.clone()).unwrap_or_default();
            format!("{} · {size}", claim.name)
        })
        .collect();
    if !idle.is_empty() {
        findings.push(StorageFinding {
            severity: "warning".to_string(),
            title: "Bound but not mounted".to_string(),
            detail: "No running pod mounts these claims, yet their volumes are provisioned and \
                     billed. A stopped StatefulSet or a scaled-down workload is the usual reason, \
                     and the data is still there."
                .to_string(),
            targets: idle,
        });
    }

    let oversized: Vec<String> = overview
        .claims
        .iter()
        .filter_map(|claim| {
            claim.over_provisioned.as_ref().map(|note| format!("{} · {note}", claim.name))
        })
        .collect();
    if !oversized.is_empty() {
        findings.push(StorageFinding {
            severity: "warning".to_string(),
            title: "More storage provisioned than requested".to_string(),
            detail: "The bound volume is larger than the claim asked for, and the larger figure \
                     is what the provider bills."
                .to_string(),
            targets: oversized,
        });
    }

    // Zero defaults means every claim must name a class or stay Pending; more than one
    // means which class a claim gets is not deterministic.
    let defaults: Vec<String> = overview
        .classes
        .iter()
        .filter(|class| class.is_default)
        .map(|class| class.name.clone())
        .collect();
    if defaults.len() > 1 {
        findings.push(StorageFinding {
            severity: "serious".to_string(),
            title: "More than one default storage class".to_string(),
            detail: "A claim that names no class gets whichever of these the API server picks. \
                     Exactly one should be marked default."
                .to_string(),
            targets: defaults,
        });
    } else if defaults.is_empty() && !overview.classes.is_empty() {
        findings.push(StorageFinding {
            severity: "warning".to_string(),
            title: "No default storage class".to_string(),
            detail: "A claim that does not name a class will stay Pending forever.".to_string(),
            targets: overview.classes.iter().map(|class| class.name.clone()).collect(),
        });
    }

    findings
}

// ---------------------------------------------------------------- entry point

/// Reads everything the Storage screen shows.
///
/// Claims are namespaced; volumes and classes are cluster-scoped, so an identity that
/// may read its own namespace but not the cluster gets the claims table and a note
/// saying what could not be read, rather than an error page.
pub async fn overview(client: Client, namespace: &str) -> Result<StorageOverview, String> {
    let params = ListParams::default();
    let mut degraded = Vec::new();

    let claims: Api<PersistentVolumeClaim> = Api::namespaced(client.clone(), namespace);
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let volumes: Api<PersistentVolume> = Api::all(client.clone());
    let classes: Api<StorageClass> = Api::all(client.clone());
    let all_claims: Api<PersistentVolumeClaim> = Api::all(client);

    let (claim_list, pod_list, volume_list, class_list, every_claim) = tokio::join!(
        claims.list(&params),
        pods.list(&params),
        volumes.list(&params),
        classes.list(&params),
        all_claims.list(&params),
    );

    let pod_items = match pod_list {
        Ok(list) => list.items,
        Err(error) => {
            degraded.push(format!(
                "Pods could not be listed, so no claim can show what mounts it ({error})."
            ));
            Vec::new()
        }
    };
    let consumers = claim_consumers(&pod_items);
    let pods_known = degraded.is_empty();

    let claim_rows: Vec<ClaimInfo> = match claim_list {
        Ok(list) => list.items.into_iter().map(|item| claim_info(item, &consumers)).collect(),
        Err(error) => {
            degraded.push(format!("Persistent volume claims could not be listed ({error})."));
            Vec::new()
        }
    };

    // A volume's claim reference can point anywhere, so deciding whether it still exists
    // needs the cluster-wide claim list rather than this namespace's.
    let known_claims: Option<BTreeSet<String>> = match every_claim {
        Ok(list) => Some(
            list.items
                .into_iter()
                .filter_map(|claim| Some(format!("{}/{}", claim.metadata.namespace?, claim.metadata.name?)))
                .collect(),
        ),
        Err(_) => None,
    };

    let volume_rows: Vec<VolumeInfo> = match volume_list {
        Ok(list) => list
            .items
            .into_iter()
            .map(|item| volume_info(item, known_claims.as_ref()))
            .collect(),
        Err(error) => {
            degraded.push(format!("Persistent volumes could not be listed ({error})."));
            Vec::new()
        }
    };

    let class_rows: Vec<StorageClassInfo> = match class_list {
        Ok(list) => {
            let mut counts: HashMap<String, usize> = HashMap::new();
            for claim in &claim_rows {
                if let Some(class) = &claim.storage_class {
                    *counts.entry(class.clone()).or_default() += 1;
                }
            }
            list.items
                .into_iter()
                .map(|item| {
                    let using = item
                        .metadata
                        .name
                        .as_ref()
                        .and_then(|name| counts.get(name).copied())
                        .unwrap_or(0);
                    class_info(item, using)
                })
                .collect()
        }
        Err(error) => {
            degraded.push(format!("Storage classes could not be listed ({error})."));
            Vec::new()
        }
    };

    let mut overview = StorageOverview {
        namespace: namespace.to_string(),
        claims: claim_rows,
        volumes: volume_rows,
        classes: class_rows,
        findings: Vec::new(),
        degraded_collectors: degraded,
    };

    overview.findings = build_findings(&overview);
    // "Bound but not mounted" is drawn from the pod list; without it the finding would
    // accuse every claim in the namespace.
    if !pods_known {
        overview.findings.retain(|finding| finding.title != "Bound but not mounted");
    }

    Ok(overview)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_released_volume_that_is_retained_is_called_out_as_billed() {
        let (health, reason) = volume_health("Released", "Retain", None);
        assert_eq!(health, "serious");
        assert!(reason.contains("billing"));
        assert!(reason.contains("never reuse"));
    }

    #[test]
    fn a_released_volume_that_will_be_deleted_is_only_a_warning() {
        // The provider reclaims it on its own, so there is no bill to chase.
        let (health, _) = volume_health("Released", "Delete", None);
        assert_eq!(health, "warning");
    }

    #[test]
    fn a_volume_bound_to_a_claim_that_is_gone_is_critical() {
        let (health, reason) = volume_health("Bound", "Retain", Some(false));
        assert_eq!(health, "critical");
        assert!(reason.contains("stranded"));
    }

    #[test]
    fn a_bound_volume_is_healthy_when_its_claim_could_not_be_checked() {
        // Unknown is not the same as missing; accusing it would be a false alarm.
        let (health, _) = volume_health("Bound", "Retain", None);
        assert_eq!(health, "good");
    }

    #[test]
    fn a_bound_claim_nothing_mounts_is_flagged_rather_than_called_healthy() {
        let (health, reason) = claim_health("Bound", 0);
        assert_eq!(health, "warning");
        assert!(reason.contains("billed"));

        let (health, _) = claim_health("Bound", 2);
        assert_eq!(health, "good");
    }

    #[test]
    fn a_lost_claim_says_the_data_is_gone() {
        let (health, reason) = claim_health("Lost", 0);
        assert_eq!(health, "critical");
        assert!(reason.contains("gone"));
    }

    #[test]
    fn immediate_binding_is_flagged_as_the_scheduling_trap_it_is() {
        let (health, reason) = class_health("Immediate", true, "Delete");
        assert_eq!(health, "warning");
        assert!(reason.contains("unschedulable"));
    }

    #[test]
    fn a_class_that_waits_for_a_pod_and_expands_and_retains_is_clean() {
        let (health, reason) = class_health("WaitForFirstConsumer", true, "Retain");
        assert_eq!(health, "good");
        assert!(reason.contains("Waits for a pod"));
    }

    #[test]
    fn a_non_expandable_class_says_so_without_being_called_a_problem() {
        // It is a design constraint to know about, not a fault.
        let (health, reason) = class_health("WaitForFirstConsumer", false, "Retain");
        assert_eq!(health, "good");
        assert!(reason.contains("cannot be grown"));
    }

    #[test]
    fn a_deleting_class_warns_that_data_goes_with_the_claim() {
        let (_, reason) = class_health("WaitForFirstConsumer", true, "Delete");
        assert!(reason.contains("destroys the data"));
    }

    #[test]
    fn zero_and_two_default_classes_are_both_reported() {
        let class = |name: &str, is_default: bool| StorageClassInfo {
            name: name.to_string(), provisioner: "ebs.csi.aws.com".to_string(),
            reclaim_policy: "Delete".to_string(), binding_mode: "WaitForFirstConsumer".to_string(),
            allow_expansion: true, is_default, parameters: vec![], claims_using: 0,
            health: "good".to_string(), reason: String::new(), age: "1d".to_string(),
        };
        let base = StorageOverview {
            namespace: "payments".to_string(), claims: vec![], volumes: vec![],
            classes: vec![], findings: vec![], degraded_collectors: vec![],
        };

        let none = build_findings(&StorageOverview {
            classes: vec![class("gp3", false)],
            ..base.clone()
        });
        assert!(none.iter().any(|finding| finding.title == "No default storage class"));

        let two = build_findings(&StorageOverview {
            classes: vec![class("gp3", true), class("io2", true)],
            ..base.clone()
        });
        assert!(two.iter().any(|finding| finding.title == "More than one default storage class"));

        let one = build_findings(&StorageOverview {
            classes: vec![class("gp3", true), class("io2", false)],
            ..base
        });
        assert!(!one.iter().any(|finding| finding.title.contains("default storage class")));
    }
}
