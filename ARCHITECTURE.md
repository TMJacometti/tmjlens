# tmjLens Architecture

## Layers

```text
React UI
  │
  │ Tauri commands
  ▼
Rust application layer
  ├── Kubernetes service
  │     ├── kubeconfig/context
  │     ├── resource CRUD
  │     ├── watch streams
  │     ├── logs stream
  │     └── SelfSubjectAccessReview
  │
  ├── Cluster overview service
  │     ├── provider detection (EKS/AKS/GKE/generic)
  │     ├── capacity model
  │     ├── health scoring
  │     └── findings
  │
  ├── Cloud context service (read-only, optional)
  │     ├── EKS/AKS/GKE control plane metadata
  │     ├── EC2
  │     ├── ELBv2
  │     ├── EBS/EFS metadata
  │     └── IAM read-only context
  │
  ├── Diagnostics engine
  └── Plugin host
```

## Kubernetes client rules

1. Prefer the current kubeconfig context.
2. Support exec credential plugins, including AWS IAM authentication for EKS.
3. Do not persist bearer tokens.
4. Reuse the user's existing AWS credential chain.
5. Stream watch/log operations rather than polling aggressively.
6. Surface HTTP 403 as an authorization state, not an application crash.

## Suggested Rust modules

```text
src-tauri/src/
├── main.rs
├── cluster.rs          # implemented: overview, capacity, health, provider adapters
├── commands/
│   ├── contexts.rs
│   ├── resources.rs
│   ├── logs.rs
│   ├── events.rs
│   └── diagnostics.rs
├── kubernetes/
│   ├── client.rs
│   ├── contexts.rs
│   ├── resources.rs
│   ├── logs.rs
│   └── rbac.rs
├── aws/
│   ├── ec2.rs
│   └── elb.rs
└── plugins/
    ├── manifest.rs
    ├── registry.rs
    └── permissions.rs
```

## Frontend modules

```text
src/
├── components/
│   ├── cluster/            # implemented: ClusterOverviewPage.tsx, charts.tsx
│   ├── AppShell.tsx
│   ├── ContextSwitcher.tsx
│   ├── NamespaceSwitcher.tsx
│   ├── ResourceTable.tsx
│   ├── ResourceDetail.tsx
│   ├── LogViewer.tsx
│   ├── YamlEditor.tsx
│   ├── EventTimeline.tsx
│   └── RelationGraph.tsx
├── pages/
│   ├── Dashboard.tsx
│   ├── Workloads.tsx
│   ├── Pods.tsx
│   ├── Network.tsx
│   ├── Configuration.tsx
│   ├── Storage.tsx
│   ├── Nodes.tsx
│   └── CloudContext.tsx
├── lib/
│   ├── tauri.ts
│   ├── query.ts
│   └── permissions.ts
└── types/
```
