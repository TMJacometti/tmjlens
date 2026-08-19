import type { KubeconfigView } from '../types/settings';

/**
 * Minimal stand-in for the Tauri IPC bridge.
 *
 * `@tauri-apps/api` dispatches through `window.__TAURI_INTERNALS__.invoke`, which only
 * exists inside the desktop shell. Defining it here lets the preview exercise the real
 * components in a browser. Preview-only: never imported by the app entry point.
 */
const KUBECONFIG: KubeconfigView = {
  path: 'C:\\Users\\operator\\.kube\\config',
  writable: true,
  current_context: 'arn:aws:eks:sa-east-1:123456789012:cluster/prod-shark',
  contexts: [
    {
      name: 'arn:aws:eks:sa-east-1:123456789012:cluster/prod-shark',
      current: true,
      cluster: 'arn:aws:eks:sa-east-1:123456789012:cluster/prod-shark',
      user: 'arn:aws:eks:sa-east-1:123456789012:cluster/prod-shark',
      namespace: 'payments',
      server: 'https://A1B2C3D4.gr7.sa-east-1.eks.amazonaws.com',
      auth_method: 'exec plugin',
      environment: 'production',
    },
    {
      name: 'aks-hml-shark',
      current: false,
      cluster: 'aks-hml-shark',
      user: 'clusterUser_rg-shark_aks-hml-shark',
      namespace: 'checkout',
      server: 'https://hml-shark-a1b2.hcp.brazilsouth.azmk8s.io:443',
      auth_method: 'exec plugin',
      environment: 'staging',
    },
    {
      name: 'minikube',
      current: false,
      cluster: 'minikube',
      user: 'minikube',
      server: 'https://127.0.0.1:6443',
      auth_method: 'client certificate',
      environment: 'development',
    },
  ],
};

type Internals = { invoke: (command: string, args?: unknown) => Promise<unknown> };

export function installTauriStub() {
  const host = window as unknown as { __TAURI_INTERNALS__?: Internals };
  if (host.__TAURI_INTERNALS__) return;

  host.__TAURI_INTERNALS__ = {
    invoke: async (command) => {
      switch (command) {
        case 'read_kubeconfig':
          return KUBECONFIG;
        case 'load_settings':
          return { context_environments: {}, confirm_destructive_in_production: true };
        case 'save_settings':
        case 'set_current_context':
        case 'set_context_namespace':
          return null;
        default:
          throw new Error(`preview stub has no answer for "${command}"`);
      }
    },
  };
}
