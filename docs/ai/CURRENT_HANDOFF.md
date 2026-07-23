# Implementation Handoff

## Cycle metadata

```yaml
schema_version: 1
kind: implementation-handoff
round: R183
status: ACTIVE
repository: Cheurteenyt/Ariad
branch: v2/r183-graph-visual-intelligence
base_sha: b6a95f23ca34ba1a141c943f1be0b045be23b9dd
last_completed_code_sha: 56ae321d9ef1d92e7ee078c21d86e7c54cb5d808
active_audit: NONE
active_audit_blob_oid: NONE
updated_at_utc: 2026-07-23T12:56:32Z
implementer_role: codex
```

## Contracts and non-goals

### Contracts that must remain true

- Product/version contract: improve the graph interior without changing the
  package version or claiming evidence that has not been measured.
- Data-format contract: preserve existing backend graph payloads unless a
  measured frontend limitation proves that a bounded, backward-compatible
  contract extension is necessary.
- Security or durability contract: preserve localhost origin, CSRF, WebSocket,
  project-isolation, path, and bounded-shutdown protections.
- Compatibility contract: keep Windows and Linux support, reduced-motion and
  keyboard behavior, deterministic rendering, packaging, and embedded Graph UI
  startup intact.
- Evidence contract: compare official V1 and current V2 on fixed targets,
  viewports, tasks, and fixtures; retain unfavorable results.
- Documentation contract: define Stellar, aggregation, semantic zoom, and the
  navigation path from architecture overview to exact code evidence.

### Explicit non-goals

- A cosmetic V1 skin or mode without task evidence.
- Decorative counters, panels, motion, or labels without a concrete
  code-navigation purpose.
- New token, accuracy, or performance claims derived from uncontrolled runs.
- Weakening budgets, timeouts, tests, or error handling to obtain green checks.

## Audit decisions

No external audit is active. R183 is an owner-directed, evidence-first product
round. Findings below are provisional until the matched baseline is committed.

| Finding | Source | Decision | Evidence or reason | Resolution code commit | Regression test | CI-validated head | Validation state |
|---------|--------|----------|--------------------|------------------------|-----------------|-------------------|------------------|
| R183-E01 | owner objective | IMPLEMENTED | Lab v2 produced strict matched 38-node/84-edge five-run Architecture and Stellar comparisons. A separate 65-node/136-edge perception fixture supported the anonymous task sheet without being misrepresented as performance evidence. | `0e0c4ac694393c2bc0d8ed73c0801e30533fad6c` | evidence harness and perception fixture | pending | LOCAL_PASS |
| R183-E02 | owner objective | IMPLEMENTED | The task review found that V2 won exact-search and directed-flow work but its fitted macro domains were visually hollow. Structure and Dependencies now show at most two deterministic semantic signatures per domain plus a hidden-count disclosure, with a bounded fade before exact topology. | `0e0c4ac694393c2bc0d8ed73c0801e30533fad6c` | `graph-domain-preview.test.ts`; `GraphCanvas.test.tsx` | pending | LOCAL_PASS |
| R183-E03 | owner objective | IMPLEMENTED | Empty, disconnected, dense, filtered, exact, pointer, keyboard, touch, reduced-motion, oversized, and narrow macro states pass the complete 237-test Graph UI suite. Backend typecheck/build, embedded package, browser smoke, and documentation checks pass locally. | `56ae321d9ef1d92e7ee078c21d86e7c54cb5d808` | existing Graph UI state matrix, bounded perception fixture, and narrow macro-fit regression | pending | LOCAL_PASS |
| R183-E04 | local reproduction | IMPLEMENTED | The comparison lab selected the first V1 card whose broad ancestor contained the target name, so the 38-node API preflight could be paired with a rendered 4,287-node project. Captures were also taken after the FPS pan/zoom. The lab now selects a card-local exact heading, verifies the rendered layout URL and complete topology, records that identity, and captures the settled pre-interaction frame. | `d54b6ac6472a42f4f445c74b3251a4df1978551e` | `v2/tests/benchmark/graph-ui-lab.test.ts` | pending | LOCAL_PASS |
| R183-E05 | packaged browser smoke | IMPLEMENTED | The packaged smoke requested keyboard node traversal immediately after opening the exact dependency atlas. The product correctly announced that symbols require domain drill-down or semantic zoom, so the stale smoke failed on a valid large project. It now follows that explicit prompt with bounded Zoom-in actions before requiring a node, while other missing-target states still fail closed. | `b8a349e3f06a4ec237af18cf9908d1ceaec10625` | `v2/tests/benchmark/graph-ui-browser-smoke.test.ts` plus packaged Edge smoke | pending | LOCAL_PASS |
| R183-E06 | responsive browser validation | IMPLEMENTED | At 380 CSS pixels, Fit computed complete macro bounds but clamped scale to 0.1, clipping the outer Structure domains. One shared 0.02 camera floor now applies to fit, wheel, pinch, controls, and keyboard zoom; the narrow product frame contains all domains and preserves manual zoom-in. | `56ae321d9ef1d92e7ee078c21d86e7c54cb5d808` | narrow 6,400-world-unit GraphCanvas fit regression plus visible packaged check | pending | LOCAL_PASS |

