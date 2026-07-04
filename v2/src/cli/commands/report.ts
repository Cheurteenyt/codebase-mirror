// v2/src/cli/commands/report.ts

import { Command } from 'commander';
import { HumanMemoryStore, defaultHumanDbPath } from '../../human/store.js';
import { CodeGraphReader, defaultCodeDbPath } from '../../bridge/sqlite-ro.js';
import { computeHotspotsReport, renderHotspotsReportMarkdown } from '../../reports/hotspots.js';
import { computeUndocumentedReport, renderUndocumentedReportMarkdown } from '../../reports/undocumented.js';
import { computeRiskReport, renderRiskReportMarkdown } from '../../reports/risk.js';
import { deriveProjectName } from '../../config.js';

export function registerReportCommand(program: Command): void {
  const report = program.command('report').description('Generate reports about code + human memory');

  report
    .command('hotspots')
    .description('List critical modules (high degree + complexity)')
    .option('--project <name>')
    .option('--min-degree <n>', '20')
    .option('--limit <n>', '100')
    .option('--format <fmt>', 'md | json', 'md')
    .action((opts) => {
      const project = opts.project || deriveProjectName();
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      let codeReader: CodeGraphReader | undefined;
      try {
        codeReader = new CodeGraphReader(defaultCodeDbPath(project));
      } catch (e: any) {
        console.error(`Error: code graph not available — ${e.message}`);
        process.exitCode = 1;
        return;
      }
      try {
        const rep = computeHotspotsReport(project, codeReader, humanStore, {
          minDegree: (() => { const n = parseInt(opts.minDegree, 10); return Number.isFinite(n) ? n : 20; })(),
          limit: (() => { const n = parseInt(opts.limit, 10); return Number.isFinite(n) ? n : 100; })(),
        });
        if (opts.format === 'json') {
          console.log(JSON.stringify(rep, null, 2));
        } else {
          console.log(renderHotspotsReportMarkdown(rep));
        }
      } finally {
        humanStore.close();
        codeReader?.close();
      }
    });

  report
    .command('undocumented')
    .description('List critical code nodes without human notes')
    .option('--project <name>')
    .option('--format <fmt>', 'md | json', 'md')
    .action((opts) => {
      const project = opts.project || deriveProjectName();
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      let codeReader: CodeGraphReader | undefined;
      try {
        codeReader = new CodeGraphReader(defaultCodeDbPath(project));
      } catch (e: any) {
        console.error(`Error: code graph not available — ${e.message}`);
        process.exitCode = 1;
        return;
      }
      try {
        const rep = computeUndocumentedReport(project, codeReader, humanStore);
        if (opts.format === 'json') {
          console.log(JSON.stringify(rep, null, 2));
        } else {
          console.log(renderUndocumentedReportMarkdown(rep));
        }
      } finally {
        humanStore.close();
        codeReader?.close();
      }
    });

  report
    .command('risk')
    .description('Risk report: high coupling, dead code, fragile interfaces')
    .option('--project <name>')
    .option('--limit <n>', '200')
    .option('--format <fmt>', 'md | json', 'md')
    .action((opts) => {
      const project = opts.project || deriveProjectName();
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      let codeReader: CodeGraphReader | undefined;
      try {
        codeReader = new CodeGraphReader(defaultCodeDbPath(project));
      } catch (e: any) {
        console.error(`Error: code graph not available — ${e.message}`);
        process.exitCode = 1;
        return;
      }
      try {
        const rep = computeRiskReport(project, codeReader, humanStore, {
          limit: (() => { const n = parseInt(opts.limit, 10); return Number.isFinite(n) ? n : 200; })(),
        });
        if (opts.format === 'json') {
          console.log(JSON.stringify(rep, null, 2));
        } else {
          console.log(renderRiskReportMarkdown(rep));
        }
      } finally {
        humanStore.close();
        codeReader?.close();
      }
    });
}
