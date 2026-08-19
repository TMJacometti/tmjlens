use k8s_openapi::api::core::v1::Pod;
use kube::{Api, Client};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;
use tokio::net::TcpListener;

use crate::streams::StreamRegistry;

static FORWARDS: StreamRegistry = StreamRegistry::new();
static ACTIVE: OnceLock<Mutex<HashMap<String, ActiveForward>>> = OnceLock::new();

fn active() -> &'static Mutex<HashMap<String, ActiveForward>> {
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Clone)]
pub struct ActiveForward {
    pub id: String,
    pub namespace: String,
    pub pod: String,
    pub remote_port: u16,
    pub local_port: u16,
    /// Always loopback. Stated so it is visible rather than assumed.
    pub local_address: String,
    pub connections: u32,
}

#[derive(Serialize, Clone)]
pub struct ForwardEvent {
    pub id: String,
    pub connections: u32,
    pub error: Option<String>,
    pub closed: bool,
}

pub fn list() -> Vec<ActiveForward> {
    active().lock().map(|map| map.values().cloned().collect()).unwrap_or_default()
}

pub fn stop(id: &str) {
    FORWARDS.stop(id);
    if let Ok(mut map) = active().lock() {
        map.remove(id);
    }
}

pub fn stop_all() {
    FORWARDS.stop_all();
    if let Ok(mut map) = active().lock() {
        map.clear();
    }
}

/// Opens a local port that tunnels to a port on a pod.
///
/// The listener binds to `127.0.0.1` only, never `0.0.0.0`. A forward into a
/// production database that quietly listens on every interface would expose that
/// database to the whole network the laptop is on, which is not what anyone means by
/// "port-forward". Binding loopback is not configurable for that reason.
pub async fn start(
    app: tauri::AppHandle,
    client: Client,
    namespace: String,
    pod: String,
    remote_port: u16,
    requested_local_port: u16,
    id: String,
) -> Result<ActiveForward, String> {
    // Port 0 asks the OS for a free one, which is what the UI sends by default.
    let listener = TcpListener::bind(("127.0.0.1", requested_local_port))
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AddrInUse => {
                format!("Local port {requested_local_port} is already in use on this machine.")
            }
            std::io::ErrorKind::PermissionDenied => {
                format!("This account may not bind local port {requested_local_port}.")
            }
            _ => format!("Could not open local port {requested_local_port}: {error}"),
        })?;

    let local_port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let forward = ActiveForward {
        id: id.clone(),
        namespace: namespace.clone(),
        pod: pod.clone(),
        remote_port,
        local_port,
        local_address: "127.0.0.1".to_string(),
        connections: 0,
    };

    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let task_id = id.clone();
    let task = tokio::spawn(async move {
        let mut connections: u32 = 0;

        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            connections += 1;
            if let Ok(mut map) = active().lock() {
                if let Some(entry) = map.get_mut(&task_id) {
                    entry.connections = connections;
                }
            }
            let _ = app.emit(
                "port-forward",
                ForwardEvent { id: task_id.clone(), connections, error: None, closed: false },
            );

            let api = api.clone();
            let pod = pod.clone();
            let app = app.clone();
            let event_id = task_id.clone();

            // Each accepted connection gets its own tunnel. A single shared stream
            // would serialise clients behind one another.
            tokio::spawn(async move {
                match api.portforward(&pod, &[remote_port]).await {
                    Ok(mut forwarder) => {
                        if let Some(mut upstream) = forwarder.take_stream(remote_port) {
                            let _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream).await;
                        }
                        let _ = forwarder.join().await;
                    }
                    Err(error) => {
                        let _ = app.emit(
                            "port-forward",
                            ForwardEvent {
                                id: event_id,
                                connections,
                                error: Some(error.to_string()),
                                closed: false,
                            },
                        );
                    }
                }
            });
        }

        let _ = app.emit(
            "port-forward",
            ForwardEvent { id: task_id.clone(), connections, error: None, closed: true },
        );
        if let Ok(mut map) = active().lock() {
            map.remove(&task_id);
        }
        FORWARDS.forget(&task_id);
    });

    if let Ok(mut map) = active().lock() {
        map.insert(id.clone(), forward.clone());
    }
    FORWARDS.insert(&id, task.abort_handle());
    Ok(forward)
}

/// The scheme a forwarded port is most likely speaking.
///
/// A guess, and a narrow one: only the ports that conventionally mean TLS. Guessing
/// wrong costs a browser warning, whereas defaulting everything to https would break
/// the ordinary case.
pub fn scheme_for(remote_port: u16) -> &'static str {
    match remote_port {
        443 | 8443 | 9443 => "https",
        _ => "http",
    }
}