## Pushed checkpoints

| Code SHA | CI head SHA | Findings | Summary | Local validation | GitHub run |
|----------|-------------|----------|---------|------------------|------------|
| `b6a95f23ca34ba1a141c943f1be0b045be23b9dd` | pending | R183-E01–E03 | baseline and round contracts | repository identity and worktree inspected | pending |
| `d54b6ac6472a42f4f445c74b3251a4df1978551e` | pending | R183-E01, R183-E04 | fail-closed rendered graph identity and pre-interaction blind captures | targeted Vitest 9/9; backend/lab typecheck; 38-node strict browser smoke | pending |
| `0e0c4ac694393c2bc0d8ed73c0801e30533fad6c` | pending | R183-E01-E03 | bounded macro-domain intelligence and a controlled multi-domain perception fixture | Graph UI 236/236; targeted preview 65/65; frontend and backend/lab typecheck; frontend build/budgets; strict five-run Architecture and Stellar comparison candidates | pending |
| `b8a349e3f06a4ec237af18cf9908d1ceaec10625` | pending | R183-E05 | packaged browser smoke follows the exact dependency-atlas disclosure contract | targeted backend 10/10; backend/lab typecheck; packaged Edge smoke on 1,000-node project with no console, page, or HTTP errors | pending |
| `56ae321d9ef1d92e7ee078c21d86e7c54cb5d808` | pending | R183-E06 | narrow macro Fit no longer clips complete domain bounds | targeted Graph UI 66/66; complete Graph UI 237/237; frontend typecheck/build; embedded package build; narrow visible check; packaged smoke | pending |

## Exact validation evidence

