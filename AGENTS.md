# Agent instructions for tmjLens

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Its engineering rules, setup, layout,
and validation commands apply to you exactly as they apply to a human contributor.
This file only adds what is specific to working here as an agent.

## Before deciding anything architectural

Read [docs/ROADMAP.md](docs/ROADMAP.md) for where the project is going, and
`src-tauri/src/cluster.rs` for how the overview pipeline is actually built — it is the
reference for how a subsystem in this codebase is expected to look.

## Non-negotiables

The rules in CONTRIBUTING are not suggestions to weigh against convenience. In
particular, do not:

- introduce a client-side permission model, or hide a `403` instead of surfacing it;
- add a filesystem, shell, or network permission to `capabilities/default.json` when a
  narrow Rust command would do;
- render a zero, an empty list, or a neutral state where the real answer is "this
  could not be collected";
- add telemetry, analytics, or crash reporting.

## Verify, do not assume

- Run `cargo test`, `npm run build`, and `npm run test:e2e` before reporting done.
- For UI work, actually render it. `npm run dev` plus `/preview.html` needs no cluster,
  and the fixtures already cover the awkward states. Screenshot it and look at it.
- When you fix a bug, prove the regression test catches it by breaking the fix on
  purpose and watching the test fail.
- Report what actually happened. If a step was skipped or a test failed, say so.

## Data hygiene

This is a public repository. Never commit real cluster data — no real pod, node,
namespace, cluster, or account identifiers, in fixtures, tests, comments, or
screenshots. Invent names.

## Style

Match the surrounding code. Comments are sparse and explain *why*, not *what* — the
existing ones exist because the reasoning was not recoverable from the code alone.
Prefer small typed service interfaces between React and Rust.
