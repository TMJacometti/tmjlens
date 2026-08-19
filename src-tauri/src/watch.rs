use futures::StreamExt;
use k8s_openapi::api::core::v1::Pod;
use kube::runtime::watcher::{watcher, Config, Event};
use kube::{Api, Client};
use serde::Serialize;
use tauri::Emitter;

use crate::streams::StreamRegistry;
use crate::{pod_row, PodInfo};

static WATCHES: StreamRegistry = StreamRegistry::new();

#[derive(Serialize, Clone)]
#[serde(tag = "change", rename_all = "camelCase")]
pub enum PodChange {
    /// The full set at the moment the watch established itself. The frontend replaces
    /// its list with this rather than merging, so a restarted watch cannot leave
    /// behind rows for pods that disappeared while it was down.
    Reset { pods: Vec<PodInfo> },
    Applied { pod: PodInfo },
    Deleted { name: String },
}

#[derive(Serialize, Clone)]
pub struct PodWatchEvent {
    pub watch_id: String,
    #[serde(flatten)]
    pub change: PodChange,
}

#[derive(Serialize, Clone)]
pub struct WatchClosed {
    pub watch_id: String,
    pub error: Option<String>,
}

pub fn stop(watch_id: &str) {
    WATCHES.stop(watch_id);
}

pub fn stop_all() {
    WATCHES.stop_all();
}

/// Follows pods in a namespace, emitting each change as it happens.
///
/// `watcher` handles the parts that make a naive watch wrong: it lists first to get a
/// consistent starting point, resumes from the resourceVersion, and relists when the
/// server expires it. A dropped connection therefore recovers on its own instead of
/// leaving the list quietly frozen — which is worse than polling, because it looks live.
pub async fn start_pods(
    app: tauri::AppHandle,
    client: Client,
    namespace: String,
    watch_id: String,
) -> Result<(), String> {
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let id = watch_id.clone();

    let task = tokio::spawn(async move {
        let mut stream = watcher(api, Config::default()).boxed();
        // `watcher` reports a relist as InitApply items bracketed by Init/InitDone.
        let mut initial: Vec<PodInfo> = Vec::new();

        let error = loop {
            match stream.next().await {
                Some(Ok(Event::Init)) => initial.clear(),
                Some(Ok(Event::InitApply(pod))) => {
                    if let Some(row) = pod_row(pod) {
                        initial.push(row);
                    }
                }
                Some(Ok(Event::InitDone)) => {
                    let _ = app.emit(
                        "pod-watch",
                        PodWatchEvent {
                            watch_id: id.clone(),
                            change: PodChange::Reset { pods: std::mem::take(&mut initial) },
                        },
                    );
                }
                Some(Ok(Event::Apply(pod))) => {
                    if let Some(row) = pod_row(pod) {
                        let _ = app.emit(
                            "pod-watch",
                            PodWatchEvent { watch_id: id.clone(), change: PodChange::Applied { pod: row } },
                        );
                    }
                }
                Some(Ok(Event::Delete(pod))) => {
                    if let Some(name) = pod.metadata.name.clone() {
                        let _ = app.emit(
                            "pod-watch",
                            PodWatchEvent { watch_id: id.clone(), change: PodChange::Deleted { name } },
                        );
                    }
                }
                Some(Err(error)) => break Some(error.to_string()),
                None => break None,
            }
        };

        let _ = app.emit("pod-watch-closed", WatchClosed { watch_id: id.clone(), error });
        WATCHES.forget(&id);
    });

    WATCHES.insert(&watch_id, task.abort_handle());
    Ok(())
}
