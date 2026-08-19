use futures::{AsyncBufReadExt, TryStreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::{api::LogParams, Api, Client};
use serde::Serialize;
use tauri::Emitter;

use crate::streams::StreamRegistry;

static STREAMS: StreamRegistry = StreamRegistry::new();

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

pub fn stop(stream_id: &str) {
    STREAMS.stop(stream_id);
}

pub fn stop_all() {
    STREAMS.stop_all();
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

        STREAMS.forget(&id);
    });

    // Registering replaces any stream this viewer already had, aborting it.
    STREAMS.insert(&stream_id, task.abort_handle());
    Ok(())
}

