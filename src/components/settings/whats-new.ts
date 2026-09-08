/**
 * Shown at the bottom of Settings → About. Rewrite this list as part of every
 * release — it describes the version that is running, not the git history.
 * The version number itself comes from package.json; only the story lives here.
 */
export const WHATS_NEW: string[] = [
  'The developer profile now follows the environment: production is look-but-don’t-touch, staging allows pod deletes and rollout restarts, development also reveals Secret and ConfigMap values.',
  'Deleting a pod counts as a restart, not a workload deletion — the controller recreates it — so developers get pod restarts outside production.',
  'A refusal in production says the environment is the reason, not a missing grant, and the buttons it covers stay hidden.',
  'The audit trail can be switched off per install (environment.logAudit in the chart values); the Access screen states plainly when nothing is being recorded.',
  'Exec, log-stream and pod-watch ids now come from the browser’s cryptographic generator — closing the repository’s one open CodeQL finding.',
  'Releases are plain v* tags on main, and the contributor docs describe the web product.',
];
