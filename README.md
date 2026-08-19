# tmjLens 🦈

A developer-first Kubernetes/EKS desktop operations console. The goal is to replace the everyday Lens workflow with a lightweight, extensible, security-conscious desktop app.

## Development

The practical setup, prerequisites, run commands, architecture flow, current implementation status, and troubleshooting steps are documented in [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md).

Quick start from the repository root after installing the prerequisites:

```powershell
cd src
npm install
cd ../src-tauri
cargo tauri dev
```

The app uses the active kubeconfig context and Kubernetes RBAC. It does not store cluster credentials locally.

Build the Windows executable:

```powershell
cd src-tauri
cargo tauri build
```

The generated application is placed at `src-tauri/target/release/tmjlens.exe`.

## Current status

The working Kubernetes core currently reads kubeconfig contexts, namespaces, pods, deployments, events, pod containers, and bounded pod logs through the Rust/Tauri backend. YAML view/apply for Pods and Deployments, RBAC capability discovery, and workload actions (scale, rollout restart, delete) are in place.

The Cluster Overview module reports cluster health as a weighted composite score with evidence-backed findings, and charts the capacity model — allocatable versus requests versus limits versus live usage — for the cluster and for every node. It also breaks the fleet down by Availability Zone, capacity type, instance type, and node pool, detects kubelet version skew, and gates node operations on `SelfSubjectAccessReview`.

The module is **provider-agnostic**. It detects EKS, AKS, GKE, or a plain Kubernetes cluster from `spec.providerID`, node labels, and the API endpoint, then normalises each provider's node-pool and Spot labels to a single shape:

| | EKS | AKS | GKE |
|---|---|---|---|
| Node pool | `eks.amazonaws.com/nodegroup`, `karpenter.sh/nodepool`, `alpha.eksctl.io/nodegroup-name` | `kubernetes.azure.com/agentpool`, `agentpool` | `cloud.google.com/gke-nodepool` |
| Spot | `eks.amazonaws.com/capacityType`, `karpenter.sh/capacity-type` | `kubernetes.azure.com/scalesetpriority` | `cloud.google.com/gke-spot`, `cloud.google.com/gke-preemptible` |

Cloud-specific enrichment is optional and additive: on EKS the control plane status, platform version, and OIDC issuer are read through the AWS CLI. Everything else works identically on every provider, and the module degrades explicitly when `metrics-server` is absent or RBAC denies a collector.

Cancellable log follow streams, EC2 correlation through the AWS SDK, load balancer and storage context, and the plugin SDK are still in progress.

The visual layer can be reviewed without a cluster by running `npm run dev` in `src/` and opening `/preview.html`, which renders the overview against a fixture covering the awkward cases (an unready node, pressure, a cordon, version skew, overcommitted limits). Append `?provider=aks` to review the path with no cloud enrichment and no metrics-server.

## Vision

- Multi-cluster, multi-cloud Kubernetes explorer using the user's kubeconfig and, where present, the cloud provider's own credential chain.
- Read logs, inspect events, restart workloads, and edit/apply YAML according to Kubernetes RBAC.
- Strong separation between read-only developer usage and privileged DevOps operations.
- Cloud-aware views for nodes, node pools, AZs, load balancers, block/file storage and identity context.
- Resource relationship map: Ingress → Service → Deployment → Pods → ConfigMap/Secret/PVC.
- Plugin architecture for AWS, Helm, Argo CD, Vault, Prometheus, Grafana and Airflow.
- No mandatory central backend and no credential storage by tmjLens.

## Proposed stack

- Desktop shell: Tauri 2
- Frontend: React + TypeScript + Vite
- UI: Tailwind CSS + shadcn/ui style components
- Kubernetes: Rust `kube` client in Tauri backend
- AWS: Rust AWS SDK, using the standard AWS credential chain
- YAML: Monaco Editor or CodeMirror
- State: TanStack Query + lightweight local UI state
- Tests: Vitest + Playwright + Rust unit tests

## MVP

1. Load kubeconfig contexts.
2. Connect to Kubernetes using the active context.
3. Cluster/namespace/resource explorer.
4. Pods, Deployments, StatefulSets, DaemonSets, Jobs and CronJobs.
5. Pod logs with follow, timestamps, container selection and previous logs.
6. Events.
7. YAML viewer/editor with diff before apply.
8. Apply/update/delete guarded by Kubernetes RBAC and explicit confirmation.
9. Context/namespace switcher.
10. Basic RBAC-aware action visibility.

## Phase 2

- EKS topology and AWS resource context.
- Resource relationship graph.
- Helm releases.
- Port-forward.
- Safe pod restart/rollout controls.
- Search across resources.
- Command palette.

## Phase 3

- Plugins: AWS, Argo CD, Vault, Prometheus, Grafana, Airflow.
- Health diagnostics: "Why is this workload broken?"
- Metrics panels.
- Audit trail of actions performed by the local client.
- Optional SSO integrations.

## Security principles

- Never store AWS credentials, Kubernetes tokens or Secret values on disk by default.
- Respect Kubernetes RBAC as the source of truth.
- Never expose Secret values in search, logs or diagnostics unless explicitly requested and authorized.
- Require confirmation for destructive actions.
- Separate read-only and write capabilities in the UI.
- Redact sensitive fields in diagnostics and telemetry.
- No telemetry in MVP.

## UX principles

The main workflow should take fewer clicks than kubectl:

`Cluster → Namespace → Resource → Inspect → Logs/YAML/Events → Action`

The UI should feel like an operations cockpit rather than a generic Kubernetes dashboard.
