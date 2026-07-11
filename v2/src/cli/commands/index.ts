// v2/src/cli/commands/index.ts
// R68: CLI command for native TypeScript/JavaScript indexing.
//
// Usage:
//   cbm-v2 index --project my-app --root ./src
//   cbm-v2 index --project my-app --root ./src --incremental
//   cbm-v2 index --project my-app --root ./src --dry-run

import { Command } from 'commander';
import { indexProjectWasm } from '../../indexer/indexer.js';
import { resolve } from 'node:path';

export function registerIndexCommand(program: Command): void {
  program
    .command('index')
    .description('Index a project using web-tree-sitter (WASM, 112 languages, no V1 cbm binary needed)')
    .option('--project <name>', 'Project name')
    .option('--root <path>', 'Root directory to index (default: current directory)')
    .option('--incremental', 'Skip files whose content hash has not changed')
    .option('--dry-run', 'Report what would be indexed without writing to DB')
    .option('--allow-partial', 'R82: exit 0 even if some files fail extraction (default: exit 1 on any error)')
    .action(async (opts) => {
      const project = opts.project || deriveProjectName();
      const rootPath = resolve(opts.root || '.');

      console.log(`Codebase Memory V2 — WASM Indexer (R69)`);
      console.log(`==========================================`);
      console.log(`Project: ${project}`);
      console.log(`Root:    ${rootPath}`);
      console.log(`Mode:    ${opts.dryRun ? 'dry-run' : opts.incremental ? 'incremental' : 'full'}`);
      console.log(`Engine:  web-tree-sitter (WASM, 112 languages)`);
      console.log();

      try {
        const result = await indexProjectWasm({
          project,
          rootPath,
          incremental: opts.incremental ?? false,
          dryRun: opts.dryRun ?? false,
          useWasm: true,
        });

        console.log(`Result:`);
        console.log(`  Files indexed:   ${result.files}`);
        console.log(`  Nodes extracted: ${result.nodes}`);
        console.log(`  Edges extracted: ${result.edges}`);
        console.log(`  Files skipped:   ${result.skipped} ${opts.incremental ? '(incremental)' : ''}`);
        console.log(`  Errors:          ${result.errors.length}`);
        console.log(`  Duration:        ${result.durationMs}ms`);
        if (!opts.dryRun) {
          console.log(`  DB:              ${result.dbPath}`);
        }

        if (result.languages && result.languages.size > 0) {
          console.log(`  Languages:       ${[...result.languages].join(', ')}`);
        }
        if (result.parallel) {
          console.log(`  Parallel:        ${result.workerCount} workers`);
        }

        if (result.errors.length > 0) {
          console.log();
          console.log(`Errors (first 10):`);
          for (const err of result.errors.slice(0, 10)) {
            console.log(`  ${err.file}: ${err.error}`);
          }
          if (result.errors.length > 10) {
            console.log(`  ... and ${result.errors.length - 10} more`);
          }
        }

        // R153 (OUTCOME-R153-01): Print warnings BEFORE the success banner so
        // the user sees the diagnostic context first, then the outcome. R152
        // printed "success" before warnings, which could mislead users into
        // thinking the index was clean when broken symlinks were present.
        // The outcome field (R153) drives the banner text:
        //   SUCCESS → "indexed successfully"
        //   SUCCESS_WITH_WARNINGS → "indexed successfully with warnings"
        //   STALE → "indexed but graph is stale"
        //   PARTIAL/FAILED → "indexed with errors"
        // R153 (OUTCOME-R153-02): Dry-run now also shows warnings (previously
        // gated by !opts.dryRun).
        if (result.warnings && result.warnings.total > 0) {
          console.log();
          console.log(`⚠ ${result.warnings.total} discovery warning(s):`);
          for (const [code, count] of Object.entries(result.warnings.countsByCode)) {
            const samplePaths = result.warnings.samples.filter(s => s.code === code).slice(0, 5).map(s => s.path);
            // R153 (OUTCOME-R153-03): Compute "and N more" from the ACTUAL
            // sample count for this code, not from a hardcoded 5. A code with
            // 10 occurrences and 0 samples (path missing) would print
            // "and 5 more" with R152, implying 5 hidden paths when there are
            // actually 10. Now: count - samplePaths.length is the true number.
            const hidden = count - samplePaths.length;
            const moreStr = hidden > 0 ? ` (and ${hidden} more)` : '';
            const samplesStr = samplePaths.length > 0 ? samplePaths.join(', ') : 'no path sample available';
            console.log(`  ${code} (${count}): ${samplesStr}${moreStr}`);
          }
        }

        // R153 (OUTCOME-R153-01): Outcome-driven banner. The outcome field is
        // the authoritative source — the previous `nodes > 0 && errors=0 && !stale`
        // check was implicit and didn't distinguish SUCCESS from SUCCESS_WITH_WARNINGS.
        // R155 (OUTCOME-R155-02): Dry-run banner now depends on outcome. A dry-run
        // with a missing root or fatal discovery shows "Dry-run failed" instead of
        // the misleading "Dry-run complete".
        if (opts.dryRun && result.errors.length > 0) {
          console.log();
          console.log(`⚠ Dry-run failed. ${result.errors.length} error(s). No DB writes.`);
        } else if (opts.dryRun) {
          console.log();
          console.log(`ℹ Dry-run complete. No DB writes.`);
        } else if (result.outcome === 'SUCCESS') {
          console.log();
          console.log(`✓ Project "${project}" indexed successfully.`);
          console.log(`  The code graph is now available for MCP tools, UI, and reports.`);
          console.log(`  Run "cbm-v2 stats --project ${project}" to see the graph.`);
        } else if (result.outcome === 'SUCCESS_WITH_WARNINGS') {
          console.log();
          console.log(`✓ Project "${project}" indexed successfully with warnings.`);
          console.log(`  The code graph is available, but discovery encountered non-blocking issues (see warnings above).`);
          console.log(`  Run "cbm-v2 stats --project ${project}" to see the graph.`);
        } else if (result.outcome === 'STALE') {
          console.log();
          // R156 (OBS-R156-01): show structured staleReason + recovery.
          if (result.staleReason) {
            console.log(`⚠ Project "${project}" graph is stale: ${result.staleReason.message}`);
            if (result.staleReason.paths.length > 0) {
              console.log(`  Affected paths:`);
              for (const p of result.staleReason.paths.slice(0, 10)) {
                console.log(`    - ${p}`);
              }
              if (result.staleReason.paths.length > 10) {
                console.log(`    ... and ${result.staleReason.paths.length - 10} more`);
              }
            }
          } else {
            console.log(`⚠ Cross-file CALLS may be stale.`);
          }
          // R156 (AVAIL-R156-01): recovery recommendation.
          if (result.recovery === 'fix_filesystem') {
            console.log(`  Recovery: fix or remove the broken symlinks listed above, then rerun.`);
          } else if (result.recovery === 'retry_incremental') {
            console.log(`  Recovery: retry when the filesystem is stable.`);
          } else if (result.recovery === 'full_reindex') {
            console.log(`  Run "cbm-v2 index --project ${project} --root ${rootPath}" (full reindex) to rebuild them.`);
          } else {
            console.log(`  Run "cbm-v2 index --project ${project} --root ${rootPath}" (full reindex) to rebuild them.`);
          }
        } else if (result.outcome === 'PARTIAL' || result.outcome === 'FAILED') {
          console.log();
          console.log(`⚠ Project "${project}" indexed with ${result.errors.length} error(s).`);
          // R157 (OBS-R157-01): show staleReason for FAILED/PARTIAL too.
          if (result.staleReason) {
            console.log(`  Stale reason: ${result.staleReason.message}`);
          }
          if (result.crossFileCallsStale) {
            console.log(`⚠ Cross-file CALLS may be stale.`);
            if (result.recovery === 'retry_incremental') {
              console.log(`  Recovery: retry the index.`);
            } else {
              console.log(`  Run "cbm-v2 index --project ${project} --root ${rootPath}" (full reindex) to rebuild them.`);
            }
          }
        } else {
          // R150 (OUTCOME-R150-01): No-op incremental or empty project.
          // outcome is undefined for legacy paths that don't set it — fall
          // back to the old node-count-based heuristic.
          if (!opts.dryRun && result.nodes === 0 && result.errors.length === 0 && !result.crossFileCallsStale) {
            console.log();
            if (result.skipped > 0) {
              console.log(`✓ No changes detected. Existing graph is fresh.`);
            } else {
              console.log(`ℹ No supported source files found in "${rootPath}".`);
            }
          }
        }

        // R82: Bug 22 fix — exit non-zero if ANY extraction errors, unless --allow-partial.
        // R147 (OUTCOME-R147-02): Also exit non-zero when stale without errors
        // (semantics mismatch, partial discovery). A stale graph is NOT fresh —
        // CI should not treat it as valid.
        // R154 (OUTCOME-R154-01): --allow-partial ONLY masks PARTIAL outcomes
        // (extraction errors on some files). It does NOT mask FAILED (root
        // failure, discovery exception, partial discovery lock) or STALE.
        // Previously, --allow-partial would exit 0 for ANY errors>0, including
        // missing root or fatal discovery — masking real failures.
        const allowPartial = (opts as any).allowPartial ?? false;
        if (result.outcome === 'FAILED') {
          // R154: FAILED is always exit 1, even with --allow-partial.
          process.exitCode = 1;
        } else if (result.outcome === 'PARTIAL') {
          // R154: PARTIAL is exit 0 with --allow-partial, exit 1 without.
          process.exitCode = allowPartial ? 0 : 1;
        } else if (result.outcome === 'STALE' || result.crossFileCallsStale) {
          // R147: stale without errors (e.g., semantics mismatch) → exit 2
          // (distinct from 1 = failure, so CI can distinguish).
          // R154: --allow-partial does NOT mask STALE.
          process.exitCode = 2;
        } else if (result.errors.length > 0 && !allowPartial) {
          // R154: legacy fallback for paths that don't set outcome (shouldn't
          // happen after R153, but kept for safety).
          process.exitCode = 1;
        } else {
          process.exitCode = 0;
        }
      } catch (e: unknown) {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
      }
    });
}

function deriveProjectName(): string {
  // Simple: use current directory name
  const cwd = process.cwd();
  return cwd.split('/').pop() || 'unnamed-project';
}
