# R180 R179 forward-reference correction

> **Status:** Historical round report
> **Audience:** Maintainers and benchmark readers
> **Last verified:** `01452c715fac1f92438c38867c59b3cfc34b5d3f` / 2026-07-22

## Outcome

R180 added forward-reading notes from the R178 single-sample token ratio to
the R179 repetition result. The original R178 and R179 measurements, tables,
raw artifacts, and wording remain unchanged. Readers are now told to cite the
R179 approximately 4.28x-5.44x matched range rather than the earlier point
alone.

## Repository-wide citation audit

A fresh ripgrep search covered the full repository while excluding only Git
metadata and dependency directories. It found the requested occurrence in
`BENCHMARK_PROTOCOL.md` section 16.5 and exactly two standalone occurrences
outside that protocol, both in the archived R178 round report. Each now has a
nearby link to section 17 and the repetition range. The R179 aggregate report
already stated both the range and the instability conclusion; no README,
current-state document, or other round summary contained an unqualified
standalone citation.

## Immutable scope

```yaml
round: R180
repository: Cheurteenyt/Ariad
base_sha: ffd5e45b07ac7b98b353ff97e57dfdd40abbd5d9
resolution_sha: ce4b94a9b9463a82d375a1bf55fd9165f4996e5b
ci_validated_head: 01452c715fac1f92438c38867c59b3cfc34b5d3f
pull_request: 76
product_changes: 0
benchmark_runs: 0
```

The resolution diff contains 15 additions and zero deletions across only
`docs/performance/BENCHMARK_PROTOCOL.md` and the archived R178 report. Thus no
historical measured line was deleted or reworded. The later handoff/archive
commits are documentation-only operational records.

## Validation evidence

```text
command: npm run docs:check
working_directory: v2
environment: Windows 11, Node.js v24.15.0, npm 11.12.1
exit_code: 0
result_summary: 7 documentation tests passed; 73 Markdown files checked; 63 reachable; all benchmark questions and reference answers verified
not_run: all benchmark runs and product tests by explicit documentation-only scope
```

```text
command: repository-wide rg with context; git diff --check; git diff --numstat d91a9bc..ce4b94a
working_directory: repository root
environment: Windows 11, ripgrep, Git
exit_code: 0
result_summary: all standalone R178 citations have nearby R179 range links; resolution is additions-only; no measured data or non-documentation path changed
not_run: benchmark, product, runner, task, oracle, package, workflow, and Graph UI changes
```

```text
command: GitHub Actions branch-push CI
working_directory: Cheurteenyt/Ariad@01452c715fac1f92438c38867c59b3cfc34b5d3f
environment: GitHub-hosted Linux and Windows runners
exit_code: 0
result_summary: CI run 29953169132 passed backend, frontend, Windows, package, Docker, and exact-main preflight jobs
not_run: no special benchmark process outside the repository CI invariants
```

PR #76 contains the durable discussion and exact post-merge CI record. The
active handoff was removed before integration, as required by the collaboration
protocol.
