# Codex instructions for tmjLens

## Goal
Implement tmjLens as a secure, lightweight desktop Kubernetes/EKS operations console. Read `PROJECT_SPEC.md`, `ARCHITECTURE.md`, and `docs/ROADMAP.md` before making architectural decisions.

## Engineering rules

- Do not store Kubernetes tokens, AWS credentials or Secret values in local app storage.
- Kubernetes RBAC is authoritative. Never implement a client-side permission bypass.
- Never silently execute destructive operations.
- Hide Secret values by default.
- Use bounded, cancellable Kubernetes watches/log streams.
- Handle Forbidden responses as expected user authorization states.
- Keep Kubernetes functionality usable without AWS integration.
- Keep AWS integration read-only until explicitly added to the roadmap.
- Prefer small typed service interfaces between React and Rust.
- Add tests for resource adapters, RBAC capability mapping, YAML diff/apply flows and log stream cancellation.
- Do not add telemetry in MVP.

## UX priorities

1. Logs should be reachable in two clicks from a Pod.
2. YAML editing should show a diff before Apply.
3. Cluster and namespace switching must always be visible.
4. Errors should explain what Kubernetes denied and which resource caused it.
5. The UI should remain useful in read-only mode.

## Implementation order

1. Complete Tauri metadata/build configuration.
2. Implement kubeconfig context enumeration.
3. Implement namespace enumeration.
4. Implement generic Kubernetes resource APIs.
5. Implement Pods and logs.
6. Implement Events.
7. Implement YAML editor + diff + apply.
8. Implement RBAC capability discovery.
9. Add workload operations.
10. Add EKS and plugin infrastructure.
