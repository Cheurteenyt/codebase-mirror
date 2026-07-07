// v2/src/cli/commands/index.ts
// R68: CLI command for native TypeScript/JavaScript indexing.
//
// Usage:
//   cbm-v2 index --project my-app --root ./src
//   cbm-v2 index --project my-app --root ./src --incremental
//   cbm-v2 index --project my-app --root ./src --dry-run

import { Command } from 'commander';
import { indexProject } from '../../indexer/indexer.js';
import { resolve } from 'node:path';

export function registerIndexCommand(program: Command): void {
  program
    .command('index')
    .description('Index a TypeScript/JavaScript project natively (no V1 cbm binary needed)')
    .option('--project <name>', 'Project name')
    .option('--root <path>', 'Root directory to index (default: current directory)')
    .option('--incremental', 'Skip files whose content hash has not changed')
    .option('--dry-run', 'Report what would be indexed without writing to DB')
    .action((opts) => {
      const project = opts.project || deriveProjectName();
      const rootPath = resolve(opts.root || '.');

      console.log(`Codebase Memory V2 — Native Indexer (R68)`);
      console.log(`==========================================`);
      console.log(`Project: ${project}`);
      console.log(`Root:    ${rootPath}`);
      console.log(`Mode:    ${opts.dryRun ? 'dry-run' : opts.incremental ? 'incremental' : 'full'}`);
      console.log();

      try {
        const result = indexProject({
          project,
          rootPath,
          incremental: opts.incremental ?? false,
          dryRun: opts.dryRun ?? false,
        });

        console.log(`Result:`);
        console.log(`  Files indexed:  ${result.files}`);
        console.log(`  Nodes extracted: ${result.nodes}`);
        console.log(`  Edges extracted: ${result.edges}`);
        console.log(`  Files skipped:   ${result.skipped} ${opts.incremental ? '(incremental)' : ''}`);
        console.log(`  Errors:          ${result.errors.length}`);
        console.log(`  Duration:        ${result.durationMs}ms`);
        console.log(`  DB:              ${result.dbPath}`);

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

        if (!opts.dryRun && result.nodes > 0) {
          console.log();
          console.log(`✓ Project "${project}" indexed successfully.`);
          console.log(`  The code graph is now available for MCP tools, UI, and reports.`);
          console.log(`  Run "cbm-v2 stats --project ${project}" to see the graph.`);
        }

        process.exitCode = result.errors.length > 0 && result.nodes === 0 ? 1 : 0;
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
