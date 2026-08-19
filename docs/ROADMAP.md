# Roadmap

## v0.1 Foundation
- [x] Product specification
- [x] UI prototype
- [x] Rust/Tauri skeleton
- [x] Tauri project metadata and icons
- [x] Real kubeconfig context listing
- [x] Real namespace listing

## v0.2 Kubernetes core
- [ ] Generic resource abstraction
- [x] Pod list with status, readiness, and age
- [ ] Pod watch
- [x] Deployment list with replica status
- [ ] StatefulSet/DaemonSet list/watch
- [x] Events list and namespace event view
- [ ] Logs streaming
- [x] Bounded pod log retrieval
- [x] YAML editor for Pods
- [x] Server-side apply for Pods and Deployments
- [x] RBAC capability discovery for current MVP actions

## v0.3 Operations
- [x] Restart workload
- [ ] Port-forward
- [ ] Exec with explicit RBAC permission
- [ ] Command palette
- [ ] Global resource search
- [ ] Resource relation graph

## v0.4 Cluster overview and cloud context
- [x] Provider detection: EKS, AKS, GKE, or plain Kubernetes
- [x] Normalised node pool and Spot/on-demand labels across all three providers
- [x] EKS enrichment: control plane status, platform version, OIDC issuer
- [x] Cluster health score with weighted signals and evidence-backed findings
- [x] Capacity model: allocatable vs requests vs limits vs live usage, per cluster and per node
- [x] Distribution by Availability Zone, capacity type, instance type, and node pool
- [x] Kubelet version skew detection
- [x] Node operations gated by SelfSubjectAccessReview
- [ ] AKS and GKE control plane enrichment
- [ ] EC2 instance correlation through the AWS SDK
- [ ] Dedicated node pool view
- [ ] Load balancer context
- [ ] Storage context

## v0.5 Plugins
- [ ] Plugin SDK
- [ ] Helm
- [ ] Argo CD
- [ ] Vault
- [ ] Prometheus
- [ ] Grafana
- [ ] Airflow

## v1.0
- [ ] Stable Windows/Linux/macOS builds
- [ ] Signed releases
- [ ] Crash-safe operation
- [ ] Security review
- [ ] Documentation
