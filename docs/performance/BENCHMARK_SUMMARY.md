# Benchmark summary — what the token investigation found

> **Status:** Canonical synthesis
> **Audience:** Users, contributors, maintainers, and benchmark reviewers
> **Last verified:** `0.78.0-alpha.1` / 2026-07-23

This page is the short, current interpretation of the project's token
benchmarks. It introduces no new measurement. The
[benchmark protocol](BENCHMARK_PROTOCOL.md) and its immutable evidence remain
authoritative when more detail is required.

## The question

The investigation asks a bounded question: for fixed source-navigation tasks,
how do Codebase Memory V2's read-only MCP tools compare with optimized
`grep/read` work under the same model, question, checkout, native token
accounting, and mechanical grading? It does not measure general software
engineering or claim that one route wins for every repository or task
([protocol scope](BENCHMARK_PROTOCOL.md#1-scope-and-claim-boundary)).

## The headline

Against the reproducible official V1, V2 is a substantial improvement. Across
the four matched post-fix aggregate cells, V2 used
[31.4%–43.6% of V1's native tokens](reports/V1_V2_TOKEN_TRUTH_AUDIT_2026-07-20.md#152-beforeafter-and-matched-arm-ratios).
That supports “roughly three times fewer tokens” as a plain-language headline,
not as an exact universal multiplier. V2 also matched or improved task success
and used fewer calls in every matched cell
([engineering-target disposition](reports/V1_V2_TOKEN_TRUTH_AUDIT_2026-07-20.md#16-engineering-target-disposition)).

Against optimized `grep/read`, the answer depends on the task. The broad
post-fix aggregate still cost
[1.334×–1.786× as much](BENCHMARK_PROTOCOL.md#132-exact-post-fix-rerun), while
the graph-oriented tasks below show where a project-controlled MCP capability
can reverse that result.

## What changed by structural task

| Task | Current conclusion |
|---|---|
| T01 — reverse multi-hop callers | **Fixed.** The bounded lookup became exact in every selected cell while calls fell [from 60 to 4 and native tokens from 1,179,045 to 236,935](BENCHMARK_PROTOCOL.md#156-final-bounded-candidate-result). In fresh repetitions, `grep/read` remained more expensive every time, with matched ratios of [4.28×–5.44×](BENCHMARK_PROTOCOL.md#172-result-the-r178-point-is-not-stable). The direction and V2 correctness repeated, but the strict token-stability rule failed; the range is valid, a single stable multiplier is not. |
| T02 — alias-aware type impact | **Fixed.** Before correction, one-shot V2 was [56.33% more expensive](BENCHMARK_PROTOCOL.md#182-baseline-result-and-diagnosis-before-correction). After the bounded `type_dependents` operation, it was about [17% cheaper (`B/C = 0.833754760×`)](BENCHMARK_PROTOCOL.md#183-same-n-correction-result), and V2 improved from [34 PASS / 2 PARTIAL to 36 PASS](BENCHMARK_PROTOCOL.md#183-same-n-correction-result). The supported causal claim is limited to the four range-separated T02 groups. |
| T03 — exhaustive caller absence | **Left unchanged.** V2 and `grep/read` tied on correctness. Repeated traces did not isolate a stable, project-controlled cost mechanism that justified another correction ([diagnosis](benchmarks/t02-t04-structural-cost-root-cause-2026-07-23/diagnosis-before-fix.md#t03t04-do-not-justify-a-second-correction)). |
| T04 — exhaustive callers | **Left unchanged.** V2 and `grep/read` tied on correctness. The cost direction changed with target or session context, so forcing a product change would not have been evidence-based ([diagnosis](benchmarks/t02-t04-structural-cost-root-cause-2026-07-23/diagnosis-before-fix.md#t03t04-do-not-justify-a-second-correction)). |

The practical conclusion is not “always use MCP.” Exact graph operations are
valuable when they collapse repeated discovery into one bounded answer. For
simple source lookups where no such capability exists, focused `grep/read` can
still be cheaper.

## Evidence limits

- The current native comparison covers
  [two pinned repositories](reports/V1_V2_TOKEN_TRUTH_AUDIT_2026-07-20.md#3-fixed-products-targets-and-environment),
  not a broad multilingual repository corpus.
- Codex is the only working measured agent. Gemini CLI was installed, but it
  [never authenticated, so no Gemini run exists](BENCHMARK_PROTOCOL.md#84-second-agent-feasibility-result).
- The task set uses one fixed question per category rather than a broad sampled
  pool. The protocol records that limitation and the untested baselines
  ([pre-registered weaknesses](BENCHMARK_PROTOCOL.md#10-pre-registered-weaknesses));
  the later structural round preserved fixed small- and large-target task
  mappings
  ([small mapping](BENCHMARK_PROTOCOL.md#142-pre-registered-small-target-task-mapping),
  [large mapping](BENCHMARK_PROTOCOL.md#143-pre-registered-large-target-task-mapping)).

These limits prevent a universal token-savings claim. They do not invalidate
the bounded results for the pinned products, repositories, questions, and
environments.

## Why the result is auditable

The benchmark fixed product and target identities, prompts, answers, execution
order, allowed tools, invalid-run handling, grading, accounting, and success
criteria before measurement; result tables were added only after immutable
checkpoints
([truth-round checkpoint contract](reports/V1_V2_TOKEN_TRUTH_AUDIT_2026-07-20.md#12-immutable-checkpoints-and-post-fix-rule)).
Later rounds kept append-once evidence roots and pre-registered repetition and
stability rules before examining the samples
([T01 stability protocol](BENCHMARK_PROTOCOL.md#171-immutable-pre-registration-before-any-repetition),
[T02–T04 mechanism protocol](BENCHMARK_PROTOCOL.md#181-immutable-pre-registration-before-measurement)).
Unfavorable or unstable results were retained rather than rerun away.

## Round lineage

- [R171](../history/round-reports/R171_EXACT_LOOKUP_BENCHMARK.md) corrected the
  exact-lookup comparison and established the compact lookup direction.
- [R177](../history/round-reports/R177_MULTI_HOP_CALLER_CORRECTION.md) fixed and
  bounded T01 multi-hop caller evidence.
- [R178](../history/round-reports/R178_FRESH_BC_MULTIHOP_CONFIRMATION.md)
  performed the fresh V2-versus-`grep/read` T01 confirmation.
- R179 added the repetition/stability evidence now recorded in
  [the canonical stability result](BENCHMARK_PROTOCOL.md#172-result-the-r178-point-is-not-stable);
  [R180](../history/round-reports/R180_R179_FORWARD_REFERENCE.md) corrected the
  repository's forward references to that evidence without changing results.
- [R181](../history/round-reports/R181_STRUCTURAL_COST_ROOT_CAUSE.md) isolated
  the T02 mechanism and recorded the evidence-based no-fix decision for T03 and
  T04.
