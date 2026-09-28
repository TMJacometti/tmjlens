/**
 * Shown at the bottom of Settings → About. Rewrite this list as part of every
 * release — it describes the version that is running, not the git history.
 * The version number itself comes from package.json; only the story lives here.
 */
export const WHATS_NEW: string[] = [
  'Rightsizing for Admins: request vs real CPU/memory from a node DaemonSet, waste, and an explainable recommendation — never a silent zero when data could not be collected.',
  'HPA manager (off by default): preview a server-side diff, apply with field manager tmjlens, undo. Developer and Guest get 403 even on the reads.',
  'Generic OIDC alongside Azure AD, so an EKS install can sign in without Entra.',
  'The collector posts rollups to the web replica; it never opens the tmjLite file on the PVC.',
];
