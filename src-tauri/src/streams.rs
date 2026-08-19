use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tokio::task::AbortHandle;

/// Registry of long-lived background tasks, keyed by an id the frontend owns.
///
/// Every stream the app opens — log follows, resource watches, port forwards — is
/// registered here so it can be ended precisely. A stream nobody can stop is a leak
/// against the API server, and AGENTS.md requires them to be cancellable.
pub struct StreamRegistry {
    handles: OnceLock<Mutex<HashMap<String, AbortHandle>>>,
}

impl StreamRegistry {
    pub const fn new() -> Self {
        Self { handles: OnceLock::new() }
    }

    fn map(&self) -> &Mutex<HashMap<String, AbortHandle>> {
        self.handles.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Registers a task, replacing and aborting any stream already under this id.
    pub fn insert(&self, id: &str, handle: AbortHandle) {
        if let Ok(mut map) = self.map().lock() {
            if let Some(previous) = map.insert(id.to_string(), handle) {
                previous.abort();
            }
        }
    }

    /// Ends a stream. Safe for an id that is already gone, which is what makes it
    /// usable from a component teardown that may run more than once.
    pub fn stop(&self, id: &str) {
        if let Ok(mut map) = self.map().lock() {
            if let Some(handle) = map.remove(id) {
                handle.abort();
            }
        }
    }

    /// Removes an id without aborting — for a task that has already finished and is
    /// clearing its own entry.
    pub fn forget(&self, id: &str) {
        if let Ok(mut map) = self.map().lock() {
            map.remove(id);
        }
    }

    pub fn stop_all(&self) {
        if let Ok(mut map) = self.map().lock() {
            for (_, handle) in map.drain() {
                handle.abort();
            }
        }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.map().lock().map(|map| map.contains_key(id)).unwrap_or(false)
    }

    pub fn len(&self) -> usize {
        self.map().lock().map(|map| map.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each test gets its own registry, so nothing here depends on execution order.
    fn spawn_pending() -> AbortHandle {
        tokio::spawn(async { std::future::pending::<()>().await }).abort_handle()
    }

    #[tokio::test]
    async fn tracks_a_stream_until_it_is_stopped() {
        let registry = StreamRegistry::new();
        registry.insert("one", spawn_pending());
        assert!(registry.contains("one"));

        registry.stop("one");
        assert!(!registry.contains("one"));
    }

    #[tokio::test]
    async fn stopping_an_unknown_id_is_harmless() {
        let registry = StreamRegistry::new();
        registry.stop("absent");
        registry.stop("absent");
        assert_eq!(registry.len(), 0);
    }

    #[tokio::test]
    async fn stopping_one_leaves_the_others_running() {
        let registry = StreamRegistry::new();
        registry.insert("keep", spawn_pending());
        registry.insert("drop", spawn_pending());

        registry.stop("drop");
        assert!(registry.contains("keep"));
        assert!(!registry.contains("drop"));
    }

    #[tokio::test]
    async fn reinserting_an_id_replaces_the_previous_stream() {
        // A viewer restarting its stream must not leave the old one running.
        let registry = StreamRegistry::new();
        let first = tokio::spawn(async { std::future::pending::<()>().await });
        let handle = first.abort_handle();
        registry.insert("viewer", handle);
        registry.insert("viewer", spawn_pending());

        assert_eq!(registry.len(), 1);
        assert!(first.await.is_err(), "the replaced task should have been aborted");
    }

    #[tokio::test]
    async fn forget_clears_the_entry_without_aborting() {
        let registry = StreamRegistry::new();
        let task = tokio::spawn(async { 7 });
        registry.insert("done", task.abort_handle());

        registry.forget("done");
        assert!(!registry.contains("done"));
        assert_eq!(task.await.unwrap(), 7);
    }

    #[tokio::test]
    async fn stop_all_clears_everything() {
        let registry = StreamRegistry::new();
        for id in ["a", "b", "c"] {
            registry.insert(id, spawn_pending());
        }
        assert_eq!(registry.len(), 3);

        registry.stop_all();
        assert_eq!(registry.len(), 0);
    }
}
