# Codebase Memory documentation

> **Status:** Canonical documentation portal
> **Audience:** Users, integrators, contributors, maintainers, and auditors
> **Last verified:** `0.78.0-alpha.1` / 2026-07-23

This page is the only documentation entry point. It separates current product
contracts from measured evidence and historical records so an old audit cannot
silently override current behavior.

## Start here

| Need | Canonical source |
|---|---|
| Install and use the project | [Root README](../README.md) |
| Understand project lineage and attribution | [Lineage and attribution](../README.md#lineage-and-attribution) |
| Understand what is active now | [V2 current state](reference/V2_CURRENT_STATE.md) |
| Understand the token benchmark conclusion | [Benchmark summary](performance/BENCHMARK_SUMMARY.md) |
| Understand the system | [V2 architecture](architecture/V2_ARCHITECTURE.md) |
| Use the CLI | [CLI reference](reference/CLI_REFERENCE.md) |
| Integrate the MCP server | [MCP tools reference](reference/MCP_TOOLS.md) |
| Develop the Graph UI | [Graph UI contributor guide](../graph-ui/README.md) |
| Contribute changes | [Contributing guide](../CONTRIBUTING.md) |
| Maintain or release the project | [Maintainers guide](../MAINTAINERS_GUIDE.md) |
| Read the latest native token evidence | [V1/V2 token truth audit](performance/reports/V1_V2_TOKEN_TRUTH_AUDIT_2026-07-20.md) |

## Canonical documentation

Canonical documents describe current behavior or an actively enforced
contract. Package versions, dependency versions, test counts, and runtime
constants must point to their executable source of truth instead of being
copied into several documents.

### Reference

| Document | Authority |
|---|---|
| [V2 current state](reference/V2_CURRENT_STATE.md) | Concise active capabilities, limitations, and priorities |
| [CLI reference](reference/CLI_REFERENCE.md) | Commands, options, and exit behavior |
| [MCP tools reference](reference/MCP_TOOLS.md) | The eight tool contracts and routing guidance |
| [Intelligence layer](reference/INTELLIGENCE.md) | Freshness, graph status, and context preparation |
| [Obsidian integration](reference/OBSIDIAN_INTEGRATION.md) | Vault format and synchronization behavior |
| [Human memory graph schema](reference/HUMAN_MEMORY_GRAPH_SCHEMA.md) | Human-memory database model |

### Architecture

| Document | Authority |
|---|---|
| [V2 architecture](architecture/V2_ARCHITECTURE.md) | Current components, data flow, indexing, MCP, UI, packaging, and boundaries |
| [Atomic generation publication](architecture/ATOMIC_GENERATION_PUBLICATION.md) | Merged but inactive generation-store foundation and activation gates |

### Operations

| Document | Authority |
|---|---|
| [Repository governance](operations/REPOSITORY_GOVERNANCE.md) | GitHub settings, rulesets, authorization, and security controls |
| [Release policy](operations/RELEASE_POLICY.md) | Versioning, releases, and publication gates |
| [GitHub to GitLab bridge](operations/GITHUB_GITLAB_BRANCH_BRIDGE.md) | Canonical repository and passive mirror contract |
| [CI continuity](operations/CI_CONTINUITY.md) | Degraded-CI response and disaster-recovery exercises |
| [Actions storage policy](operations/GITHUB_ACTIONS_STORAGE_POLICY.md) | Retention, quotas, and bounded cleanup |
| [Restricted Git transport](operations/RESTRICTED_ENVIRONMENT_GIT_TRANSPORT.md) | Safe transport in environments without native OpenSSH |
| [AI collaboration protocol](operations/AI_COLLABORATION_PROTOCOL.md) | External audits, handoffs, checkpoints, and reset recovery |
| [GLM GitHub operations](operations/GLM_GITHUB_OPERATIONS.md) | Narrow GLM-specific checkpoint and review workflow |

### Performance and token evidence

| Document | Status |
|---|---|
| [Benchmark summary](performance/BENCHMARK_SUMMARY.md) | Canonical plain-language conclusion and evidence limits |
| [Benchmark protocol](performance/BENCHMARK_PROTOCOL.md) | Canonical task, grading, and native-accounting protocol |
| [Token economy](performance/TOKEN_ECONOMY.md) | Current claim boundaries plus clearly labeled historical estimates |
| [Graph UI performance lab](performance/GRAPH_UI_PERFORMANCE_PERCEPTION_LAB.md) | Reproducible UI performance and perception methodology |
| [V1/V2 token truth audit](performance/reports/V1_V2_TOKEN_TRUTH_AUDIT_2026-07-20.md) | Immutable current native-token evidence |
| [R183 Graph UI visual intelligence](performance/reports/R183_GRAPH_UI_VISUAL_INTELLIGENCE_2026-07-23.md) | Current matched runtime, blind task, root-cause, and bounded-rendering evidence |
| [Graph UI deep audit](performance/reports/GRAPH_UI_V2_DEEP_AUDIT_2026-07-16.md) | Dated UI fidelity and performance evidence |
| [Performance, token, and UI audit](performance/reports/PERFORMANCE_TOKEN_UI_AUDIT_2026-07-15.md) | Dated transport and UI evidence |
| [Committed benchmark artifacts](performance/benchmarks/) | Selected tables and raw-artifact checksum manifests |

Reports are evidence, not living product specifications. When a report and a
canonical reference differ, the report remains historically accurate for its
pinned revision while the canonical reference governs current behavior.

## Historical records

[The historical index](history/README.md) contains superseded audits,
benchmarks, roadmaps, implementation reports, architecture drafts, and archived
changelog entries. Files under `docs/history/` must not be used as current
product instructions unless a canonical document explicitly cites a pinned
finding.

Templates and reset-recovery material live in the
[AI handoff guide](ai/README.md),
[audit report template](templates/AI_AUDIT_REPORT_TEMPLATE.md), and
[GLM handoff template](templates/GLM_HANDOFF_TEMPLATE.md). They support the
operational protocol; they are not product references.

## Documentation lifecycle

Every active document must declare three fields near its title:

- **Status:** `Canonical`, `Reference`, or `Evidence report`;
- **Audience:** the people or agents expected to use it;
- **Last verified:** a package version or exact revision and date.

Use these rules when changing documentation:

1. Update the existing canonical source instead of creating another current
   overview.
2. Put immutable measurement output in `performance/reports/` and large raw
   evidence outside the repository; commit only bounded tables and checksums.
3. Move superseded material to `history/` with links to its replacement.
4. Delete a document only when it is fully duplicated and Git history is a
   sufficient record. Never discard unique audit evidence.
5. Keep the root README concise and route detail through this portal.
6. Do not copy versions, test counts, tool counts, performance claims, or open
   limitations without naming their executable or measured source of truth.
7. Run `npm run docs:check` from `v2/` before committing.

The documentation validator rejects broken local links, missing anchors,
unclassified active documents, unexpected Markdown files at the root of
`docs/`, and canonical documents that are unreachable from this portal.
