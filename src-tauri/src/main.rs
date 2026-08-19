#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cluster;
mod exec;
mod graph;
mod logs;
mod network;
mod portforward;
mod search;
mod settings;
mod streams;
mod watch;
mod workload_list;
mod workloads;

use kube::{
    api::{DeleteParams, ListParams, LogParams, Patch, PatchParams},
    config::{Config, KubeConfigOptions},
    Api, Client,
};
use k8s_openapi::api::{
    apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet},
    batch::v1::{CronJob, Job},
    authorization::v1::{ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec},
    core::v1::{Event, Namespace, Node, Pod, Service},
    networking::v1::Ingress,
};
use serde::Serialize;
use serde_json::json;
use std::{collections::HashMap, process::Command, sync::{Mutex, OnceLock}};

static CLIENT_CACHE: OnceLock<Mutex<HashMap<String, Client>>> = OnceLock::new();

#[derive(Serialize, Clone)]
struct ContextInfo {
    name: String,
    namespace: Option<String>,
}

#[derive(Serialize, Clone)]
struct KubeContext {
    name: String,
    current: bool,
    namespace: Option<String>,
}

#[derive(Serialize, Clone)]
struct EventInfo {
    reason: String,
    message: String,
    kind: String,
    name: String,
    timestamp: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct PodInfo {
    pub name: String,
    pub status: String,
    pub ready: String,
    pub age: String,
}

/// The one place a Pod becomes a row. Shared so the list and the watch cannot drift
/// into describing the same pod differently.
pub(crate) fn pod_row(pod: Pod) -> Option<PodInfo> {
    let name = pod.metadata.name.clone()?;
    let status = pod
        .status
        .as_ref()
        .and_then(|status| status.phase.clone())
        .unwrap_or_else(|| "Unknown".to_string());
    let (ready_count, total_count) = pod
        .status
        .as_ref()
        .and_then(|status| status.container_statuses.as_ref())
        .map(|statuses| (statuses.iter().filter(|container| container.ready).count(), statuses.len()))
        .unwrap_or((0, pod.spec.as_ref().map(|spec| spec.containers.len()).unwrap_or(0)));

    Some(PodInfo {
        name,
        status,
        ready: format!("{ready_count}/{total_count}"),
        age: pod
            .metadata
            .creation_timestamp
            .as_ref()
            .map(|timestamp| format_age(timestamp.0))
            .unwrap_or_else(|| "n/a".to_string()),
    })
}

#[derive(Serialize, Clone)]
struct DeploymentInfo {
    name: String,
    ready: i32,
    desired: i32,
    available: i32,
    age: String,
}

#[derive(Serialize, Clone)]
struct NamespaceSnapshot {
    pods: Vec<PodInfo>,
    deployments: Vec<DeploymentInfo>,
    events: Vec<EventInfo>,
}

#[derive(Serialize, Clone)]
struct CreatedTodayItem {
    kind: String,
    name: String,
    namespace: Option<String>,
    created_at: String,
}

pub(crate) fn format_age(created_at: chrono::DateTime<chrono::Utc>) -> String {
    let seconds = chrono::Utc::now()
        .signed_duration_since(created_at)
        .num_seconds()
        .max(0);

    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3_600 {
        format!("{}m", seconds / 60)
    } else if seconds < 86_400 {
        format!("{}h", seconds / 3_600)
    } else {
        format!("{}d", seconds / 86_400)
    }
}

fn namespace_for_context(config: &kube::config::Kubeconfig, name: &str) -> Option<String> {
    config
        .contexts
        .iter()
        .find(|ctx| ctx.name == name)
        .and_then(|ctx| ctx.context.clone())
        .and_then(|context| context.namespace)
}

/// `force` is only valid on server-side apply. The API server rejects it on a merge
/// patch with HTTP 400, so merge patches carry the field manager and nothing else.
fn merge_patch_params() -> PatchParams {
    PatchParams {
        field_manager: Some("tmjlens".to_string()),
        ..Default::default()
    }
}

async fn client_for_context(context: &str) -> Result<Client, String> {
    let cache = CLIENT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(client) = cache.lock().map_err(|e| e.to_string())?.get(context).cloned() {
        return Ok(client);
    }

    let options = KubeConfigOptions {
        context: Some(context.to_string()),
        ..Default::default()
    };
    let config = Config::from_kubeconfig(&options)
        .await
        .map_err(|error| format!("Unable to load kubeconfig context '{context}': {error}"))?;

    let client = Client::try_from(config).map_err(|error| error.to_string())?;
    cache.lock().map_err(|e| e.to_string())?.insert(context.to_string(), client.clone());
    Ok(client)
}

#[tauri::command]
async fn current_context() -> Result<ContextInfo, String> {
    let kubeconfig = kube::config::Kubeconfig::read().map_err(|e| e.to_string())?;
    let current = kubeconfig
        .current_context
        .clone()
        .unwrap_or_else(|| "default".to_string());

    Ok(ContextInfo {
        name: current.clone(),
        namespace: namespace_for_context(&kubeconfig, &current),
    })
}

#[tauri::command]
async fn list_kube_contexts() -> Result<Vec<KubeContext>, String> {
    let kubeconfig = kube::config::Kubeconfig::read().map_err(|e| e.to_string())?;
    let current = kubeconfig.current_context.clone();

    Ok(kubeconfig
        .contexts
        .into_iter()
        .map(|ctx| {
            let ctx_name = ctx.name.clone();
            let namespace = ctx.context.clone().and_then(|context| context.namespace);
            KubeContext {
                name: ctx_name.clone(),
                current: current.as_deref() == Some(ctx_name.as_str()),
                namespace,
            }
        })
        .collect())
}

#[tauri::command]
async fn list_namespaces(context: String) -> Result<Vec<String>, String> {
    let client = client_for_context(&context).await?;
    let api: Api<Namespace> = Api::all(client);
    let namespaces = api.list(&ListParams::default()).await.map_err(|e| e.to_string())?;

    Ok(namespaces
        .items
        .into_iter()
        .filter_map(|ns| ns.metadata.name)
        .collect())
}

#[tauri::command]
async fn list_pods(context: String, namespace: String) -> Result<Vec<PodInfo>, String> {
    let client = client_for_context(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let pods = api.list(&ListParams::default()).await.map_err(|e| e.to_string())?;
    Ok(pods.items.into_iter().filter_map(pod_row).collect())
}

#[tauri::command]
async fn list_pod_containers(
    context: String,
    namespace: String,
    pod_name: String,
) -> Result<Vec<String>, String> {
    let client = client_for_context(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let pod = api.get(&pod_name).await.map_err(|e| e.to_string())?;

    let containers = pod
        .spec
        .as_ref()
        .map(|spec| {
            spec.containers
                .iter()
                .map(|container| container.name.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(containers)
}

#[tauri::command]
async fn get_pod_logs(
    context: String,
    namespace: String,
    pod_name: String,
    container: Option<String>,
    tail_lines: Option<i64>,
    previous: Option<bool>,
) -> Result<String, String> {
    let client = client_for_context(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let params = LogParams {
        container,
        tail_lines: tail_lines.or(Some(200)),
        previous: previous.unwrap_or(false),
        follow: false,
        ..LogParams::default()
    };

    let logs = api.logs(&pod_name, &params).await.map_err(|e| e.to_string())?;
    if let Some(max_lines) = tail_lines {
        let output = logs.lines().take(max_lines.max(1) as usize).collect::<Vec<_>>();
        Ok(output.join("\n"))
    } else {
        Ok(logs)
    }
}

fn config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .map_err(|error| format!("Unable to locate the configuration folder: {error}"))
}

#[tauri::command]
async fn load_settings(app: tauri::AppHandle) -> Result<settings::AppSettings, String> {
    let directory = config_dir(&app)?;
    tokio::task::spawn_blocking(move || settings::load(&directory))
        .await
        .map_err(|error| format!("Settings task failed: {error}"))
}

#[tauri::command]
async fn save_settings(app: tauri::AppHandle, settings: settings::AppSettings) -> Result<(), String> {
    let directory = config_dir(&app)?;
    tokio::task::spawn_blocking(move || settings::save(&directory, &settings))
        .await
        .map_err(|error| format!("Settings task failed: {error}"))?
}

#[tauri::command]
async fn read_kubeconfig(app: tauri::AppHandle) -> Result<settings::KubeconfigView, String> {
    let directory = config_dir(&app)?;
    tokio::task::spawn_blocking(move || settings::read_view(&settings::load(&directory)))
        .await
        .map_err(|error| format!("Kubeconfig task failed: {error}"))?
}

/// Changing the current context rewrites the file kubectl also reads, so the client
/// cache is dropped afterwards to avoid serving connections built from the old state.
#[tauri::command]
async fn set_current_context(name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || settings::set_current_context(&name))
        .await
        .map_err(|error| format!("Kubeconfig task failed: {error}"))??;
    clear_client_cache();
    Ok(())
}

#[tauri::command]
async fn set_context_namespace(context: String, namespace: Option<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || settings::set_context_namespace(&context, namespace))
        .await
        .map_err(|error| format!("Kubeconfig task failed: {error}"))??;
    clear_client_cache();
    Ok(())
}

fn clear_client_cache() {
    if let Some(cache) = CLIENT_CACHE.get() {
        if let Ok(mut cache) = cache.lock() {
            cache.clear();
        }
    }
}

/// Strips any directory component, so a caller can never escape the target folder.
fn safe_file_stem(name: &str) -> String {
    let stem = std::path::Path::new(name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .trim()
        .trim_matches('.');
    if stem.is_empty() { "logs".to_string() } else { stem.to_string() }
}

/// Writes a text file into the user's Downloads folder and returns the full path.
///
/// The frontend has no filesystem permission at all: it passes a file name, never a
/// path, and this command decides where that lands. The timestamp means exporting
/// the same pod twice never silently overwrites the earlier capture.
#[tauri::command]
async fn save_to_downloads(
    app: tauri::AppHandle,
    file_name: String,
    contents: String,
) -> Result<String, String> {
    use tauri::Manager;

    let directory = app
        .path()
        .download_dir()
        .map_err(|error| format!("Unable to locate the Downloads folder: {error}"))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let target = directory.join(format!("{}-{stamp}.log", safe_file_stem(&file_name)));

    tokio::task::spawn_blocking(move || {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("Unable to create {}: {error}", parent.display()))?;
        }
        std::fs::write(&target, contents).map_err(|error| format!("Unable to write {}: {error}", target.display()))?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| format!("Write task failed: {error}"))?
}

/// Writes a binary file into Downloads. The payload arrives base64-encoded because
/// a raw byte array crosses the IPC boundary as JSON numbers, roughly quadrupling a
/// document that is already hundreds of kilobytes.
#[tauri::command]
async fn save_bytes_to_downloads(
    app: tauri::AppHandle,
    file_name: String,
    extension: String,
    base64_contents: String,
) -> Result<String, String> {
    use base64::Engine;
    use tauri::Manager;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_contents.as_bytes())
        .map_err(|error| format!("The document could not be decoded: {error}"))?;
    let directory = app
        .path()
        .download_dir()
        .map_err(|error| format!("Unable to locate the Downloads folder: {error}"))?;
    let extension = safe_file_stem(&extension);
    let target = directory.join(format!("{}.{extension}", safe_file_stem(&file_name)));

    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("Unable to create {}: {error}", directory.display()))?;
        std::fs::write(&target, bytes).map_err(|error| format!("Unable to write {}: {error}", target.display()))?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| format!("Write task failed: {error}"))?
}

#[tauri::command]
async fn get_deployment_detail(
    context: String,
    namespace: String,
    deployment_name: String,
) -> Result<workloads::DeploymentDetail, String> {
    let client = client_for_context(&context).await?;
    workloads::deployment_detail(client, &namespace, &deployment_name).await
}

/// Returns the Deployment exactly as the API server holds it, for export.
#[tauri::command]
async fn export_deployment_yaml(
    context: String,
    namespace: String,
    deployment_name: String,
) -> Result<String, String> {
    let client = client_for_context(&context).await?;
    workloads::export_raw(client, &workloads::deployment_path(&namespace, &deployment_name)).await
}

/// Deleting a controller through one command rather than one per kind. Foreground
/// propagation is the default so the pods go with it, which is what the operator means.
#[tauri::command]
async fn delete_workload(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<(), String> {
    let client = client_for_context(&context).await?;
    let params = DeleteParams::foreground();

    macro_rules! remove {
        ($type:ty) => {{
            let api: Api<$type> = Api::namespaced(client, &namespace);
            api.delete(&name, &params).await.map_err(|e| e.to_string())?;
        }};
    }

    match kind.as_str() {
        "Deployment" => remove!(Deployment),
        "StatefulSet" => remove!(StatefulSet),
        "DaemonSet" => remove!(DaemonSet),
        "ReplicaSet" => remove!(ReplicaSet),
        "Job" => remove!(Job),
        "CronJob" => remove!(CronJob),
        other => return Err(format!("Deleting a {other} is not implemented")),
    }
    Ok(())
}

/// Opens a shell. The command is chosen here rather than typed by the operator: a free
/// command box would be a generic remote-execution field, which the spec lists as a
/// non-goal. Interactive shells only, and only where `pods/exec` is granted.
#[tauri::command]
async fn start_exec_session(
    app: tauri::AppHandle,
    context: String,
    namespace: String,
    pod_name: String,
    container: Option<String>,
    shell: Option<String>,
    session_id: String,
) -> Result<(), String> {
    let client = client_for_context(&context).await?;
    let chosen = shell.unwrap_or_else(|| exec::SHELL_CANDIDATES[1].to_string());
    if !exec::SHELL_CANDIDATES.contains(&chosen.as_str()) {
        return Err(format!("{chosen} is not one of the shells this app will start."));
    }
    exec::start(app, client, namespace, pod_name, container, vec![chosen], session_id).await
}

#[tauri::command]
async fn write_exec_session(session_id: String, data: String) -> Result<(), String> {
    exec::write(&session_id, &data)
}

#[tauri::command]
async fn stop_exec_session(session_id: String) -> Result<(), String> {
    exec::stop(&session_id);
    Ok(())
}

#[tauri::command]
async fn list_pod_ports(
    context: String,
    namespace: String,
    pod_name: String,
) -> Result<Vec<portforward::PodPort>, String> {
    let client = client_for_context(&context).await?;
    portforward::pod_ports(client, &namespace, &pod_name).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn start_port_forward(
    app: tauri::AppHandle,
    context: String,
    namespace: String,
    pod_name: String,
    remote_port: u16,
    local_port: Option<u16>,
    forward_id: String,
) -> Result<portforward::ActiveForward, String> {
    let client = client_for_context(&context).await?;
    portforward::start(
        app,
        client,
        namespace,
        pod_name,
        remote_port,
        local_port.unwrap_or(0),
        forward_id,
    )
    .await
}

#[tauri::command]
async fn stop_port_forward(forward_id: String) -> Result<(), String> {
    portforward::stop(&forward_id);
    Ok(())
}

#[tauri::command]
async fn list_port_forwards() -> Result<Vec<portforward::ActiveForward>, String> {
    Ok(portforward::list())
}

#[tauri::command]
async fn get_relation_graph(
    context: String,
    namespace: String,
    deployment_name: String,
) -> Result<graph::RelationGraph, String> {
    let client = client_for_context(&context).await?;
    graph::for_deployment(client, &namespace, &deployment_name).await
}

#[tauri::command]
async fn search_cluster(context: String, query: String) -> Result<search::SearchResults, String> {
    let client = client_for_context(&context).await?;
    search::search(client, &query).await
}

#[tauri::command]
async fn list_workloads(context: String, namespace: String) -> Result<workload_list::WorkloadInventory, String> {
    let client = client_for_context(&context).await?;
    workload_list::collect(client, &namespace).await
}

#[tauri::command]
async fn get_network_overview(context: String, namespace: String) -> Result<network::NetworkOverview, String> {
    let client = client_for_context(&context).await?;
    network::collect(client, &namespace).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn start_log_stream(
    app: tauri::AppHandle,
    context: String,
    namespace: String,
    pod_name: String,
    container: Option<String>,
    tail_lines: Option<i64>,
    timestamps: Option<bool>,
    previous: Option<bool>,
    stream_id: String,
) -> Result<(), String> {
    let client = client_for_context(&context).await?;
    logs::start(
        app,
        client,
        namespace,
        pod_name,
        container,
        tail_lines,
        timestamps.unwrap_or(false),
        previous.unwrap_or(false),
        stream_id,
    )
    .await
}

#[tauri::command]
async fn start_pod_watch(
    app: tauri::AppHandle,
    context: String,
    namespace: String,
    watch_id: String,
) -> Result<(), String> {
    let client = client_for_context(&context).await?;
    watch::start_pods(app, client, namespace, watch_id).await
}

#[tauri::command]
async fn stop_pod_watch(watch_id: String) -> Result<(), String> {
    watch::stop(&watch_id);
    Ok(())
}

#[tauri::command]
async fn stop_log_stream(stream_id: String) -> Result<(), String> {
    logs::stop(&stream_id);
    Ok(())
}

#[tauri::command]
async fn delete_pod(context: String, namespace: String, pod_name: String) -> Result<(), String> {
    let client = client_for_context(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    api.delete(&pod_name, &DeleteParams::default()).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn get_resource_yaml(
    context: String,
    namespace: String,
    resource_kind: String,
    resource_name: String,
) -> Result<String, String> {
    let client = client_for_context(&context).await?;
    let yaml = match resource_kind.as_str() {
        "Pod" => {
            let api: Api<Pod> = Api::namespaced(client, &namespace);
            serde_yaml::to_string(&api.get(&resource_name).await.map_err(|e| e.to_string())?)
        }
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client, &namespace);
            serde_yaml::to_string(&api.get(&resource_name).await.map_err(|e| e.to_string())?)
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client, &namespace);
            serde_yaml::to_string(&api.get(&resource_name).await.map_err(|e| e.to_string())?)
        }
        "DaemonSet" => {
            let api: Api<DaemonSet> = Api::namespaced(client, &namespace);
            serde_yaml::to_string(&api.get(&resource_name).await.map_err(|e| e.to_string())?)
        }
        "ReplicaSet" => {
            let api: Api<ReplicaSet> = Api::namespaced(client, &namespace);
            serde_yaml::to_string(&api.get(&resource_name).await.map_err(|e| e.to_string())?)
        }
        "Job" => {
            let api: Api<Job> = Api::namespaced(client, &namespace);
            serde_yaml::to_string(&api.get(&resource_name).await.map_err(|e| e.to_string())?)
        }
        "CronJob" => {
            let api: Api<CronJob> = Api::namespaced(client, &namespace);
            serde_yaml::to_string(&api.get(&resource_name).await.map_err(|e| e.to_string())?)
        }
        "Service" => {
            let api: Api<Service> = Api::namespaced(client, &namespace);
            serde_yaml::to_string(&api.get(&resource_name).await.map_err(|e| e.to_string())?)
        }
        "Ingress" => {
            let api: Api<Ingress> = Api::namespaced(client, &namespace);
            serde_yaml::to_string(&api.get(&resource_name).await.map_err(|e| e.to_string())?)
        }
        _ => return Err(format!("YAML view is not implemented for {resource_kind}")),
    };

    yaml.map_err(|e| e.to_string())
}

#[tauri::command]
/// Saves an edited document back with `replace`, not server-side apply.
///
/// Server-side apply would make tmjLens the field manager of every field in the
/// document, taking ownership away from whatever created the resource — Helm, Argo,
/// Flux — and turning the next reconcile into a fight over drift. `replace` also
/// carries the `resourceVersion` the editor loaded, so a change made by someone else
/// in the meantime is reported as a conflict instead of being silently overwritten.
async fn replace_from_yaml<K>(api: Api<K>, name: &str, yaml: &str) -> Result<String, String>
where
    K: Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned
        + Serialize
        + kube::Resource<DynamicType = ()>,
{
    let object: K = serde_yaml::from_str(yaml)
        .map_err(|error| format!("This is not a valid {} document: {error}", K::kind(&())))?;

    let updated = api
        .replace(name, &kube::api::PostParams::default(), &object)
        .await
        .map_err(|error| match &error {
            kube::Error::Api(response) if response.code == 409 => format!(
                "{name} changed in the cluster since it was loaded, so the edit was not applied. \
                 Reload it, reapply the change, and save again.\n\n{}",
                response.message
            ),
            kube::Error::Api(response) if response.code == 422 => {
                format!("Kubernetes rejected the document: {}", response.message)
            }
            _ => error.to_string(),
        })?;

    serde_yaml::to_string(&updated).map_err(|error| error.to_string())
}

#[tauri::command]
async fn apply_resource_yaml(
    context: String,
    namespace: String,
    resource_kind: String,
    resource_name: String,
    yaml: String,
) -> Result<String, String> {
    let client = client_for_context(&context).await?;

    match resource_kind.as_str() {
        "Pod" => replace_from_yaml(Api::<Pod>::namespaced(client, &namespace), &resource_name, &yaml).await,
        "Deployment" => {
            replace_from_yaml(Api::<Deployment>::namespaced(client, &namespace), &resource_name, &yaml).await
        }
        "StatefulSet" => {
            replace_from_yaml(Api::<StatefulSet>::namespaced(client, &namespace), &resource_name, &yaml).await
        }
        "DaemonSet" => {
            replace_from_yaml(Api::<DaemonSet>::namespaced(client, &namespace), &resource_name, &yaml).await
        }
        "ReplicaSet" => {
            replace_from_yaml(Api::<ReplicaSet>::namespaced(client, &namespace), &resource_name, &yaml).await
        }
        "Job" => replace_from_yaml(Api::<Job>::namespaced(client, &namespace), &resource_name, &yaml).await,
        "CronJob" => replace_from_yaml(Api::<CronJob>::namespaced(client, &namespace), &resource_name, &yaml).await,
        "Service" => {
            replace_from_yaml(Api::<Service>::namespaced(client, &namespace), &resource_name, &yaml).await
        }
        "Ingress" => {
            replace_from_yaml(Api::<Ingress>::namespaced(client, &namespace), &resource_name, &yaml).await
        }
        _ => Err(format!("YAML editing is not implemented for {resource_kind}")),
    }
}

#[tauri::command]
async fn check_permission(
    context: String,
    namespace: String,
    verb: String,
    resource: String,
    subresource: Option<String>,
) -> Result<bool, String> {
    let client = client_for_context(&context).await?;
    let api: Api<SelfSubjectAccessReview> = Api::all(client);
    let review = SelfSubjectAccessReview {
        spec: SelfSubjectAccessReviewSpec {
            resource_attributes: Some(ResourceAttributes {
                namespace: Some(namespace),
                resource: Some(resource),
                subresource,
                verb: Some(verb),
                version: Some("v1".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    let result = api.create(&kube::api::PostParams::default(), &review).await.map_err(|e| e.to_string())?;
    Ok(result.status.map(|status| status.allowed).unwrap_or(false))
}

#[tauri::command]
async fn list_deployments(context: String, namespace: String) -> Result<Vec<DeploymentInfo>, String> {
    let client = client_for_context(&context).await?;
    let api: Api<Deployment> = Api::namespaced(client, &namespace);
    let deployments = api.list(&ListParams::default()).await.map_err(|e| e.to_string())?;

    Ok(deployments.items.into_iter().filter_map(|deployment| {
        let name = deployment.metadata.name?;
        let spec = deployment.spec.as_ref();
        let status = deployment.status.as_ref();
        Some(DeploymentInfo {
            name,
            ready: status.and_then(|value| value.ready_replicas).unwrap_or(0),
            desired: spec.and_then(|value| value.replicas).unwrap_or(0),
            available: status.and_then(|value| value.available_replicas).unwrap_or(0),
            age: deployment.metadata.creation_timestamp.map(|timestamp| format_age(timestamp.0)).unwrap_or_else(|| "n/a".to_string()),
        })
    }).collect())
}

#[tauri::command]
async fn list_namespace_snapshot(context: String, namespace: String) -> Result<NamespaceSnapshot, String> {
    let client = client_for_context(&context).await?;
    let pods_api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let deployments_api: Api<Deployment> = Api::namespaced(client.clone(), &namespace);
    let events_api: Api<Event> = Api::namespaced(client, &namespace);
    let params = ListParams::default();
    let (pods, deployments, events) = tokio::try_join!(
        pods_api.list(&params),
        deployments_api.list(&params),
        events_api.list(&params),
    ).map_err(|e| e.to_string())?;

    let pod_infos = pods.items.into_iter().filter_map(|pod| {
        let name = pod.metadata.name?;
        let status = pod.status.as_ref().and_then(|value| value.phase.clone()).unwrap_or_else(|| "Unknown".to_string());
        let (ready, total) = pod.status.as_ref().and_then(|value| value.container_statuses.as_ref())
            .map(|values| (values.iter().filter(|container| container.ready).count(), values.len()))
            .unwrap_or((0, pod.spec.as_ref().map(|value| value.containers.len()).unwrap_or(0)));
        Some(PodInfo { name, status, ready: format!("{ready}/{total}"), age: pod.metadata.creation_timestamp.map(|value| format_age(value.0)).unwrap_or_else(|| "n/a".to_string()) })
    }).collect();

    let deployment_infos = deployments.items.into_iter().filter_map(|deployment| {
        let name = deployment.metadata.name?;
        let spec = deployment.spec.as_ref();
        let status = deployment.status.as_ref();
        Some(DeploymentInfo {
            name,
            ready: status.and_then(|value| value.ready_replicas).unwrap_or(0),
            desired: spec.and_then(|value| value.replicas).unwrap_or(0),
            available: status.and_then(|value| value.available_replicas).unwrap_or(0),
            age: deployment.metadata.creation_timestamp.map(|value| format_age(value.0)).unwrap_or_else(|| "n/a".to_string()),
        })
    }).collect();

    let event_infos = events.items.into_iter().filter_map(|event| {
        let name = event.involved_object.name.clone().or(event.metadata.name)?;
        Some(EventInfo {
            reason: event.reason.unwrap_or_else(|| "Unknown".to_string()),
            message: event.message.unwrap_or_else(|| "No details".to_string()),
            kind: event.involved_object.kind.unwrap_or_else(|| "Unknown".to_string()),
            name,
            timestamp: event.last_timestamp.map(|value| value.0.to_rfc3339()).or_else(|| event.event_time.map(|value| value.0.to_rfc3339())),
        })
    }).collect();

    Ok(NamespaceSnapshot { pods: pod_infos, deployments: deployment_infos, events: event_infos })
}

#[tauri::command]
async fn list_created_today(context: String) -> Result<Vec<CreatedTodayItem>, String> {
    let client = client_for_context(&context).await?;
    let pods_api: Api<Pod> = Api::all(client.clone());
    let deployments_api: Api<Deployment> = Api::all(client.clone());
    let events_api: Api<Event> = Api::all(client.clone());
    let namespaces_api: Api<Namespace> = Api::all(client);
    let today = chrono::Local::now().date_naive();
    let params = ListParams::default();
    let (pods, deployments, events, namespaces) = tokio::join!(
        pods_api.list(&params),
        deployments_api.list(&params),
        events_api.list(&params),
        namespaces_api.list(&params),
    );
    let mut items = Vec::new();

    if let Ok(list) = pods {
        for pod in list.items {
            if let (Some(name), Some(created_at)) = (pod.metadata.name, pod.metadata.creation_timestamp) {
                if created_at.0.with_timezone(&chrono::Local).date_naive() == today {
                    items.push(CreatedTodayItem { kind: "Pod".to_string(), name, namespace: pod.metadata.namespace, created_at: created_at.0.to_rfc3339() });
                }
            }
        }
    }
    if let Ok(list) = deployments {
        for deployment in list.items {
            if let (Some(name), Some(created_at)) = (deployment.metadata.name, deployment.metadata.creation_timestamp) {
                if created_at.0.with_timezone(&chrono::Local).date_naive() == today {
                    items.push(CreatedTodayItem { kind: "Deployment".to_string(), name, namespace: deployment.metadata.namespace, created_at: created_at.0.to_rfc3339() });
                }
            }
        }
    }
    if let Ok(list) = events {
        for event in list.items {
            if let (Some(name), Some(created_at)) = (event.involved_object.name.or(event.metadata.name), event.metadata.creation_timestamp) {
                if created_at.0.with_timezone(&chrono::Local).date_naive() == today {
                    items.push(CreatedTodayItem { kind: "Event".to_string(), name, namespace: event.metadata.namespace, created_at: created_at.0.to_rfc3339() });
                }
            }
        }
    }
    if let Ok(list) = namespaces {
        for namespace in list.items {
            if let (Some(name), Some(created_at)) = (namespace.metadata.name, namespace.metadata.creation_timestamp) {
                if created_at.0.with_timezone(&chrono::Local).date_naive() == today {
                    items.push(CreatedTodayItem { kind: "Namespace".to_string(), name, namespace: None, created_at: created_at.0.to_rfc3339() });
                }
            }
        }
    }

    items.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(items)
}

#[tauri::command]
async fn get_cluster_overview(context: String) -> Result<cluster::ClusterOverview, String> {
    let options = KubeConfigOptions { context: Some(context.clone()), ..Default::default() };
    let config = Config::from_kubeconfig(&options).await.map_err(|e| e.to_string())?;
    let endpoint = config.cluster_url.to_string();
    let client = client_for_context(&context).await?;
    let mut overview = cluster::collect(&context, endpoint, client).await?;

    // Provider-specific enrichment is optional: the overview is already complete
    // without it, and it only runs for a provider that has an adapter.
    if overview.control_plane.provider == "eks" {
        if let Some((region, _account, name)) = cluster::parse_cluster_arn(&context) {
            if let Some((oidc_issuer, status, platform_version)) = describe_eks_cluster(region, name).await {
                overview.control_plane.oidc_issuer = oidc_issuer;
                overview.control_plane.provider_status = status;
                overview.control_plane.provider_version = platform_version;
            }
        }
    }

    Ok(overview)
}

#[tauri::command]
async fn set_node_schedulable(context: String, node_name: String, schedulable: bool) -> Result<(), String> {
    let client = client_for_context(&context).await?;
    let api: Api<Node> = Api::all(client);
    let patch = Patch::Merge(json!({ "spec": { "unschedulable": !schedulable } }));
    api.patch(&node_name, &merge_patch_params(), &patch).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn delete_node(context: String, node_name: String) -> Result<(), String> {
    let client = client_for_context(&context).await?;
    let api: Api<Node> = Api::all(client);
    api.delete(&node_name, &DeleteParams::default()).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// `kubectl drain` blocks for minutes, so it must never run on a runtime worker thread.
#[tauri::command]
async fn drain_node(context: String, node_name: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("kubectl")
            .args(["--context", &context, "drain", &node_name, "--ignore-daemonsets", "--delete-emptydir-data", "--force", "--grace-period=30", "--timeout=5m"])
            .output()
            .map_err(|e| format!("Unable to start kubectl drain: {e}"))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    })
    .await
    .map_err(|error| format!("kubectl drain task failed: {error}"))?
}

async fn describe_eks_cluster(
    region: String,
    cluster: String,
) -> Option<(Option<String>, Option<String>, Option<String>)> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("aws")
            .args(["eks", "describe-cluster", "--name", &cluster, "--region", &region, "--output", "json"])
            .output()
            .ok()
            .filter(|output| output.status.success())?;
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
        Some((
            value.pointer("/cluster/identity/oidc/issuer").and_then(|value| value.as_str()).map(str::to_string),
            value.pointer("/cluster/status").and_then(|value| value.as_str()).map(str::to_string),
            value.pointer("/cluster/platformVersion").and_then(|value| value.as_str()).map(str::to_string),
        ))
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn delete_deployment(
    context: String,
    namespace: String,
    deployment_name: String,
) -> Result<(), String> {
    let client = client_for_context(&context).await?;
    let api: Api<Deployment> = Api::namespaced(client, &namespace);
    api.delete(&deployment_name, &DeleteParams::default()).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn scale_deployment(
    context: String,
    namespace: String,
    deployment_name: String,
    replicas: i32,
) -> Result<(), String> {
    if !(0..=1000).contains(&replicas) {
        return Err("Replica count must be between 0 and 1000".to_string());
    }

    let client = client_for_context(&context).await?;
    let api: Api<Deployment> = Api::namespaced(client, &namespace);
    let patch = Patch::Merge(json!({"spec": {"replicas": replicas}}));
    api.patch(&deployment_name, &merge_patch_params(), &patch).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn restart_deployment(
    context: String,
    namespace: String,
    deployment_name: String,
) -> Result<(), String> {
    let client = client_for_context(&context).await?;
    let api: Api<Deployment> = Api::namespaced(client, &namespace);
    let restarted_at = chrono::Utc::now().to_rfc3339();
    let patch = Patch::Merge(json!({
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "kubectl.kubernetes.io/restartedAt": restarted_at
                    }
                }
            }
        }
    }));

    api.patch(&deployment_name, &merge_patch_params(), &patch).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn list_events(context: String, namespace: String) -> Result<Vec<EventInfo>, String> {
    let client = client_for_context(&context).await?;
    let api: Api<Event> = Api::namespaced(client, &namespace);
    let events = api.list(&ListParams::default()).await.map_err(|e| e.to_string())?;

    Ok(events
        .items
        .into_iter()
        .filter_map(|event| {
            let reason = event.reason.unwrap_or_else(|| "Unknown".to_string());
            let message = event.message.unwrap_or_else(|| "No details".to_string());
            let name = event.involved_object.name.clone().or(event.metadata.name)?;
            let timestamp = event
                .last_timestamp
                .map(|time| time.0.to_rfc3339())
                .or_else(|| event.event_time.map(|time| time.0.to_rfc3339()));
            Some(EventInfo {
                reason,
                message,
                kind: event.involved_object.kind.unwrap_or_else(|| "Unknown".to_string()),
                name,
                timestamp,
            })
        })
        .collect())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            save_to_downloads,
            save_bytes_to_downloads,
            load_settings,
            save_settings,
            read_kubeconfig,
            set_current_context,
            set_context_namespace,
            current_context,
            list_kube_contexts,
            list_namespaces,
            list_pods,
            list_pod_containers,
            get_pod_logs,
            start_log_stream,
            stop_log_stream,
            start_pod_watch,
            stop_pod_watch,
            delete_pod,
            get_resource_yaml,
            apply_resource_yaml,
            check_permission,
            list_deployments,
            get_deployment_detail,
            get_network_overview,
            list_workloads,
            search_cluster,
            get_relation_graph,
            start_exec_session,
            write_exec_session,
            stop_exec_session,
            list_pod_ports,
            start_port_forward,
            stop_port_forward,
            list_port_forwards,
            delete_workload,
            export_deployment_yaml,
            list_namespace_snapshot,
            list_created_today,
            get_cluster_overview,
            set_node_schedulable,
            delete_node,
            drain_node,
            delete_deployment,
            scale_deployment,
            restart_deployment,
            list_events
        ])
        .build(tauri::generate_context!())
        .expect("error while building tmjLens")
        .run(|_app, event| {
            // Closing the window must end every stream; a follow left running would
            // keep the API server writing output into a process that is going away.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                logs::stop_all();
                watch::stop_all();
                portforward::stop_all();
                exec::stop_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{format_age, namespace_for_context};
    use chrono::{Duration, Utc};
    use kube::config::Kubeconfig;

    #[test]
    fn extracts_namespace_from_current_context() {
        let kubeconfig = Kubeconfig::from_yaml(
            r#"
apiVersion: v1
kind: Config
clusters:
- name: prod
  cluster:
    server: https://prod.example.com
contexts:
- name: prod-admin
  context:
    cluster: prod
    user: prod-user
    namespace: payments
current-context: prod-admin
users:
- name: prod-user
  user:
    token: token-value
"#,
        )
        .expect("valid kubeconfig");

        assert_eq!(namespace_for_context(&kubeconfig, "prod-admin"), Some("payments".to_string()));
    }

    #[test]
    fn strips_directory_components_from_a_save_name() {
        use super::safe_file_stem;
        assert_eq!(safe_file_stem("checkout-api-abc123-logs"), "checkout-api-abc123-logs");
        assert_eq!(safe_file_stem("../../../etc/passwd"), "passwd");
        assert_eq!(safe_file_stem("C:\\Windows\\System32\\config"), "config");
        assert_eq!(safe_file_stem(""), "logs");
        assert_eq!(safe_file_stem("   "), "logs");
        assert_eq!(safe_file_stem(".."), "logs");
    }

    #[test]
    fn formats_age_from_creation_timestamp() {
        assert_eq!(format_age(Utc::now() - Duration::seconds(12)), "12s");
        assert_eq!(format_age(Utc::now() - Duration::minutes(5)), "5m");
    }
}
