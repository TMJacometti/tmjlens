# Contributing to tmjLens

Issues and pull requests are welcome. This document covers the development setup and
the engineering rules the codebase holds to.

tmjLens is licensed under the **GNU AGPL-3.0**. By contributing you agree that your
contribution is licensed under the same terms.

## Ground rules

`main` is protected: all changes land through a pull request. Before opening one, make
sure `cargo test`, `npm run build`, and `npm run test:e2e` all pass.

## Engineering rules

These are not style preferences. They are the reason the app can be pointed at a
production cluster.

- **Never store credentials.** No Kubernetes tokens, no cloud credentials, no Secret
  values written to disk or to browser storage. Use the existing kubeconfig and the
  provider's own credential chain.
- **Kubernetes RBAC is the only authority.** Never implement a client-side permission
  model. The UI may *hide* actions it knows are unauthorized — via
  `SelfSubjectAccessReview` — but Kubernetes decides.
- **A `403` is a user-visible authorization state,** not an application error and not
  a crash.
- **Never execute a destructive operation silently.** Delete, apply, restart, drain,
  cordon, exec, and port-forward all require explicit confirmation.
- **Secret values stay hidden by default,** including in diagnostics, findings, and
  logs, even when the identity could technically read them.
- **Keep Kubernetes usable without cloud credentials.** Cloud SDK calls are additive
  enrichment; a missing credential must degrade only the fields it feeds.
- **Bound and cancel watches and log streams.** No unbounded reads.
- **Keep cluster access in the Rust layer.** Never move credentials or Kubernetes API
  calls into frontend-only code.
- **The webview gets no filesystem permission.** If something needs to touch disk, it
  goes through a narrow Rust command that decides the path itself.
- **Never claim certainty the evidence does not support.** If a collector was denied or
  a metric is missing, say so instead of rendering a zero.
- **No telemetry.** Not in any build.

## Prerequisites

| | |
|---|---|
| Node.js | 20 or newer, with npm |
| Rust | stable; MSVC toolchain on Windows |
| Tauri CLI | `cargo install tauri-cli --version "^2"` |
| Windows only | Visual Studio Build Tools with **Desktop development with C++**, and the WebView2 Runtime |
| Kubernetes | a working kubeconfig context |

Verify the toolchain:

```bash
node --version && rustc --version && cargo tauri --version && kubectl version --client
```

## Kubernetes access

tmjLens reads the same kubeconfig as `kubectl` — normally `~/.kube/config`, or
`%USERPROFILE%\.kube\config` on Windows. Confirm the context works first:

```bash
kubectl config current-context
kubectl get namespaces
```

Exec credential plugins are honoured as configured. For EKS the AWS CLI must be on
`PATH`; for AKS, the Azure CLI and whatever `kubelogin`/`az` command the context
references. tmjLens invokes what kubeconfig already declares — it neither replaces nor
persists those credentials.

Point at a different file with `KUBECONFIG`:

```bash
KUBECONFIG=/path/to/config cargo tauri dev          # bash
$env:KUBECONFIG = "C:\path\to\config"               # PowerShell
```

## Running

```bash
cd src && npm install          # once
cd ../src-tauri && cargo tauri dev
```

Build a release binary with `cargo tauri build`; it lands in
`src-tauri/target/release/`. The target machine needs WebView2 (Windows), its own
kubeconfig, and any credential command that kubeconfig references.

## Working on the UI without a cluster

The visual layer runs against fixtures, so most frontend work needs no cluster at all:

```bash
cd src && npm run dev
```

| URL | Renders |
|---|---|
| `/preview.html` | Cluster overview, EKS fixture with full cloud enrichment |
| `/preview.html?provider=aks` | The same page with no cloud enrichment and no metrics-server |
| `/preview.html?view=actions` | Row action menu inside a clipping panel |

The fixtures in `src/preview/fixture.ts` deliberately cover the awkward cases: an
unready node, memory and disk pressure, a cordon, kubelet version skew, overcommitted
limits, multiple taints, and long resource names. **Extend them when you add a state
the UI has to handle** — that is cheaper than reproducing it on a real cluster, and it
is what the screenshots in the README are generated from.

Fixtures must never contain real cluster data. Use invented names.

## Validating a change

```bash
cd src-tauri && cargo test     # Rust unit tests
cd src && npm run build        # type-check and bundle
cd src && npm run test:e2e     # Playwright regression tests
```

`npm run test:e2e` drives the system's installed Edge so it needs no browser download.
On a machine without Edge, drop the `channel` line from `src/playwright.config.ts` and
run `npx playwright install chromium`.

Add tests for resource adapters, RBAC capability mapping, YAML diff/apply flows, and
log stream cancellation. A regression test that does not fail on the unfixed code is
not a regression test — verify it by breaking the fix on purpose.

## Repository layout

```text
src/                          React + TypeScript frontend
  App.tsx                     Application shell and workload views
  components/
    ActionMenu.tsx            Portalled row menu
    Toast.tsx                 Transient action feedback
    cluster/                  Cluster overview page and chart primitives
  lib/format.ts               CPU, byte, percentage, and duration formatting
  types/cluster.ts            Types mirroring the Rust payloads
  preview/                    Fixture-driven preview harness
  tests/                      Playwright specs
src-tauri/
  src/main.rs                 Tauri commands and kube client calls
  src/cluster.rs              Provider detection, capacity model, health, findings
  capabilities/default.json   Webview permissions — currently core:default only
docs/ROADMAP.md               Milestones and product direction
```

## How the layers talk

```text
React UI
   │  invoke("get_cluster_overview", { context })
   ▼
Rust command in main.rs
   │
   ├── kube client ── Kubernetes API   (always)
   └── cloud CLI ──── provider metadata (optional, additive)
```

The 22 registered commands:

| Group | Commands |
|---|---|
| Context | `current_context`, `list_kube_contexts`, `list_namespaces` |
| Pods | `list_pods`, `list_pod_containers`, `get_pod_logs`, `delete_pod` |
| Deployments | `list_deployments`, `scale_deployment`, `restart_deployment`, `delete_deployment` |
| Cluster | `get_cluster_overview`, `list_namespace_snapshot`, `list_events`, `list_created_today` |
| Nodes | `set_node_schedulable`, `drain_node`, `delete_node` |
| YAML | `get_resource_yaml`, `apply_resource_yaml` |
| Authorization | `check_permission` |
| Local files | `save_to_downloads` |

## Adding a Tauri command

1. Write it in `src-tauri/src/main.rs` (or `cluster.rs` for overview logic), returning
   `Result<T, String>`.
2. Register it in the `invoke_handler!` list.
3. Mirror the payload type in `src/types/`.
4. If it can be denied by RBAC, gate the UI on `check_permission` — and still handle
   the `403`.
5. Never block the async runtime. Shell-outs and file I/O go through
   `tokio::task::spawn_blocking`.

## Security reporting

Do not open a public issue for a security problem. Contact the maintainer directly.
