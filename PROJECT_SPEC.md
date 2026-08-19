# tmjLens Product & Engineering Specification

## 1. Product goal

Build a cross-platform desktop Kubernetes operations console focused on EKS and daily DevOps workflows. tmjLens is not a blind Lens clone. It should be faster for troubleshooting, safer for shared clusters, and extensible through plugins.

## 2. Personas

### Developer
- Read namespaces, workloads, pods, events and logs.
- Inspect YAML.
- No access escalation through the application.
- UI must hide actions that are known to be unauthorized, while Kubernetes remains authoritative.

### DevOps
- Everything above plus edit/apply ConfigMaps, Deployments, Services, Ingresses, HPA and selected workload operations.
- Optional exec/port-forward according to RBAC.

### Platform admin
- EKS/AWS topology, cluster diagnostics, RBAC and plugin administration.

## 3. Information architecture

```text
App
├── Context switcher
├── Namespace switcher
├── Command palette
├── Search
├── Workloads
│   ├── Deployments
│   ├── StatefulSets
│   ├── DaemonSets
│   ├── Jobs
│   └── CronJobs
├── Pods
│   ├── Overview
│   ├── Logs
│   ├── Events
│   ├── YAML
│   └── Containers
├── Network
│   ├── Services
│   ├── Ingresses
│   └── Endpoints
├── Configuration
│   ├── ConfigMaps
│   └── Secrets (metadata only by default)
├── Storage
│   ├── PVCs
│   ├── PVs
│   └── StorageClasses
├── Cluster
│   ├── Nodes
│   ├── Events
│   └── CRDs
├── Cluster Overview
│   ├── Health and findings
│   ├── Capacity
│   ├── Availability Zones
│   └── Nodes
├── Cloud context
│   ├── Node Pools
│   ├── Load Balancers
│   ├── Block / file storage
│   └── Identity context
└── Plugins
```

## 4. Core screens

### Dashboard
- Active cluster and namespace.
- Health summary.
- Recent warning events.
- Workload failures.
- Node pressure indicators.

### Resource list
- Search/filter/sort.
- Status badges.
- Age.
- Namespace.
- Labels.
- Quick actions.

### Resource detail
Tabs:
- Overview
- Logs where applicable
- Events
- YAML
- Related resources

### YAML editor
- Monaco/CodeMirror.
- Syntax highlighting.
- Schema-aware validation where possible.
- Original vs edited diff.
- Apply button.
- Confirmation for destructive changes.
- Show server-side validation errors.

### Logs
- Live follow.
- Previous container logs.
- Multi-container selector.
- Tail lines.
- Since duration.
- Timestamps.
- Search/filter.
- Download/copy.

## 5. Diagnostic engine

When a workload is unhealthy, collect a bounded diagnostic graph:

```text
Ingress
  ↓
Service
  ↓
Endpoints
  ↓
Deployment
  ↓
ReplicaSet
  ↓
Pod
  ├── Events
  ├── Containers
  ├── ConfigMaps
  ├── Secret references (names only)
  ├── PVCs
  └── Probes
```

Produce human-readable findings such as:
- ImagePullBackOff.
- CrashLoopBackOff.
- FailedMount.
- Readiness/liveness failure.
- Unschedulable pod.
- Missing service endpoints.
- Ingress target mismatch.
- PVC pending.
- Node pressure.
- Failed admission/webhook.

Never claim certainty when evidence is incomplete.

## 6. RBAC model

The application must not implement its own authorization layer that grants Kubernetes privileges. It consumes Kubernetes `SelfSubjectAccessReview` where useful and handles Forbidden responses gracefully.

Suggested UI capability mapping:

| Capability | Typical verb/resource |
|---|---|
| View pods | get/list/watch pods |
| View logs | get pods/log |
| View events | get/list/watch events |
| Edit ConfigMap | update/patch configmaps |
| Edit Deployment | update/patch deployments |
| Restart workload | patch deployment/statefulset/daemonset |
| Exec | create pods/exec |
| Port forward | create pods/portforward |
| Delete pod | delete pods |
| Read Secret value | get secrets |

Secret values are hidden by default even when technically readable.

## 7. Cloud integration

The cluster overview is provider-agnostic and must work on EKS, AKS, GKE, and plain
Kubernetes using only the Kubernetes API. Providers are detected from `spec.providerID`,
node labels, and the API endpoint, and each provider's node-pool and Spot labels are
normalized to one shape.

Cloud SDK calls are strictly additive enrichment on top of that baseline. A missing
credential, a denied permission, or an unrecognized provider degrades the affected
fields only — never the overview.

Use AWS SDK only when the current cluster is recognized as EKS and the user has AWS permissions.

Resolve EKS cluster metadata, node groups and regions using the standard AWS credential chain. Correlate Kubernetes nodes with EC2 instances where permissions allow.

Useful views:
- Cluster endpoint and version.
- Node groups.
- Node instance IDs.
- AZ distribution.
- Instance types.
- ALB/NLB context.
- EBS/EFS context.
- Security group references.

Do not mutate AWS resources in MVP.

## 8. Plugin architecture

Plugin contract should support:
- id
- name
- version
- permissions requested
- navigation entries
- resource panels
- commands
- diagnostics providers
- settings

Initial plugin targets:
- aws
- helm
- argocd
- vault
- prometheus
- grafana
- airflow

Plugins must declare permissions explicitly. Plugins must not silently access credentials or arbitrary files.

## 9. Command palette

Examples:
- Switch cluster
- Switch namespace
- Find resource
- View pod logs
- Restart deployment
- Edit ConfigMap
- Apply YAML
- Refresh resource
- Show events
- Open related Service
- Open related Ingress

## 10. Non-goals for MVP

- Centralized credential server.
- Full cloud resource provisioning.
- Generic terminal replacement.
- Secret management platform.
- Full CI/CD system.
- Automatic destructive remediation.

## 11. Acceptance criteria

- Opening the app with an existing kubeconfig shows available contexts.
- Switching contexts never writes credentials to application storage.
- Read-only users can view pods and logs when Kubernetes RBAC grants those permissions.
- Write users can edit/apply permitted resources without requiring kubectl.
- Unauthorized actions produce a clear Forbidden message.
- Log streaming handles pod restarts and container selection.
- YAML changes show a diff before apply.
- Secret values are not displayed by default.
- The app remains useful without AWS permissions when pointed at a non-EKS Kubernetes cluster.
