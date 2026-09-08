# Contributing to tmjLens

This file is for people who **cloned the repository to change it**. Installing
tmjLens on a cluster does not need a clone — that is the [README](README.md).

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

- **Never store cluster credentials.** In the cluster the identity is the pod's
  ServiceAccount; on a dev machine, the local kubeconfig. No Kubernetes tokens, no
  cloud credentials, no Secret values written to disk or to browser storage. tmjLite
  stores the app's own data — users, profiles, grants, audit — never a credential.
- **The server is the authority.** Every command is gated server-side in `web.rs` by
  the permission its profile grants, and denied attempts are audited under the
  user's own name. Kubernetes RBAC caps what the instance's ServiceAccount may do at
  all. The UI may *hide* actions (`check_permission`), but never trust a client-side
  check — the server decides.
- **A `403` is a user-visible authorization state,** not an application error and not
  a crash.
- **Never execute a destructive operation silently.** Delete, apply, restart, drain,
  cordon, exec, and port-forward all require explicit confirmation.
- **Secret values stay hidden by default,** including in diagnostics, findings, and
  logs, even when the identity could technically read them.
- **Keep Kubernetes usable without cloud credentials.** Cloud SDK calls are additive
  enrichment; a missing credential must degrade only the fields it feeds.
- **Bound and cancel watches and log streams.** No unbounded reads.
- **Keep cluster access in the Rust layer.** The browser only ever talks to `/api`;
  every Kubernetes call happens server-side. Never move credentials or Kubernetes
  API calls into frontend-only code.
- **Never claim certainty the evidence does not support.** If a collector was denied or
  a metric is missing, say so instead of rendering a zero.
- **No telemetry.** Not in any build.

## Prerequisites

| | |
|---|---|
| Node.js | 20 or newer, with npm |
| Rust | stable; MSVC toolchain on Windows |
| Kubernetes | a working kubeconfig context (development runs against it; in the cluster the pod's ServiceAccount takes over) |

The tmjLite engine the server links against is vendored in `tools/tmjlite/` — nothing
to install. Verify the toolchain:

```bash
node --version && rustc --version && kubectl version --client
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
KUBECONFIG=/path/to/config cargo run                # bash
$env:KUBECONFIG = "C:\path\to\config"               # PowerShell
```

In the cluster none of this applies: the client authenticates as the pod's
ServiceAccount automatically.

## Running (development)

Two processes: the axum server and the Vite dev server.

```powershell
# terminal 1 — the server
cd src-tauri
$env:TMJLENS_DEV_USER = "you@example.com"        # trusted identity, no Azure AD needed
$env:TMJLENS_BOOTSTRAP_ADMIN = "you@example.com" # that email becomes admin on login
$env:TMJLENS_INSECURE_COOKIE = "1"               # session cookie without Secure, for http
cargo run

# terminal 2 — the frontend with hot reload
cd src
npm install   # once
npm run dev
```

Open <http://localhost:5173> — Vite proxies `/api` and `/auth` to the server on 8080.
To serve the built bundle from the server instead: `npm run build`, set
`TMJLENS_STATIC_DIR` to `src/dist`, open <http://localhost:8080>.

`TMJLENS_DEV_USER` is for development only and must never reach a cluster manifest:
with it set, every request is trusted as that user, and `/auth/dev-login?email=…`
mints a session for any email — useful in a second browser window to watch what a
`developer` or `guest` profile actually sees. Without it, the server requires the
Azure AD variables and refuses to start identityless — on purpose.

The database is created on first boot (`data/tmjlens.tmjp`; move it with
`TMJLENS_DB_PATH`). Delete the file to start over. Inspect it with the CLI in
`tools/tmjlite/` **while the server is stopped** — tmjLite is one process per file.

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
| `/preview.html?view=settings` | Settings panel over a stand-in shell |
| `/preview.html?view=report` | The generated executive PDF, rendered page by page |

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
  src/main.rs                 Command implementations over the kube client
  src/web.rs                  axum server: sessions, permission gate, audit, SSE logs
  src/auth.rs                 Users, the three fixed profiles, grants — on tmjLite
  src/db.rs                   tmjLite FFI wrapper and schema migrations
  src/cluster.rs              Provider detection, capacity model, health, findings
charts/tmjlens/               The Helm chart operators install from
Dockerfile                    The in-cluster image: server + frontend + tmjLite
tools/tmjlite/                tmjLite engine, CLI and schema.sql
docs/ROADMAP.md               Milestones and product direction
```

## How the layers talk

```text
Browser (React)
   │  POST /api/invoke/get_cluster_overview        (session cookie)
   ▼
axum gate in web.rs
   │  session → user → profile → permission        allow, or an audited 403
   ▼
command fn in main.rs and the domain modules
   └── kube client ── Kubernetes API   (ServiceAccount in-cluster; kubeconfig in dev)
```

Log following is the same gate over SSE (`/api/logs/stream`).

The registry of commands is the dispatcher in `web.rs`: one arm per command the
frontend may call, each mapped in `required_permission` to the permission that gates
it. A table here would only drift from it.

## Adding a command

1. Write it in `src-tauri/src/main.rs` or the matching domain module, returning
   `Result<T, String>`; route error strings through `errors::humanize` so an expired
   session or a denied verb reads like a sentence, not a stack trace.
2. Add its arm to the dispatcher in `web.rs`.
3. Map it in `required_permission`. The empty mapping (`""`) is only for harmless
   shell calls — anything that reads the cluster is at least `view`, anything that
   changes it needs the matching manage/edit/delete permission.
4. Mirror the payload type in `src/types/`.
5. Gate the UI on `check_permission` — and still handle the `403`, because the
   server, not the UI, decides.
6. Never block the async runtime. Shell-outs and file I/O go through
   `tokio::task::spawn_blocking`.

## Publishing the in-cluster build

Operators install from GHCR / the GitHub Release — they never clone. Cutting a
release is a tag on `main`:

```bash
git tag v0.6.0
git push origin v0.6.0
```

The `v*` tag must be semver after the prefix (`v0.6.0`, `v0.6.0-rc.1`). Releases
before the branch switch were tagged `web-*`; those tags and their assets stay
valid, new releases use `v*`.
GitHub Actions builds the Linux image, packages the Helm chart, pushes both to
GHCR, and attaches `tmjlens-chart-<version>.tgz` to the Release.

GHCR packages start **private** even though this repo is public. The Actions
token cannot flip that (the API answers 404). After the first successful
publish, once, in the GitHub UI:

1. https://github.com/TMJacometti/tmjlens/pkgs/container/tmjlens
2. https://github.com/TMJacometti/tmjlens/pkgs/container/tmjlens-chart

Package settings → Change visibility → Public. Until then, `helm show values`
against OCI needs `helm registry login`; the Release `.tgz` is already public.

## Security reporting

Do not open a public issue for a security problem. Contact the maintainer directly.
