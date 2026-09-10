/**
 * Shown at the bottom of Settings → About. Rewrite this list as part of every
 * release — it describes the version that is running, not the git history.
 * The version number itself comes from package.json; only the story lives here.
 */
export const WHATS_NEW: string[] = [
  'New Kyverno plugin: every policy with its verdicts joined in — which rules Enforce and which merely Audit, the resources that fail them, and why.',
  'Audit policies with failing resources are called out as "reporting, not blocking" — writing a policy is not the same as being protected by it.',
  'Admins can switch a policy between Enforce and Audit from the screen, with the blast radius spelled out before the click and the change compare-and-set on the server.',
  'Policies Kyverno itself rejected surface as Not ready with the rejection message, instead of quietly not applying.',
];
