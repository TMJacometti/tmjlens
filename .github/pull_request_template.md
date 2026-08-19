## What this changes

<!-- One or two sentences. What problem does this solve? -->

## How it was verified

<!-- Delete what does not apply. Say what you actually ran, not what should pass. -->

- [ ] `cd src-tauri && cargo test`
- [ ] `cd src && npm run build`
- [ ] `cd src && npm run test:e2e`
- [ ] Rendered the affected UI (`npm run dev` → `/preview.html`) and looked at it
- [ ] Ran it against a real cluster

## Checklist

- [ ] No credentials, tokens, or Secret values are stored or logged
- [ ] Kubernetes RBAC remains authoritative; no client-side permission model
- [ ] Destructive actions still require explicit confirmation
- [ ] No real cluster data in fixtures, tests, comments, or screenshots
- [ ] No new webview permission in `capabilities/default.json`
- [ ] Missing or denied data is reported as such, not rendered as a zero

<!--
By contributing you agree your contribution is licensed under the AGPL-3.0,
the same license as this project.
-->
