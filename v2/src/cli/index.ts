#!/usr/bin/env node
// v2/src/cli/index.ts
// Entry point for the cbm-v2 CLI.

import { Command } from 'commander';
import { registerObsidianCommand } from './commands/obsidian.js';
import { registerHumanCommand } from './commands/human.js';
import { registerReportCommand } from './commands/report.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerBackupCommand } from './commands/backup.js';
import { registerDemoCommand } from './commands/demo.js';
import { registerWatchCommand } from './commands/watch.js';
import { registerIndexCommand } from './commands/index.js';
import { McpServer } from '../mcp/server.js';
import { UiServer } from '../ui/server.js';
import { HumanMemoryStore, defaultHumanDbPath } from '../human/store.js';
import { CodeGraphReader, defaultCodeDbPath } from '../bridge/sqlite-ro.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig, DEFAULT_CONFIG, deriveProjectName, deepMerge } from '../config.js';

// Read version from package.json at runtime for single source of truth.
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const VERSION = require2('../../package.json').version;

const program = new Command();

program
  .name('cbm-v2')
  .description('Codebase Memory V2 sidecar — human memory + Obsidian sync')
  .version(VERSION, '-V, --version');

registerObsidianCommand(program);
registerHumanCommand(program);
registerReportCommand(program);
registerStatsCommand(program);
registerBackupCommand(program);
registerDemoCommand(program);
registerWatchCommand(program);
registerIndexCommand(program);

program
  .command('mcp')
  .description('Run as an MCP server (JSON-RPC over stdio)')
  .option('--project <name>', 'Project name')
  .action(async (opts) => {
    const config = loadConfig();
    const project = opts.project || config.projectName || deriveProjectName();
    const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
    let codeReader: CodeGraphReader | undefined;
    try {
      codeReader = new CodeGraphReader(defaultCodeDbPath(project));
    } catch {
      // Code graph not available — operate in human-only mode.
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
  .command('ui')
  .description('Start the graph UI web server (http://127.0.0.1:9749)')
  .option('--project <name>', 'Project name')
  .option('--port <n>', 'Port number (default: 9749)', '9749')
  .option('--graph-ui-path <path>', 'Path to graph-ui/dist directory')
  .action((opts) => {
    const config = loadConfig();
    const project = opts.project || config.projectName || deriveProjectName();
    const port = parseInt(opts.port, 10) || 9749;
    const graphUiPath = opts.graphUiPath;

    console.log(`Starting Graph UI for project "${project}" on port ${port}...`);
    const ui = new UiServer({ project, port, graphUiPath });
    ui.start();

    // Graceful shutdown
    process.on('SIGINT', () => { ui.stop(); process.exit(0); });
    process.on('SIGTERM', () => { ui.stop(); process.exit(0); });
  });

program
  .command('init')
  .description('Initialize V2 configuration (.codebase-memory.json)')
  .option('--project <name>')
  .option('--vault <path>', 'Vault path', '.codebase-memory-vault')
  .action((opts) => {
    const project = opts.project || deriveProjectName();
    const path = '.codebase-memory.json';
    let existing: any = {};
    if (existsSync(path)) {
      try {
        existing = JSON.parse(readFileSync(path, 'utf-8'));
      } catch (e: unknown) {
        // Malformed config — back it up and start fresh.
        const backupPath = `${path}.bak.${Date.now()}`;
        writeFileSync(backupPath, readFileSync(path));
        console.warn(`⚠️  Existing .codebase-memory.json is malformed. Backed up to ${backupPath}. Starting fresh.`);
        existing = {};
      }
    }
    existing.projectName = existing.projectName || project;
    // Deep-merge defaults so missing keys are filled in.
    existing.v2 = deepMerge(DEFAULT_CONFIG.v2, existing.v2 || {});
    if (opts.vault) existing.v2.obsidian.vaultPath = opts.vault;
    writeFileSync(path, JSON.stringify(existing, null, 2));
    console.log(`✅ ${path} configured for project "${project}"`);
  });

program
  .command('doctor')
  .description('Run diagnostics to verify the V2 setup')
  .option('--project <name>')
  .action(async (opts) => {
    const project = opts.project || deriveProjectName();
    console.log('Codebase Memory V2 — diagnostics');
    console.log('================================');
    let allOk = true;

    // 1. Node version.
    const nodeVersion = process.version;
    const major = parseInt(nodeVersion.slice(1), 10);
    if (major >= 18) {
      console.log(`✅ Node.js version: ${nodeVersion}`);
    } else {
      console.log(`❌ Node.js version: ${nodeVersion} (require >= 18)`);
      allOk = false;
    }

    // 2. Config file.
    const config = loadConfig();
    if (existsSync('.codebase-memory.json')) {
      console.log(`✅ .codebase-memory.json found (project: ${config.projectName})`);
    } else {
      console.log(`⚠️  .codebase-memory.json not found — using defaults (run "cbm-v2 init")`);
    }

    // 3. Human DB.
    try {
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      const count = humanStore.countNodes(project);
      console.log(`✅ Human memory DB: ${defaultHumanDbPath(project)} (${count} notes)`);
      humanStore.close();
    } catch (e: unknown) {
      console.log(`❌ Human memory DB error: ${(e instanceof Error ? e.message : String(e))}`);
      allOk = false;
    }

    // 4. Code graph DB.
    try {
      const codeReader = new CodeGraphReader(defaultCodeDbPath(project));
      const nodeCount = codeReader.countNodes(project);
      const edgeCount = codeReader.countEdges(project);
      console.log(`✅ Code graph DB: ${defaultCodeDbPath(project)} (${nodeCount} nodes, ${edgeCount} edges)`);
      codeReader.close();
    } catch (e: unknown) {
      console.log(`❌ Code graph DB not available: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
      console.log(`   (MCP tools will work in human-only mode)`);
    }

    // 5. Vault path writable?
    const vaultPath = config.v2.obsidian.vaultPath;
    try {
      const { ensureVaultDirs } = await import('../obsidian/vault.js');
      ensureVaultDirs(vaultPath);
      console.log(`✅ Vault path writable: ${vaultPath}`);
    } catch (e: unknown) {
      console.log(`❌ Vault path not writable: ${vaultPath} (${(e instanceof Error ? e.message : String(e))})`);
      allOk = false;
    }

    console.log('');
    if (allOk) {
      console.log('✅ All checks passed.');
    } else {
      console.log('⚠️  Some checks failed. See above.');
      process.exitCode = 1;
    }
  });

// Top-level async function — needed for `await import` in doctor command.
async function main() {
  await program.parseAsync(process.argv);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exitCode = 1;
  return;
});

// deepMerge is imported from ../config.js (single source of truth).
