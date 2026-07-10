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
        console.log(`  DB:              ${result.dbPath}`);

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

        // R147 (OUTCOME-R147-01): Success banner ONLY when errors=0 AND stale=false.
        // R146 printed "indexed successfully" if result.nodes > 0, even with
        // errors and stale=true — misleading for CI and users.
        // R149 (OUTCOME-R149-01): Stale/errors warning must NOT depend on
        // result.nodes > 0. R148 gated the warning inside `else if nodes > 0`,
        // so a no-op stale (nodes=0) or a full-abort (nodes=0) would exit
        // non-zero without explaining why. Now the warning is always printed
        // when stale or errors exist, regardless of node count.
        if (!opts.dryRun && result.nodes > 0 && result.errors.length === 0 && !result.crossFileCallsStale) {
          console.log();
          console.log(`✓ Project "${project}" indexed successfully.`);
          console.log(`  The code graph is now available for MCP tools, UI, and reports.`);
          console.log(`  Run "cbm-v2 stats --project ${project}" to see the graph.`);
        } else if (!opts.dryRun) {
          // R149: Always print outcome when not fresh success.
          console.log();
          if (result.errors.length > 0) {
            console.log(`⚠ Project "${project}" indexed with ${result.errors.length} error(s).`);
          }
          if (result.crossFileCallsStale) {
            console.log(`⚠ Cross-file CALLS may be stale.`);
            console.log(`  Run "cbm-v2 index --project ${project} --root ${rootPath}" (full reindex) to rebuild them.`);
          }
          if (result.errors.length === 0 && !result.crossFileCallsStale && result.nodes === 0) {
            // R150 (OUTCOME-R150-01): R149 incorrectly printed "0 source
            // files" for a no-op incremental (nodes=0 means 0 nodes
            // PRODUCED in this run, not 0 files in the project). A no-op
            // incremental on a 50k-node project would say "0 source files".
            // Now we distinguish:
            // - skipped > 0 → "No changes detected" (no-op incremental)
            // - skipped = 0 → "No supported source files found" (empty project)
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
        const allowPartial = (opts as any).allowPartial ?? false;
        if (result.errors.length > 0 && !allowPartial) {
          process.exitCode = 1;
        } else if (result.crossFileCallsStale && !allowPartial) {
          // R147: stale without errors (e.g., semantics mismatch) → exit 2
          // (distinct from 1 = failure, so CI can distinguish).
          process.exitCode = 2;
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
