/**
 * Shown at the bottom of Settings → About. Rewrite this list as part of every
 * release — it describes the version that is running, not the git history.
 * The version number itself comes from package.json; only the story lives here.
 */
export const WHATS_NEW: string[] = [
  'Rightsizing shows requests again: hourly and daily rollups were compacted with request/limit/replicas left NULL, and the screen reads those first. Compaction now carries the newest window’s values; existing rows heal on their next compaction.',
  'Rightsizing measures again: the collector parsed the kubelet’s cAdvisor lines by their last space, so every series carrying a timestamp — all the CPU and memory ones — was dropped and only spec lines came through. Rows existed, values were “—”. Fixed against a real kubelet dump.',
  'The collector is never silent now: one line per window with the server’s answer (accepted/skipped), a flush line when a buffered window lands, and a loud warning if a window closes with containers but zero measurements.',
  'tmjLite 0.2.9 under the hood: a one-row write went from ~400 ms to ~4 ms (the engine rewrote whole tables and indexes on every commit), and each collector batch now lands in ONE transaction instead of hundreds of commits.',
  'The web pod no longer restarts under collector load: database writes moved off the async runtime, batches apply one at a time, retention runs hourly, and the liveness probe waits a full minute before killing.',
  'Rightsizing names the nodes the collector is NOT running on, with the scheduler’s reason (e.g. Too many pods); collector.priorityClassName in the chart lets it preempt to fit.',
  'The collector’s log says WHY an upload failed — timeout, connection refused, DNS — not just that it did.',
  'The Helm plugin’s uninstall and rollback work in-cluster: the image ships the helm CLI, and no kubeconfig context is assumed.',
  'Rightsizing for Admins: request vs real CPU/memory from a node DaemonSet, waste, and an explainable recommendation — never a silent zero when data could not be collected.',
  'HPA manager (off by default): preview a server-side diff, apply with field manager tmjlens, undo. Developer and Guest get 403 even on the reads.',
  'Generic OIDC alongside Azure AD, so an EKS install can sign in without Entra.',
];