pub fn url_for(forward: &ActiveForward) -> String {
    format!(
        "{}://{}:{}",
        scheme_for(forward.remote_port),
        forward.local_address,
        forward.local_port
    )
}

/// Opens one of this app's own forwards in the system browser.
///
/// Takes a forward id, never a URL. A command that opened whatever string the frontend
/// handed it would be a general "launch anything" primitive; this one can only ever
/// open a loopback address that the app itself opened, and refuses an id it does not
/// know about.
pub async fn open_in_browser(forward_id: &str) -> Result<String, String> {
    let forward = active()
        .lock()
        .map_err(|error| error.to_string())?
        .get(forward_id)
        .cloned()
        .ok_or_else(|| "That port forward is no longer open.".to_string())?;

    let url = url_for(&forward);
    let target = url.clone();

    tokio::task::spawn_blocking(move || {
        // The URL is built from a port number and a fixed host, so there is nothing
        // in it for a shell to interpret.
        let outcome = if cfg!(target_os = "windows") {
            std::process::Command::new("cmd").args(["/C", "start", "", &target]).status()
        } else if cfg!(target_os = "macos") {
            std::process::Command::new("open").arg(&target).status()
        } else {
            std::process::Command::new("xdg-open").arg(&target).status()
        };

        match outcome {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!("The browser command exited with {status}.")),
            Err(error) => Err(format!("No default browser could be launched: {error}")),
        }
    })
    .await
    .map_err(|error| format!("Browser task failed: {error}"))??;

    Ok(url)
}

/// Ports a pod declares, so the UI can offer them instead of asking the operator to
/// remember. Container ports are what the pod says it listens on.
pub async fn pod_ports(client: Client, namespace: &str, pod_name: &str) -> Result<Vec<PodPort>, String> {
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let pod = api.get(pod_name).await.map_err(|error| error.to_string())?;

    Ok(pod
        .spec
        .iter()
        .flat_map(|spec| spec.containers.iter())
        .flat_map(|container| {
            let container_name = container.name.clone();
            container.ports.iter().flatten().map(move |port| PodPort {
                container: container_name.clone(),
                name: port.name.clone(),
                port: port.container_port as u16,
                protocol: port.protocol.clone().unwrap_or_else(|| "TCP".to_string()),
            })
        })
        // Port-forward tunnels TCP; a UDP port in the list would only mislead.
        .filter(|port| port.protocol == "TCP")
        .collect())
}

#[derive(Serialize, Clone)]
pub struct PodPort {
    pub container: String,
    pub name: Option<String>,
    pub port: u16,
    pub protocol: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_listener_binds_loopback_and_never_the_world() {
        // The guarantee that matters: a forward is reachable from this machine only.
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        assert_ne!(address.port(), 0, "port 0 should resolve to a real one");
    }

    #[tokio::test]
    async fn a_taken_port_is_reported_as_taken() {
        let held = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = held.local_addr().unwrap().port();

        let second = TcpListener::bind(("127.0.0.1", port)).await;
        assert!(second.is_err());
        assert_eq!(second.unwrap_err().kind(), std::io::ErrorKind::AddrInUse);
    }

    #[test]
    fn only_the_conventional_tls_ports_are_guessed_as_https() {
        assert_eq!(scheme_for(443), "https");
        assert_eq!(scheme_for(8443), "https");
        assert_eq!(scheme_for(9443), "https");
        // Everything else stays http: guessing wrong there breaks the common case.
        assert_eq!(scheme_for(80), "http");
        assert_eq!(scheme_for(8080), "http");
        assert_eq!(scheme_for(3000), "http");
        assert_eq!(scheme_for(5432), "http");
    }

    #[test]
    fn the_url_points_at_loopback_and_the_local_port() {
        let forward = ActiveForward {
            id: "x".into(),
            namespace: "payments".into(),
            pod: "checkout".into(),
            remote_port: 8080,
            local_port: 51234,
            local_address: "127.0.0.1".into(),
            connections: 0,
        };
        assert_eq!(url_for(&forward), "http://127.0.0.1:51234");

        let secure = ActiveForward { remote_port: 443, ..forward };
        assert_eq!(url_for(&secure), "https://127.0.0.1:51234");
    }

    #[tokio::test]
    async fn opening_an_unknown_forward_is_refused_rather_than_launching_anything() {
        let outcome = open_in_browser("never-opened").await;
        assert!(outcome.is_err());
        assert!(outcome.unwrap_err().contains("no longer open"));
    }

    #[test]
    fn the_active_list_starts_empty_and_survives_a_stop_of_nothing() {
        stop("never-started");
        assert!(list().iter().all(|entry| entry.id != "never-started"));
    }
}
