# Graph UI development

> **Status:** Canonical contributor entry point
> **Audience:** Frontend contributors and maintainers
> **Last verified:** `0.78.0-alpha.1` / 2026-07-23

The Graph UI is a React/Vite frontend embedded into the V2 npm package. Product
usage starts in the [root README](../README.md); this file covers development
and routes durable design information to the canonical documentation.

## Local validation

```text
cd graph-ui
npm ci
npx tsc --noEmit
npm run build
npm test
```

To validate the complete package with the embedded UI:

```text
cd v2
npm run build:package
```

Run the built local UI through the V2 CLI after indexing a project. Do not use
the Vite development server as evidence that packaged assets or arbitrary-CWD
startup work correctly.

## Dependency and bundle boundary

Import Radix primitives from their direct `@radix-ui/react-*` packages. The
aggregate `radix-ui` entry point is forbidden because a patch release changed
its generated re-export shape and caused Rollup to retain unrelated
primitives. The production build inspects the GraphTab source map and accepts
only packages in the dependency closure of its direct Slot and ScrollArea
roots.

`npm run build` applies multi-pass Terser compression and fails when the graph,
main, CSS, manifest-wide JavaScript, or manifest-wide CSS budgets are exceeded.
It also fails if the aggregate Radix package or an unrelated Radix primitive
appears in GraphTab. Dependency updates must regenerate `package-lock.json`
with the repository's declared npm version and pass both `npm test` and the
production build; do not relax a budget to accept an update.

## Architecture and evidence

- [Current product state](../docs/reference/V2_CURRENT_STATE.md)
- [Graph UI architecture](../docs/architecture/V2_ARCHITECTURE.md#9-graph-ui)
- [Performance and perception lab](../docs/performance/GRAPH_UI_PERFORMANCE_PERCEPTION_LAB.md)
- [R183 visual-intelligence evidence](../docs/performance/reports/R183_GRAPH_UI_VISUAL_INTELLIGENCE_2026-07-23.md)
- [Deep Graph UI audit](../docs/performance/reports/GRAPH_UI_V2_DEEP_AUDIT_2026-07-16.md)
- [Performance, token, and UI audit](../docs/performance/reports/PERFORMANCE_TOKEN_UI_AUDIT_2026-07-15.md)

## Product invariants

- Keep representative overview data distinct from exact search and detail
  results.
- Bind paginated exact reads to the graph snapshot and discard stale pages.
- Preserve one renderer and interaction model across Structure and
  Dependencies views.
- Keep macro-domain signatures deterministic and bounded to two already loaded
  symbols per planned domain. They are previews, not new hit targets or claims
  of exact scope coverage.
- Keep output and simulation budgets explicit; visual density must not silently
  become an unbounded transfer or layout cost.
- Keep UI primitives independently upgradable; do not import a component-suite
  aggregate when a direct primitive package exists.
- Verify keyboard, pointer, touch, reduced-motion, responsive, loading,
  partial, and error states.
- Update the performance lab when a visual or renderer change alters a measured
  contract.

Repository-wide contribution and publication rules are in
[CONTRIBUTING.md](../CONTRIBUTING.md) and the
[documentation portal](../docs/README.md).
