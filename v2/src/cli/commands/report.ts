// v2/src/cli/commands/report.ts
// `cbm-v2 report` — risk/coupling/dead-code reports.

import { Command } from 'commander';
import { HumanMemoryStore, defaultHumanDbPath } from '../../human/store.js';
import { CodeGraphReader, defaultCodeDbPath } from '../../bridge/sqlite-ro.js';
import { loadConfig, deriveProjectName } from '../../config.js';
import { computeHotspotsReport, renderHotspotsReportMarkdown } from '../../reports/hotspots.js';
import { computeUndocumentedReport, renderUndocumentedReportMarkdown } from '../../reports/undocumented.js';
import { computeRiskReport, renderRiskReportMarkdown } from '../../reports/risk.js';

/**
 * R41 (N1): wrap the per-action open-compute-close pattern in a single
 * try/finally that ALWAYS closes both handles — even if CodeGraphReader's
 * constructor throws. The previous pattern (open codeReader in a try/catch,
 * then a SEPARATE try/finally for the compute) leaked the HumanMemoryStore
 * handle when codeReader construction failed, because the early `return`
 * jumped over the second try/finally.
 *
 * Returns true if the action ran successfully, false if it failed (caller
 * sets process.exitCode = 1).
 */
function withProjectStores<T>(
  project: string,
  fn: (humanStore: HumanMemoryStore, codeReader: CodeGraphReader | undefined) => T,
): { ok: true; result: T } | { ok: false; error: string } {
  const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
  let codeReader: CodeGraphReader | undefined;
  try {
    try {
      codeReader = new CodeGraphReader(defaultCodeDbPath(project));
    } catch (e: any) {
      // Code graph not available — the report functions all accept an
      // undefined codeReader and degrade gracefully (human-only mode).
      // We DON'T early-return here (that was the leak) — we fall through
      // and let the caller decide via the undefined codeReader.
      codeReader = undefined;
    }
    const result = fn(humanStore, codeReader);
    return { ok: true, result };
  } catch (e: any) {
    return { ok: false, error: e.message };
  } finally {
    humanStore.close();
    codeReader?.close();
  }
}

export function registerReportCommand(program: Command): void {
  const report = program.command('report').description('Risk and coupling reports');

  report
    .command('hotspots')
    .description('List critical modules (high degree + complexity)')
    .option('--project <name>')
    .option('--min-degree <n>', '20')
    .option('--limit <n>', '100')
    .option('--format <fmt>', 'md | json', 'md')
    .action((opts) => {
      loadConfig();
      const project = opts.project || deriveProjectName();
      const outcome = withProjectStores(project, (humanStore, codeReader) => {
        if (!codeReader) {
          throw new Error('code graph not available — run "cbm index_repository" first');
        }
        return computeHotspotsReport(project, codeReader, humanStore, {
          minDegree: (() => { const n = parseInt(opts.minDegree, 10); return Number.isFinite(n) ? n : 20; })(),
          limit: (() => { const n = parseInt(opts.limit, 10); return Number.isFinite(n) ? n : 100; })(),
        });
      });
      if (!outcome.ok) {
        console.error(`Error: ${outcome.error}`);
        process.exitCode = 1;
        return;
      }
      if (opts.format === 'json') {
        console.log(JSON.stringify(outcome.result, null, 2));
      } else {
        console.log(renderHotspotsReportMarkdown(outcome.result));
      }
    });

  report
    .command('undocumented')
    .description('List critical code nodes without human notes')
    .option('--project <name>')
    .option('--format <fmt>', 'md | json', 'md')
    .action((opts) => {
      loadConfig();
      const project = opts.project || deriveProjectName();
      const outcome = withProjectStores(project, (humanStore, codeReader) => {
        if (!codeReader) {
          throw new Error('code graph not available — run "cbm index_repository" first');
        }
        return computeUndocumentedReport(project, codeReader, humanStore);
      });
      if (!outcome.ok) {
        console.error(`Error: ${outcome.error}`);
        process.exitCode = 1;
        return;
      }
      if (opts.format === 'json') {
        console.log(JSON.stringify(outcome.result, null, 2));
      } else {
        console.log(renderUndocumentedReportMarkdown(outcome.result));
      }
    });

  report
    .command('risk')
    .description('Risk report: high coupling, dead code, fragile interfaces')
    .option('--project <name>')
    .option('--limit <n>', '200')
    .option('--format <fmt>', 'md | json', 'md')
    .action((opts) => {
      loadConfig();
      const project = opts.project || deriveProjectName();
      const outcome = withProjectStores(project, (humanStore, codeReader) => {
        if (!codeReader) {
          throw new Error('code graph not available — run "cbm index_repository" first');
        }
        return computeRiskReport(project, codeReader, humanStore, {
          limit: (() => { const n = parseInt(opts.limit, 10); return Number.isFinite(n) ? n : 200; })(),
        });
      });
      if (!outcome.ok) {
        console.error(`Error: ${outcome.error}`);
        process.exitCode = 1;
        return;
      }
      if (opts.format === 'json') {
        console.log(JSON.stringify(outcome.result, null, 2));
      } else {
        console.log(renderRiskReportMarkdown(outcome.result));
      }
    });
}
