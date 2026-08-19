# tmjLens Development Guide

## What we are building

tmjLens is a lightweight desktop operations console for Kubernetes and EKS. It is designed for developers and DevOps engineers who need to move quickly from a cluster to a resource, then inspect logs, events, YAML, and related resources.

The application is intentionally local-first:

- Kubernetes access uses the user's kubeconfig and Kubernetes RBAC.
- AWS access will use the standard AWS credential chain when EKS support is added.
- The application does not store Kubernetes tokens, AWS credentials, or Secret values.
- Destructive operations require explicit implementation and confirmation; they are not silently executed.

The main workflow is:

```text
Context -> Namespace -> Resource -> Inspect -> Logs / Events / YAML -> Action
```

## Current implementation

The current Kubernetes core includes:

- Tauri 2 desktop shell.
- React, TypeScript, and Vite frontend.
- Rust backend using the `kube` client.
- Kubeconfig context enumeration.
- Current context and namespace resolution.
- Namespace listing from the cluster.
- Pod listing.
- Pod container discovery.
- Deployment listing.
- Event listing.
- Bounded pod log retrieval with container selection and previous-log support in the backend.
- A first working Pods screen connected to the Tauri commands.

Still under development:

- True cancellable follow streams for logs.
- Complete namespace and context switcher controls.
- YAML editor, diff, validation, and apply.
- RBAC capability discovery and action visibility.
- Workload operations such as restart.
- Generic resource adapters and watches.
- EKS/AWS views and plugins.

The product requirements are in [PROJECT_SPEC.md](../PROJECT_SPEC.md). The layer boundaries are described in [ARCHITECTURE.md](../ARCHITECTURE.md), and planned milestones are tracked in [ROADMAP.md](ROADMAP.md).

## Prerequisites on Windows

Install the following before running the desktop application:

1. Node.js 20 or newer and npm.
2. Rust stable with the MSVC toolchain.
3. Visual Studio Build Tools with **Desktop development with C++**.
4. WebView2 Runtime, which is required by Tauri on Windows.
5. Kubernetes access through a working kubeconfig.
6. The Tauri CLI for desktop development.

Install the Tauri CLI once:

```powershell
cargo install tauri-cli --version "^2"
```

Verify the main tools:

```powershell
node --version
npm --version
rustc --version
cargo tauri --version
kubectl version --client
```

## Kubernetes access

tmjLens reads the same kubeconfig used by `kubectl`, normally at:

```text
%USERPROFILE%\.kube\config
```

Check that the active context works before starting the app:

```powershell
kubectl config current-context
kubectl config get-contexts
kubectl get namespaces
```

For an EKS context, make sure the AWS CLI is installed and available on `PATH`, and that the context's exec command already works with `kubectl`. For an AKS context, make sure the Azure CLI and the context's configured `kubelogin` or `az` command are installed and available on `PATH`. tmjLens invokes the exec credential configuration already present in kubeconfig; it does not replace or persist those credentials.

The active kubeconfig context and its configured namespace are used when the app starts. Kubernetes permissions remain authoritative: a `Forbidden` response means the connected identity does not have that permission.

## Install dependencies

From the repository root:

```powershell
cd src
npm install
cd ..
```

Rust dependencies are resolved automatically by Cargo during the first build.

## Run the desktop app

From the repository root:

```powershell
cd src-tauri
cargo tauri dev
```

Tauri starts the Vite development server using the command configured in [tauri.conf.json](../src-tauri/tauri.conf.json), opens the desktop window, and reloads the frontend while you work.

## Build the Windows executable

From the repository root:

```powershell
cd src-tauri
cargo tauri build
```

The standalone application is generated here:

```text
src-tauri\target\release\tmjlens.exe
```

The target Windows machine must have WebView2, its own kubeconfig, and any credential command referenced by that kubeconfig.

## Run the frontend only

Use this when working on React/CSS without needing native Tauri commands:

```powershell
cd src
npm run dev
```

Open the URL printed by Vite. Tauri-only `invoke` commands will not return Kubernetes data in a normal browser unless they are mocked.

## Validate changes

Run the frontend build:

```powershell
cd src
npm run build
```

Check the Rust backend:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

Run Rust unit tests:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
```

Run frontend tests when test files are available:

```powershell
cd src
npm test
```

Build the desktop bundle:

```powershell
cargo tauri build --manifest-path src-tauri/Cargo.toml
```

## Repository layout

```text
src/                  React + TypeScript frontend
src/App.tsx           Current application shell and Pods view
src/styles.css        Frontend styling
src-tauri/src/main.rs Tauri commands and Kubernetes client calls
src-tauri/             Tauri and Rust configuration
components/, pages/    Frontend extension points
plugins/              Planned plugin area
docs/                 Product and development documentation
tests/                Test area
```

## Backend command flow

The frontend calls Rust commands through `@tauri-apps/api/core`:

```text
React App.tsx
    -> invoke("list_pods", { namespace })
Tauri command
    -> kube::Client::try_default()
Kubernetes API
    -> result returned to React
```

Current commands include:

| Command | Purpose |
| --- | --- |
| `current_context` | Read the active kubeconfig context and namespace |
| `list_kube_contexts` | Enumerate kubeconfig contexts |
| `list_namespaces` | List namespaces visible to the current identity |
| `list_pods` | List pods in a namespace |
| `list_pod_containers` | Read container names from a pod |
| `get_pod_logs` | Fetch bounded logs for a pod/container |
| `list_deployments` | List deployments in a namespace |
| `list_events` | List namespace events |

Keep Kubernetes access in the Rust layer. Do not move credentials or cluster API calls into browser-local storage or frontend-only code.

## Troubleshooting

### `cargo tauri` is not recognized

Install the CLI and restart the terminal:

```powershell
cargo install tauri-cli --version "^2"
```

### The app reports `no kubeconfig`

Check that `%USERPROFILE%\.kube\config` exists and that this works:

```powershell
kubectl config current-context
```

If you use a non-default kubeconfig file, set `KUBECONFIG` before starting tmjLens:

```powershell
$env:KUBECONFIG = "C:\path\to\config"
cargo tauri dev --manifest-path src-tauri/Cargo.toml
```

### Logs or resources return `Forbidden`

This is an expected Kubernetes authorization state. Granting permissions inside tmjLens is not supported. Ask a cluster administrator to verify the identity's RBAC rules, for example:

```powershell
kubectl auth can-i list pods -n <namespace>
kubectl auth can-i get pods/log -n <namespace>
```

### Rust build errors mention Windows linker or WebView2

Install or repair Visual Studio Build Tools with the C++ workload and install the Microsoft WebView2 Runtime, then run the Rust check again.

## Security rules for contributors

- Never commit kubeconfig files, tokens, AWS credentials, or Secret values.
- Keep Secrets hidden by default, including in diagnostics and logs.
- Treat Kubernetes RBAC as the source of truth.
- Do not silently execute delete, apply, restart, exec, or port-forward operations.
- Bound and cancel watches and log streams.
- Treat HTTP 403 responses as user-visible authorization states.
- Do not add telemetry to the MVP.
