# Active AI Work Area

> **Status:** Canonical reset-recovery entry point
> **Audience:** Maintainers and external AI collaborators
> **Last verified:** `0.78.0-alpha.1` / 2026-07-20

This directory is intentionally idle on `main`.

During one active `v2/r<n>-<short-name>` round, the implementation agent
creates and commits:

- `CURRENT_HANDOFF.md`, copied from
  `../templates/GLM_HANDOFF_TEMPLATE.md`;
- `audits/<round>/AUDIT-<sequence>-<short-sha>.md`, copied verbatim from an
  external read-only audit based on
  `../templates/AI_AUDIT_REPORT_TEMPLATE.md`.

`CURRENT_HANDOFF.md` is updated and pushed with every implementation
checkpoint. Imported audit reports remain immutable.

Before squash merge, archive the completed handoff under
`docs/history/round-reports/` and remove `CURRENT_HANDOFF.md`. This keeps
`main` free of stale active-state claims while retaining the round history.

See [AI Collaboration and Reset-Recovery Protocol](../operations/AI_COLLABORATION_PROTOCOL.md)
for the authority order, reset procedure, SSH boundaries, and final gate.