```text
command: npx vitest run tests/benchmark/graph-ui-lab.test.ts
working_directory: v2
environment: Windows 11 / PowerShell / Node runtime from repository
exit_code: 0
result_summary: 1 file and 9 tests passed, including stale rendered-project and rendered-topology rejection.

command: npm run typecheck
working_directory: v2
environment: Windows 11 / PowerShell / Node runtime from repository
exit_code: 0
result_summary: Backend and Graph UI lab TypeScript configurations passed.

command: npm run bench:graph-ui:compare -- --project graph-ui-lab-controlled --runs 1 --max-nodes 1000 --v2-mode architecture --output ../.codex-runtime/graph-ui-lab/r183-fixed-smoke-v2
working_directory: v2
environment: Windows 11 / Edge / V1 345425a / V2 d54b6ac / 1440x960 DPR 1
exit_code: 0
result_summary: Strict rendered identity passed for both variants at 38 nodes / 84 edges; evidence grade exploratory because this was a one-run smoke.

command: npm run bench:graph-ui:compare -- --project graph-ui-lab-controlled --runs 5 --max-nodes 1000 --v2-mode architecture --output ../.codex-runtime/graph-ui-lab/r183-postchange-architecture
working_directory: v2
environment: Windows 11 / Edge / V1 345425a / V2 0e0c4ac / 1440x960 DPR 1
exit_code: 0
result_summary: comparison-candidate; strict rendered identity 38/84; cold V2 first-useful p50/p95 407.7/425.7 ms versus V1 3864.5/4123.1 ms; both 165 FPS p50; V2 long-task p95 0 ms and idle CPU p50 0.02%.

command: npm run bench:graph-ui:compare -- --project graph-ui-lab-controlled --runs 5 --max-nodes 1000 --v2-mode stellar --output ../.codex-runtime/graph-ui-lab/r183-postchange-stellar
working_directory: v2
environment: Windows 11 / Edge / V1 345425a / V2 0e0c4ac / 1440x960 DPR 1
exit_code: 0
result_summary: comparison-candidate; strict rendered identity 38/84; cold V2 first-useful p50/p95 403.4/409.5 ms versus V1 3832.7/3935.8 ms; both 165 FPS p50; V2 long-task p95 0 ms and idle CPU p50 0.02%.

command: npm test
working_directory: graph-ui
environment: Windows 11 / Node runtime from repository
exit_code: 0
result_summary: 26 files and 236 tests passed, including the complete graph state matrix.

command: npx tsc --noEmit && npm run build
working_directory: graph-ui
environment: Windows 11 / Node runtime from repository
exit_code: 0
result_summary: Frontend typecheck and production build passed; Graph chunk 38.65 KiB, main 69.30 KiB, CSS 14.91 KiB, manifest JS 122.75 KiB, Radix packages 11.

command: npm run typecheck
working_directory: v2
environment: Windows 11 / Node runtime from repository
exit_code: 0
result_summary: Backend and Graph UI lab TypeScript configurations passed after the implementation.

command: npx vitest run tests/benchmark/graph-ui-browser-smoke.test.ts tests/benchmark/graph-ui-lab.test.ts
working_directory: v2
environment: Windows 11 / Node runtime from repository
exit_code: 0
result_summary: 2 files and 10 tests passed, including dependency-atlas zoom handoff and fail-closed identity checks.

command: npm run smoke:graph-ui:browser -- --project codebase-mirror --base-url http://127.0.0.1:9749
working_directory: v2
environment: Windows 11 / Edge 150.0.4078.83 / packaged Graph UI / 1,000-node representative frame
exit_code: 0
result_summary: Structure, exact dependency-atlas zoom, keyboard node traversal, semantic-depth focus, Structure restore, and Fit passed with zero console, page, or failed-HTTP errors.

command: npm run docs:check
working_directory: v2
environment: Windows 11 / Node runtime from repository
exit_code: 0
result_summary: 92 Markdown files valid, 27 active, 82 reachable; links, anchors, metadata, and structural reference answers passed.

command: npm run build && npm run build:package
working_directory: v2
environment: Windows 11 / Node runtime from repository
exit_code: 0
result_summary: Backend compiled; locked Graph UI install audited 0 vulnerabilities; unchanged bundle budgets passed; embedded assets were copied and verified.

command: npm test
working_directory: graph-ui
environment: Windows 11 / Node runtime from repository
exit_code: 0
result_summary: 26 files and 237 tests passed after adding the narrow macro-fit regression.

command: npm run build:package && npm run smoke:graph-ui:browser -- --project codebase-mirror --base-url http://127.0.0.1:9749
working_directory: v2
environment: Windows 11 / Edge 150.0.4078.83 / packaged Graph UI
exit_code: 0
result_summary: Final responsive Graph UI assets remained within budgets and the 1,000-node packaged workflow passed with zero browser errors.
not_run: Publication gates, remote CI, and exact-main validation.
```

## Reset recovery

```bash
REPOSITORY=https://github.com/Cheurteenyt/Ariad.git
WORK_BRANCH=v2/r183-graph-visual-intelligence

git clone --single-branch --branch "$WORK_BRANCH" "$REPOSITORY" Ariad
cd Ariad
git fetch origin main "$WORK_BRANCH"
test "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$WORK_BRANCH")"
git status --short --branch
git merge-base --is-ancestor b6a95f23ca34ba1a141c943f1be0b045be23b9dd HEAD

cd graph-ui
npm ci
```

### First smoke command after reset

```bash
cd graph-ui
npx tsc --noEmit
```

## Current working state

- **Last completed finding:** R183-E06 removed the stale 0.1 camera floor that
  clipped complete macro-domain bounds at 380 CSS pixels and validated the
  corrected packaged frame.
- **Current finding:** Publish the final candidate, verify exact-head CI and
  CodeQL, merge, delete the work branch, and validate the resulting main SHA.
- **Dirty files expected:** two pre-existing CRLF status markers with
  byte-identical index/worktree blobs; never stage them.
- **Unpushed commits expected:** the responsive evidence documentation and this
  handoff checkpoint until the final candidate push.
- **Known blocker:** None.
- **Single next action:** Push the final candidate head and monitor every
  required GitHub check before merge.

## Security confirmation

- [x] No private key, token, secret path, or runner address is present.
- [x] The implementation agent has no GitLab mirror credential.
- [x] No ephemeral GitHub key was replaced in this round.
- [x] No SSH host-trust change was performed in this round.

## Pre-final-audit checklist

- [x] Every finding has a decision and evidence.
- [ ] Every accepted finding has a pushed resolution commit.
- [x] Regression tests fail if their corrections are reverted.
- [x] The full affordable local suite is recorded above.
- [ ] GitHub Actions is green on the candidate SHA.
- [ ] No important work exists only in the current environment.
- [ ] The handoff is ready to archive under `docs/history/round-reports/`.
