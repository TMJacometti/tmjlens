export type EnvironmentId = 'production' | 'staging' | 'development' | 'unset';

export type AppSettings = {
  /** Context name → environment id. Never holds anything read from a cluster. */
  context_environments: Record<string, EnvironmentId>;
  confirm_destructive_in_production: boolean;
};

export type KubeContextDetail = {
  name: string;
  current: boolean;
  cluster: string;
  user: string;
  namespace?: string;
  server?: string;
  /** The authentication method, never the material behind it. */
  auth_method: string;
  environment: EnvironmentId;
};

export type KubeconfigView = {
  path?: string;
  writable: boolean;
  read_only_reason?: string;
  current_context?: string;
  contexts: KubeContextDetail[];
};

export type EnvironmentMeta = {
  id: EnvironmentId;
  label: string;
  short: string;
  description: string;
};

/**
 * Environment is a classification, not a health state, so it never borrows the
 * status palette. Each entry always renders with its written label — the colour
 * alone is never the signal.
 */
export const ENVIRONMENTS: EnvironmentMeta[] = [
  {
    id: 'production',
    label: 'Production',
    short: 'PRD',
    description: 'Serving real traffic. Destructive actions ask for the cluster name.',
  },
  { id: 'staging', label: 'Staging', short: 'HML', description: 'Pre-production. Treated as shared.' },
  { id: 'development', label: 'Development', short: 'DEV', description: 'Safe to break.' },
  { id: 'unset', label: 'Unclassified', short: '—', description: 'No environment assigned yet.' },
];

export function environmentMeta(id: EnvironmentId | undefined): EnvironmentMeta {
  return ENVIRONMENTS.find((entry) => entry.id === id) ?? ENVIRONMENTS[3];
}
