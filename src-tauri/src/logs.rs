use futures::{AsyncBufReadExt, TryStreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::{api::LogParams, Api, Client};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;
use tokio::task::AbortHandle;

/// Live streams, keyed by the id the frontend generated for the viewer that owns them.
/// A stream that is not in here is not running, and one that is can always be stopped.
static STREAMS: OnceLock<Mutex<HashMap<String, AbortHandle>>> = OnceLock::new();

/// Lines are emitted in batches rather than one event per line: a chatty pod can
/// produce thousands a second, and one IPC round trip each would starve the UI thread.
const BATCH_LINES: usize = 200;
const BATCH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(120);

#[derive(Serialize, Clone)]
pub struct LogBatch {
    pub stream_id: String,
    pub lines: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct LogClosed {
    pub stream_id: String,
    /// Absent when the stream ended on its own — the container exited, or the pod went away.
    pub error: Option<String>,
}

fn registry() -> &'static Mutex<HashMap<String, AbortHandle>> {
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Stops a stream and forgets it. Safe to call for an id that is already gone, which
/// is what makes it usable from a component teardown that may run more than once.
pub fn stop(stream_id: &str) {
    if let Ok(mut streams) = registry().lock() {
        if let Some(handle) = streams.remove(stream_id) {
            handle.abort();
        }
    }
}

pub fn stop_all() {
    if let Ok(mut streams) = registry().lock() {
        for (_, handle) in streams.drain() {
            handle.abort();
        }
    }
}

pub fn active_count() -> usize {
    registry().lock().map(|streams| streams.len()).unwrap_or(0)
}

#[allow(clippy::too_many_arguments)]
pub async fn start(
    app: tauri::AppHandle,
    client: Client,
    namespace: String,
    pod_name: String,
    container: Option<String>,
    tail_lines: Option<i64>,
    timestamps: bool,
    previous: bool,
    stream_id: String,
) -> Result<(), String> {
    // Replacing a viewer's stream must never leave the old one running.
    stop(&stream_id);

    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let params = LogParams {
        container,
        follow: true,
        tail_lines,
        timestamps,
        previous,
        ..LogParams::default()
    };

    let reader = api
        .log_stream(&pod_name, &params)
        .await
        .map_err(|error| error.to_string())?
        .lines();

    let id = stream_id.clone();
    let task = tokio::spawn(async move {
        let mut reader = reader;
        let mut batch: Vec<String> = Vec::with_capacity(BATCH_LINES);
        let mut last_flush = std::time::Instant::now();

        let flush = |app: &tauri::AppHandle, batch: &mut Vec<String>, id: &str| {
            if batch.is_empty() {
                return;
            }
            let _ = app.emit(
                "pod-log",
                LogBatch { stream_id: id.to_string(), lines: std::mem::take(batch) },
            );
        };

        let error = loop {
            match reader.try_next().await {
                Ok(Some(line)) => {
                    batch.push(line);
                    if batch.len() >= BATCH_LINES || last_flush.elapsed() >= BATCH_INTERVAL {
                        flush(&app, &mut batch, &id);
                        last_flush = std::time::Instant::now();
                    }
                }
                // The container exited or the API server closed the connection.
                Ok(None) => break None,
                Err(error) => break Some(error.to_string()),
            }
        };

        flush(&app, &mut batch, &id);
        let _ = app.emit("pod-log-closed", LogClosed { stream_id: id.clone(), error });

        if let Ok(mut streams) = registry().lock() {
            streams.remove(&id);
        }
    });

    if let Ok(mut streams) = registry().lock() {
        streams.insert(stream_id, task.abort_handle());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stopping_an_unknown_stream_is_harmless() {
        // Component teardown can fire more than once; a second stop must not panic.
        stop("never-started");
        stop("never-started");
        assert_eq!(active_count(), 0);
    }

    #[tokio::test]
    async fn registered_streams_are_counted_and_cleared() {
        let task = tokio::spawn(async { std::future::pending::<()>().await });
        registry().lock().unwrap().insert("one".into(), task.abort_handle());
        assert_eq!(active_count(), 1);

        stop("one");
        assert_eq!(active_count(), 0);
    }

    #[tokio::test]
    async fn stop_all_clears_every_stream() {
        for id in ["a", "b", "c"] {
            let task = tokio::spawn(async { std::future::pending::<()>().await });
            registry().lock().unwrap().insert(id.into(), task.abort_handle());
        }
        assert_eq!(active_count(), 3);

        stop_all();
        assert_eq!(active_count(), 0);
    }
}
