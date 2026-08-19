# Roadmap

## Product direction

A desktop Kubernetes operations console focused on daily troubleshooting. Not a Lens
clone — the goal is to be *faster to a diagnosis*, *safer on shared clusters*, and
extensible through plugins.

The main workflow should take fewer clicks than `kubectl`:

```text
Cluster → Namespace → Resource → Inspect → Logs / YAML / Events → Action
```

### Who it is for

| | Needs |
|---|---|
| **Developer** | Read namespaces, workloads, pods, events, logs. Inspect YAML. No escalation path through the app. |
| **DevOps** | The above, plus editing and applying ConfigMaps, Deployments, Services, Ingresses, HPA, and workload operations. Exec and port-forward where RBAC allows. |
| **Platform admin** | Cluster and cloud topology, diagnostics, RBAC visibility, plugin administration. |

### Capability mapping

The UI hides what it knows is unauthorized; Kubernetes stays authoritative.

| Capability | Verb / resource |
|---|---|
| View pods | `get/list/watch pods` |
| View logs | `get pods/log` |
| View events | `get/list/watch events` |
| Edit ConfigMap / Deployment | `update/patch configmaps`, `update/patch deployments` |
| Restart workload | `patch deployments/statefulsets/daemonsets` |
| Cordon / drain / delete node | `patch nodes`, `create pods/eviction`, `delete nodes` |
| Exec / port-forward | `create pods/exec`, `create pods/portforward` |
| Read Secret value | `get secrets` — hidden by default regardless |

### Diagnostic engine

When a workload is unhealthy, walk a bounded graph —
`Ingress → Service → Endpoints → Deployment → ReplicaSet → Pod` plus events,
containers, config references, volumes, and probes — and produce human-readable
findings: ImagePullBackOff, CrashLoopBackOff, FailedMount, probe failure,
unschedulable pod, missing endpoints, ingress target mismatch, pending PVC, node
pressure, failed admission webhook.

**Never claim certainty when the evidence is incomplete.** A denied collector or an
absent metric is reported as such.

### Non-goals

A centralized credential server. Cloud resource provisioning. A generic terminal.
A secret management platform. A CI/CD system. Automatic destructive remediation.

---

## v0.1 Foundation
- [x] Product specification
- [x] UI prototype
- [x] Rust/Tauri skeleton
- [x] Tauri project metadata and icons
- [x] Real kubeconfig context listing
- [x] Real namespace listing

## v0.2 Kubernetes core
- [x] Generic resource abstraction
- [x] Pod list with status, readiness, and age
- [x] Pod watch
- [x] Deployment list with replica status
- [x] StatefulSet, DaemonSet, Job, CronJob and unmanaged ReplicaSet listing
- [x] Events list and namespace event view
- [x] Logs streaming, cancellable, with timestamps and previous
- [x] Bounded pod log retrieval
- [x] YAML editor with diff review for Pods, workloads, Services and Ingresses
- [x] Save through replace, preserving field ownership and detecting conflicts
- [x] RBAC capability discovery for current MVP actions

## v0.3 Operations
- [x] Restart workload
- [x] Scale and delete workloads
- [x] Log export
- [x] Port-forward, loopback only
- [x] Exec with explicit RBAC permission
- [x] Command palette
- [x] Global resource search
- [x] Resource relation graph

## v0.4 Cluster overview and cloud context
- [x] Provider detection: EKS, AKS, GKE, or plain Kubernetes
- [x] Normalised node pool and Spot/on-demand labels across all three providers
- [x] EKS enrichment: control plane status, platform version, OIDC issuer
- [x] Cluster health score with weighted signals and evidence-backed findings
- [x] Capacity model: allocatable vs requests vs limits vs live usage, per cluster and per node
- [x] Distribution by Availability Zone, capacity type, instance type, and node pool
- [x] Node taints with effects, per node and across the fleet
- [x] Kubelet version skew detection
- [x] Node operations gated by SelfSubjectAccessReview
- [ ] AKS and GKE control plane enrichment
- [ ] EC2 instance correlation through the AWS SDK
- [ ] Dedicated node pool view
- [ ] Load balancer context
- [ ] Storage context

## v0.5 Plugins
- [ ] Plugin SDK with an explicit permission manifest
- [ ] Helm
- [ ] Argo CD
- [ ] Vault
- [ ] Prometheus
- [ ] Grafana
- [ ] Airflow

Plugins must declare their permissions explicitly and must never silently access
credentials or arbitrary files.

## v1.0
- [ ] Stable Windows/Linux/macOS builds
- [ ] Signed releases
- [ ] Content Security Policy enabled
- [ ] Crash-safe operation
- [ ] Independent security review
- [ ] Documentation

## Acceptance criteria

- Opening the app with an existing kubeconfig shows the available contexts.
- Switching contexts never writes credentials to application storage.
- Read-only users can view pods and logs wherever RBAC grants it.
- Write users can edit and apply permitted resources without reaching for `kubectl`.
- Unauthorized actions produce a clear Forbidden message naming the resource.
- Log streaming survives pod restarts and container selection.
- YAML changes show a diff before apply.
- Secret values are never displayed by default.
- The app stays useful on a non-EKS cluster and with no cloud credentials at all.
