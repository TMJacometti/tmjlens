<div align="center">

# 🦈 tmjLens

**A Kubernetes operations console that tells you what is wrong — not just what exists.**

Install it with Helm. Sign in with Azure AD. It runs in the cluster it manages —
one instance, one cluster, shared over Ingress.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-in--cluster%20web-lightgrey)
![Status](https://img.shields.io/badge/status-v0.5-blue)

</div>

![tmjLens cluster overview](docs/images/cluster-overview.png)

---

You need **Helm**, **kubectl**, and an **Azure AD** app. You do not need this
repository, Rust, Node, or a development machine. Helm pulls the chart and the
image from GHCR; the only file you write is values.

## What it does

Health score with evidence, capacity the way the scheduler sees it (requests,
not live usage), workloads, logs, rollout restart, network, storage,
configuration, namespaces, Helm, Velero, Argo, reports.

If something could not be collected, the overview says so instead of showing a
quiet zero.

## Who may do what

The pod's ServiceAccount is `cluster-admin` so the console can act. Who may use
each action is decided after Azure AD login, by three fixed profiles:

| Profile | Who gets it | Can |
|---|---|---|
| **Admin** | The email in `bootstrapAdmin` | Everything, including Access (users and grants) |
| **Developer** | Granted later by an admin | Cluster Overview, workloads, pod logs, rollout restart |
| **Guest** | Everyone else's first sign-in | Cluster Overview only |

Developer cannot scale, delete a deploy, or port-forward. Nodes, Reports, Cloud
and Plugins stay off that nav.

Settings → Clusters is read-only. Cluster name and environment are set at
install and cannot be changed in the UI.

## Install

### 1. Azure AD app

Register a **Web** application. Redirect URI:

```text
https://tmjlens.example.com/auth/callback
```

Use the same host as `ingress.host` below. Allow `openid`, `profile` and
`email`. Copy tenant id, client id and client secret into the values file.

If you are not using Ingress yet, set `azure.redirectUrl` to the URL that
actually reaches `/auth/callback`.

### 2. Values file

On the machine that runs Helm, save this as `values.install.yaml` and replace
every field. Do not commit it — it holds the Azure secret.

```yaml
image:
  repository: ghcr.io/tmjacometti/tmjlens
  tag: "0.5.1"
  pullPolicy: IfNotPresent

environment:
  cluster: prod-shark          # label shown in the UI
  type: production             # must be exactly: production | staging | development

# Case does not matter. ADMIN@EMPRESA.COM.BR still matches.
bootstrapAdmin: admin@tmjsistemas.com.br

azure:
  tenantId: "00000000-0000-0000-0000-000000000000"
  clientId: "00000000-0000-0000-0000-000000000000"
  clientSecret: "replace-me"
  redirectUrl: ""              # empty → https://<ingress.host>/auth/callback

service:
  type: ClusterIP
  port: 80

ingress:
  enabled: true
  className: nginx
  host: tmjlens.example.com
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
  tls:
    - secretName: tmjlens-tls
      hosts:
        - tmjlens.example.com

persistence:
  enabled: true
  size: 1Gi
```

`environment.type` must be one of those three words. `prd`, `hml` and `dev`
are rejected.

The cluster needs a default StorageClass (for the 1Gi disk) and, if Ingress is
on, an ingress controller and a TLS secret named `tmjlens-tls` in the
`tmjlens` namespace — or drop the `tls:` block until you have a certificate.

### 3. Helm

A tag `web-0.5.1` publishes the image and the chart. Install that version:

```bash
helm upgrade --install tmjlens oci://ghcr.io/tmjacometti/tmjlens-chart \
  --version 0.5.1 \
  -n tmjlens --create-namespace \
  -f values.install.yaml
```

If the OCI registry still asks for login, use the GitHub Release asset (always
public, same file):

```bash
helm upgrade --install tmjlens \
  https://github.com/TMJacometti/tmjlens/releases/download/web-0.5.1/tmjlens-chart-0.5.1.tgz \
  -n tmjlens --create-namespace \
  -f values.install.yaml
```

```bash
helm show values oci://ghcr.io/tmjacometti/tmjlens-chart --version 0.5.1
```

### 4. What you get

In namespace `tmjlens`:

| Resource | Notes |
|---|---|
| Deployment, **1 replica** | Do not scale. The database is a file on the disk; login sessions live in that one process. |
| PVC 1Gi | Survives pod restarts. `helm uninstall` deletes it. |
| Service port 80 (`http`) | Target for Ingress |
| Ingress | `https://tmjlens.example.com` |
| Secret | Azure credentials |
| ServiceAccount + `cluster-admin` | The ceiling. Profiles are the gate. |

Without Ingress:

```bash
kubectl -n tmjlens port-forward svc/tmjlens 8080:80
```

Then set `azure.redirectUrl` to whatever URL the browser uses for
`/auth/callback` (for port-forward, that is not the in-cluster Service DNS).

### 5. First login

Open the host and sign in with Azure AD.

- `bootstrapAdmin` becomes **admin** (case and spaces around the address are ignored).
- Everyone else starts as **guest**. An admin promotes people under Access.

## Security

- Azure AD is the only login. There is no password stored in tmjLens.
- The UI never grants access. A denied action is a visible `403`.
- Destructive actions ask for confirmation.
- Secret values stay hidden by default.
- No telemetry.
- One replica only.

This is a `0.5` MVP. It has not had an independent security review. Treat it
accordingly on clusters that matter.

## License

Copyright © 2026 Thiago Mattar Jacometti.

Licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).

If you run a modified tmjLens as a network service, you must publish that
source under the same license.

Commercial licensing on different terms is available from the copyright holder.

---

To **clone this repository and change the code**, read
[CONTRIBUTING.md](CONTRIBUTING.md) first. That is the development setup (Rust,
Node, tests). This README is only the Helm install.
