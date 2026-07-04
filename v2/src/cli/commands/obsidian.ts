// v2/src/cli/commands/obsidian.ts

import { Command } from 'commander';
import { HumanMemoryStore, defaultHumanDbPath } from '../../human/store.js';
import { CodeGraphReader, defaultCodeDbPath } from '../../bridge/sqlite-ro.js';
import { generateVault } from '../../obsidian/generator.js';
import { importVault } from '../../obsidian/importer.js';
import { ensureVaultDirs, walkVault } from '../../obsidian/vault.js';
import { resolve } from 'node:path';

export function registerObsidianCommand(program: Command): void {
  const obsidian = program.command('obsidian').description('Obsidian vault management');

  obsidian
    .command('init')
    .description('Initialize the Obsidian vault structure (.codebase-memory-vault/)')
    .option('--project <name>', 'Project name')
    .option('--vault <path>', 'Vault path (default: .codebase-memory-vault)', '.codebase-memory-vault')
    .action((opts) => {
      const vaultPath = resolve(opts.vault);
      console.log(`Initializing vault at: ${vaultPath}`);
      ensureVaultDirs(vaultPath);
      console.log('✅ Vault structure created:');
      console.log('   - Architecture/, ADR/, Modules/, Routes/, Refactor/');
      console.log('   - Bugs/, Legacy/, Conventions/, Prompts/, Journal/');
      console.log('');
      console.log('Next steps:');
      console.log('  1. Run `cbm-v2 obsidian sync` to populate the vault');
      console.log('  2. Open the vault folder in Obsidian');
    });

  obsidian
    .command('sync')
    .description('Sync the human memory DB with the Obsidian vault (both directions)')
    .option('--project <name>', 'Project name')
    .option('--vault <path>', 'Vault path', '.codebase-memory-vault')
    .option('--direction <dir>', 'Direction: both | export | import', 'both')
    .option('--dry-run', 'Preview without writing')
    .option('--no-backup', 'Skip backup files before write')
    .option('--no-auto-modules', 'Skip auto-generating module notes')
    .option('--no-auto-routes', 'Skip auto-generating route notes')
    .option('--min-degree <n>', 'Min degree for auto module notes', '20')
    .action((opts) => {
      const project = opts.project || process.cwd().split(/[\\/]/).pop() || 'default';
      const vaultPath = resolve(opts.vault);
      const direction = opts.direction as 'both' | 'export' | 'import';
      const dryRun = !!opts.dryRun;
      const backup = opts.backup !== false;
      const autoModules = opts.autoModules !== false;
      const autoRoutes = opts.autoRoutes !== false;
      const minDegree = parseInt(String(opts.minDegree), 10) || 20;

      console.log(`Syncing project "${project}" — direction: ${direction}${dryRun ? ' (dry-run)' : ''}`);

      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      let codeReader: CodeGraphReader | undefined;
      try {
        codeReader = new CodeGraphReader(defaultCodeDbPath(project));
      } catch (e: any) {
        console.warn(`⚠️  Code graph not available: ${e.message}`);
        console.warn('    Sync will work in human-only mode (no auto module/route notes).');
      }

      try {
        if (direction === 'export' || direction === 'both') {
          console.log('');
          console.log('→ Export (DB → vault):');
          const result = generateVault({
            project,
            vaultPath,
            humanStore,
            codeReader,
            backupBeforeWrite: backup,
            dryRun,
            autoGenerateModuleNotes: autoModules,
            autoGenerateRouteNotes: autoRoutes,
            minDegreeForModuleNote: minDegree,
          });
          console.log(`  Created: ${result.created.length}`);
          console.log(`  Updated: ${result.updated.length}`);
          console.log(`  Unchanged: ${result.unchanged.length}`);
          if (result.backups.length > 0) console.log(`  Backups: ${result.backups.length}`);
          if (result.errors.length > 0) {
            console.log(`  Errors: ${result.errors.length}`);
            for (const e of result.errors.slice(0, 5)) {
              console.log(`    - ${e.path}: ${e.error}`);
            }
          }
        }

        if (direction === 'import' || direction === 'both') {
          console.log('');
          console.log('← Import (vault → DB):');
          const result = importVault({
            project,
            vaultPath,
            humanStore,
            codeReader,
            dryRun,
          });
          console.log(`  Created: ${result.created.length}`);
          console.log(`  Updated: ${result.updated.length}`);
          console.log(`  Unchanged: ${result.unchanged.length}`);
          console.log(`  Edges created: ${result.edgesCreated}`);
          if (result.orphanNotes.length > 0) {
            console.log(`  Orphan notes (no cbm_node_id): ${result.orphanNotes.length}`);
          }
          if (result.errors.length > 0) {
            console.log(`  Errors: ${result.errors.length}`);
            for (const e of result.errors.slice(0, 5)) {
              console.log(`    - ${e.path}: ${e.error}`);
            }
          }
        }

        console.log('');
        console.log('✅ Sync complete');
      } finally {
        humanStore.close();
        codeReader?.close();
      }
    });

  obsidian
    .command('export')
    .description('Export DB → vault (one-shot, with HUMAN NOTES preserved)')
    .option('--project <name>')
    .option('--vault <path>', 'Vault path', '.codebase-memory-vault')
    .option('--force', 'Regenerate even if unchanged', false)
    .option('--dry-run', 'Preview without writing')
    .action((opts) => {
      const project = opts.project || process.cwd().split(/[\\/]/).pop() || 'default';
      const vaultPath = resolve(opts.vault);
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      let codeReader: CodeGraphReader | undefined;
      try { codeReader = new CodeGraphReader(defaultCodeDbPath(project)); } catch {}

      try {
        const result = generateVault({
          project, vaultPath, humanStore, codeReader,
          backupBeforeWrite: true, dryRun: opts.dryRun,
          autoGenerateModuleNotes: true, autoGenerateRouteNotes: true,
        });
        console.log(`✅ Export: ${result.created.length} created, ${result.updated.length} updated`);
      } finally {
        humanStore.close();
        codeReader?.close();
      }
    });

  obsidian
    .command('import')
    .description('Import vault → DB (one-shot)')
    .option('--project <name>')
    .option('--vault <path>', 'Vault path', '.codebase-memory-vault')
    .option('--dry-run', 'Preview without writing')
    .action((opts) => {
      const project = opts.project || process.cwd().split(/[\\/]/).pop() || 'default';
      const vaultPath = resolve(opts.vault);
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      let codeReader: CodeGraphReader | undefined;
      try { codeReader = new CodeGraphReader(defaultCodeDbPath(project)); } catch {}

      try {
        const result = importVault({ project, vaultPath, humanStore, codeReader, dryRun: opts.dryRun });
        console.log(`✅ Import: ${result.created.length} created, ${result.updated.length} updated, ${result.edgesCreated} edges`);
      } finally {
        humanStore.close();
        codeReader?.close();
      }
    });

  obsidian
    .command('report')
    .description('Print a report of the vault state')
    .option('--project <name>')
    .option('--vault <path>', 'Vault path', '.codebase-memory-vault')
    .option('--format <fmt>', 'md | json', 'md')
    .action((opts) => {
      const vaultPath = resolve(opts.vault);
      const files = walkVault(vaultPath);
      console.log(`# Vault report — ${opts.project || 'project'}`);
      console.log('');
      console.log(`Total .md files: ${files.length}`);
      console.log('');
      const byDir: Record<string, number> = {};
      for (const f of files) {
        const dir = f.split('/')[0] || 'root';
        byDir[dir] = (byDir[dir] || 0) + 1;
      }
      console.log('| Dossier | Notes |');
      console.log('|---|---|');
      for (const [dir, count] of Object.entries(byDir).sort()) {
        console.log(`| ${dir} | ${count} |`);
      }
    });

  obsidian
    .command('create-adr')
    .description('Create an ADR note + human_node')
    .option('--project <name>')
    .option('--vault <path>', 'Vault path', '.codebase-memory-vault')
    .option('--title <title>', 'ADR title (required)')
    .option('--module <name>', 'Module to link via DECIDES edge')
    .option('--status <status>', 'draft | active | deprecated', 'draft')
    .action((opts) => {
      if (!opts.title) {
        console.error('Error: --title is required');
        process.exit(1);
      }
      const project = opts.project || process.cwd().split(/[\\/]/).pop() || 'default';
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      let codeReader: CodeGraphReader | undefined;
      try { codeReader = new CodeGraphReader(defaultCodeDbPath(project)); } catch {}

      try {
        const cbmNodeIds: number[] = [];
        if (opts.module && codeReader) {
          const modules = codeReader.findModulesByName(project, opts.module, 1);
          if (modules.length > 0) cbmNodeIds.push(modules[0].id);
        }
        const node = humanStore.createNode({
          project,
          label: 'ADR',
          title: opts.title,
          body_markdown: '',
          status: opts.status,
          source: 'human',
          cbm_node_ids: cbmNodeIds,
          tags: ['adr'],
        });
        if (cbmNodeIds.length > 0) {
          humanStore.createEdge({
            project,
            source_human_node_id: node.id,
            target_kind: 'code',
            target_cbm_node_id: cbmNodeIds[0],
            type: 'DECIDES',
          });
        }
        console.log(`✅ ADR created: id=${node.id}, slug=${node.slug}, path=${node.obsidian_path}`);
        console.log('Run `cbm-v2 obsidian sync --direction export` to materialize the file.');
      } finally {
        humanStore.close();
        codeReader?.close();
      }
    });

  obsidian
    .command('create-module-note')
    .description('Create a ModuleNote for a specific module')
    .option('--project <name>')
    .option('--module <name>', 'Module name (required)')
    .action((opts) => {
      if (!opts.module) {
        console.error('Error: --module is required');
        process.exit(1);
      }
      const project = opts.project || process.cwd().split(/[\\/]/).pop() || 'default';
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      let codeReader: CodeGraphReader | undefined;
      try { codeReader = new CodeGraphReader(defaultCodeDbPath(project)); } catch {}

      try {
        if (!codeReader) {
          console.error('Error: code graph not available');
          process.exit(1);
        }
        const modules = codeReader.findModulesByName(project, opts.module, 1);
        if (modules.length === 0) {
          console.error(`Error: no module matching "${opts.module}"`);
          process.exit(1);
        }
        const m = modules[0];
        const slug = m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const obsidianPath = `Modules/${slug}.md`;
        const node = humanStore.createNode({
          project,
          label: 'ModuleNote',
          title: `Module: ${m.name}`,
          body_markdown: '',
          source: 'human',
          cbm_node_ids: [m.id],
          tags: ['module', slug],
          obsidian_path: obsidianPath,
        });
        console.log(`✅ ModuleNote created: id=${node.id}, path=${node.obsidian_path}`);
      } finally {
        humanStore.close();
        codeReader?.close();
      }
    });

  obsidian
    .command('create-route-note')
    .description('Create a RouteNote for a specific HTTP route')
    .option('--project <name>')
    .option('--method <method>', 'HTTP method (GET, POST, ...)', 'GET')
    .option('--path <path>', 'Route path (required)')
    .action((opts) => {
      if (!opts.path) {
        console.error('Error: --path is required');
        process.exit(1);
      }
      const project = opts.project || process.cwd().split(/[\\/]/).pop() || 'default';
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      let codeReader: CodeGraphReader | undefined;
      try { codeReader = new CodeGraphReader(defaultCodeDbPath(project)); } catch {}

      try {
        if (!codeReader) {
          console.error('Error: code graph not available');
          process.exit(1);
        }
        const route = codeReader.findRoute(project, opts.method, opts.path);
        if (!route) {
          console.error(`Error: route ${opts.method} ${opts.path} not found`);
          process.exit(1);
        }
        const slug = `${opts.method.toLowerCase()}-${opts.path.replace(/[^a-z0-9]+/gi, '-')}`.toLowerCase();
        const obsidianPath = `Routes/${slug}.md`;
        const node = humanStore.createNode({
          project,
          label: 'RouteNote',
          title: `Route: ${opts.method} ${opts.path}`,
          body_markdown: '',
          source: 'human',
          cbm_node_ids: [route.id],
          tags: ['route', opts.method.toLowerCase()],
          obsidian_path: obsidianPath,
        });
        console.log(`✅ RouteNote created: id=${node.id}, path=${node.obsidian_path}`);
      } finally {
        humanStore.close();
        codeReader?.close();
      }
    });
}
