// v2/src/cli/index.ts
// Entry point for the cbm-v2 CLI.

import { Command } from 'commander';
import { registerObsidianCommand } from './commands/obsidian.js';
import { registerHumanCommand } from './commands/human.js';
import { registerReportCommand } from './commands/report.js';
import { McpServer } from '../mcp/server.js';
import { HumanMemoryStore, defaultHumanDbPath } from '../human/store.js';
import { CodeGraphReader, defaultCodeDbPath } from '../bridge/sqlite-ro.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const program = new Command();

program
  .name('cbm-v2')
  .description('Codebase Memory V2 sidecar — human memory + Obsidian sync')
  .version('0.1.0');

registerObsidianCommand(program);
registerHumanCommand(program);
registerReportCommand(program);

program
  .command('mcp')
  .description('Run as an MCP server (JSON-RPC over stdio)')
  .option('--project <name>', 'Project name')
  .action(async (opts) => {
    const project = opts.project || process.cwd().split(/[\\/]/).pop() || 'default';
    const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
    let codeReader: CodeGraphReader | undefined;
    try {
      codeReader = new CodeGraphReader(defaultCodeDbPath(project));
    } catch {
      // Code graph not available — operate in human-only mode
    }
    try {
      const server = new McpServer({ project, humanStore, codeReader });
      await server.run();
    } finally {
      humanStore.close();
      codeReader?.close();
    }
  });

program
  .command('init')
  .description('Initialize V2 configuration (.codebase-memory.json)')
  .option('--project <name>')
  .option('--vault <path>', 'Vault path', '.codebase-memory-vault')
  .action((opts) => {
    const project = opts.project || process.cwd().split(/[\\/]/).pop() || 'default';
    const path = '.codebase-memory.json';
    let existing: any = {};
    if (existsSync(path)) {
      existing = JSON.parse(readFileSync(path, 'utf-8'));
    }
    existing.projectName = existing.projectName || project;
    existing.v2 = existing.v2 || {
      enabled: true,
      humanMemory: { enabled: true },
      obsidian: {
        enabled: true,
        vaultPath: opts.vault,
        preserveHumanSections: true,
        autoGenerateModuleNotes: true,
        autoGenerateRouteNotes: true,
        minDegreeForModuleNote: 20,
        backupBeforeWrite: true,
      },
      ui: { defaultView: 'architecture-dashboard', maxInitialNodes: 500 },
      privacy: { localOnly: true, telemetry: false },
      mcp: { exposeV2Tools: true, maxContextNodes: 200 },
    };
    writeFileSync(path, JSON.stringify(existing, null, 2));
    console.log(`✅ ${path} configured for project "${project}"`);
  });

program.parseAsync(process.argv).catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
