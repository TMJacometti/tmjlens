use k8s_openapi::api::core::v1::Pod;
use kube::{api::AttachParams, Api, Client};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::streams::StreamRegistry;

static SESSIONS: StreamRegistry = StreamRegistry::new();
/// Writers for the live sessions, so keystrokes reach the right container.
static INPUTS: OnceLock<Mutex<HashMap<String, mpsc::UnboundedSender<Vec<u8>>>>> = OnceLock::new();

fn inputs() -> &'static Mutex<HashMap<String, mpsc::UnboundedSender<Vec<u8>>>> {
    INPUTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Shells tried in order. The first that exists wins; a distroless image has none of
/// them, which is reported as such rather than as a mysterious failure.
pub const SHELL_CANDIDATES: [&str; 3] = ["/bin/bash", "/bin/sh", "/busybox/sh"];

#[derive(Serialize, Clone)]
pub struct ExecOutput {
    pub session_id: String,
    /// Raw bytes as text. The terminal emulator on the other side handles control codes.
    pub chunk: String,
    pub stderr: bool,
}

#[derive(Serialize, Clone)]
pub struct ExecClosed {
    pub session_id: String,
    pub error: Option<String>,
}

pub fn stop(session_id: &str) {
    SESSIONS.stop(session_id);
    if let Ok(mut map) = inputs().lock() {
        map.remove(session_id);
    }
}

pub fn stop_all() {
    SESSIONS.stop_all();
    if let Ok(mut map) = inputs().lock() {
        map.clear();
    }
}

/// Sends keystrokes to a running session.
pub fn write(session_id: &str, data: &str) -> Result<(), String> {
    let map = inputs().lock().map_err(|error| error.to_string())?;
    let sender = map
        .get(session_id)
        .ok_or_else(|| "That terminal session is no longer open.".to_string())?;
    sender
        .send(data.as_bytes().to_vec())
        .map_err(|_| "That terminal session has closed.".to_string())
}

/// Opens an interactive shell in a container.
///
/// Nothing here bypasses Kubernetes: the request is a normal `pods/exec`, and an
/// identity without that permission is refused by the API server. The UI checks the
/// same permission first only so the button is not offered when it cannot work.
#[allow(clippy::too_many_arguments)]
pub async fn start(
    app: tauri::AppHandle,
    client: Client,
    namespace: String,
    pod: String,
    container: Option<String>,
    command: Vec<String>,
    session_id: String,
) -> Result<(), String> {
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let mut params = AttachParams::interactive_tty().stderr(false);
    if let Some(container) = container {
        params = params.container(container);
    }

    let mut process = api
        .exec(&pod, command, &params)
        .await
        .map_err(|error| format!("Could not start a shell in {pod}: {error}"))?;

    let mut stdout = process
        .stdout()
        .ok_or_else(|| "The container gave no output stream.".to_string())?;
    let mut stdin = process
        .stdin()
        .ok_or_else(|| "The container accepted no input stream.".to_string())?;

    let (sender, mut receiver) = mpsc::unbounded_channel::<Vec<u8>>();
    if let Ok(mut map) = inputs().lock() {
        map.insert(session_id.clone(), sender);
    }

    let id = session_id.clone();
    let task = tokio::spawn(async move {
        let writer = async move {
            while let Some(bytes) = receiver.recv().await {
                if stdin.write_all(&bytes).await.is_err() {
                    break;
                }
                let _ = stdin.flush().await;
            }
        };

        let reader_app = app.clone();
        let reader_id = id.clone();
        let reader = async move {
            let mut buffer = [0_u8; 8192];
            loop {
                match stdout.read(&mut buffer).await {
                    Ok(0) => break None,
                    Ok(count) => {
                        // Lossy on purpose: a terminal stream can split a UTF-8
                        // sequence across reads, and dropping the session over a
                        // half-character would be worse than one replacement glyph.
                        let chunk = String::from_utf8_lossy(&buffer[..count]).to_string();
                        let _ = reader_app.emit(
                            "pod-exec",
                            ExecOutput { session_id: reader_id.clone(), chunk, stderr: false },
                        );
                    }
                    Err(error) => break Some(error.to_string()),
                }
            }
        };

        let error = tokio::select! {
            _ = writer => None,
            outcome = reader => outcome,
        };

        let _ = app.emit("pod-exec-closed", ExecClosed { session_id: id.clone(), error });
        if let Ok(mut map) = inputs().lock() {
            map.remove(&id);
        }
        SESSIONS.forget(&id);
    });

    SESSIONS.insert(&session_id, task.abort_handle());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writing_to_an_unknown_session_says_so_rather_than_failing_silently() {
        let outcome = write("never-opened", "ls\n");
        assert!(outcome.is_err());
        assert!(outcome.unwrap_err().contains("no longer open"));
    }

    #[test]
    fn stopping_an_unknown_session_is_harmless() {
        stop("never-opened");
        stop("never-opened");
    }

    #[test]
    fn the_shell_candidates_are_ordered_from_most_to_least_capable() {
        assert_eq!(SHELL_CANDIDATES[0], "/bin/bash");
        assert_eq!(SHELL_CANDIDATES[1], "/bin/sh");
        // Busybox images keep their shell outside the usual path.
        assert_eq!(SHELL_CANDIDATES[2], "/busybox/sh");
    }

    #[tokio::test]
    async fn a_registered_session_accepts_input_until_it_is_stopped() {
        let (sender, mut receiver) = mpsc::unbounded_channel::<Vec<u8>>();
        inputs().lock().unwrap().insert("live".into(), sender);

        write("live", "echo hi\n").unwrap();
        assert_eq!(receiver.recv().await.unwrap(), b"echo hi\n");

        stop("live");
        assert!(write("live", "ls\n").is_err());
    }
}
