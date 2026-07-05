// v2/src/cli/commands/obsidian.ts

import { Command } from 'commander';
import { HumanMemoryStore, defaultHumanDbPath } from '../../human/store.js';
import { CodeGraphReader, defaultCodeDbPath } from '../../bridge/sqlite-ro.js';
import { generateVault } from '../../obsidian/generator.js';
import { importVault } from '../../obsidian/importer.js';
import { ensureVaultDirs, walkVault } from '../../obsidian/vault.js';
import { slugify } from '../../human/schema.js';
import { resolve } from 'node:path';
import { loadConfig, deriveProjectName } from '../../config.js';

const VALID_DIRECTIONS = ['both', 'export', 'import'] as const;
type Direction = (typeof VALID_DIRECTIONS)[number];

function parseDirection(v: string): Direction {
  if (!VALID_DIRECTIONS.includes(v as Direction)) {
    throw new Error(`--direction must be one of: ${VALID_DIRECTIONS.join(', ')} (got "${v}")`);
  }
  return v as Direction;
}

function deriveProject(opts: any): string {
  return opts.project || deriveProjectName();
}

function deriveVault(opts: any, config: ReturnType<typeof loadConfig>): string {
  return resolve(opts.vault || config.v2.obsidian.vaultPath);
}

export function registerObsidianCommand(program: Command): void {
  const obsidian = program.command('obsidian').description('Obsidian vault management');

  obsidian
    .command('init')
    .description('Initialize the Obsidian vault structure (.codebase-memory-vault/)')
    .option('--project <name>', 'Project name')
    .option('--vault <path>', 'Vault path (default: .codebase-memory-vault)')
    .action((opts) => {
      const config = loadConfig();
      const vaultPath = deriveVault(opts, config);
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
    .option('--vault <path>', 'Vault path')
    .option('--direction <dir>', 'Direction: both | export | import', 'both')
    .option('--dry-run', 'Preview without writing')
    .option('--no-backup', 'Skip backup files before write')
    .option('--no-auto-modules', 'Skip auto-generating module notes')
    .option('--no-auto-routes', 'Skip auto-generating route notes')
    .option('--min-degree <n>', 'Min degree for auto module notes')
    .action((opts) => {
      const config = loadConfig();
      const project = deriveProject(opts);
      const vaultPath = deriveVault(opts, config);
      const dryRun = !!opts.dryRun;
      const backup = opts.backup !== false && config.v2.obsidian.backupBeforeWrite;
      const autoModules = opts.autoModules !== false && config.v2.obsidian.autoGenerateModuleNotes;
      const autoRoutes = opts.autoRoutes !== false && config.v2.obsidian.autoGenerateRouteNotes;
      const minDegreeParsed = opts.minDegree ? parseInt(opts.minDegree, 10) : NaN;
      const minDegree = Number.isFinite(minDegreeParsed) ? minDegreeParsed : config.v2.obsidian.minDegreeForModuleNote;

      let direction: Direction;
      try {
        direction = parseDirection(opts.direction);
      } catch (e: any) {
        console.error(`Error: ${e.message}`);
        process.exitCode = 1;
        return;
      }

      console.log(`Syncing project "${project}" — direction: ${direction}${dryRun ? ' (dry-run)' : ''}`);

      let humanStore: HumanMemoryStore | null = null;
      let codeReader: CodeGraphReader | undefined;
      try {
        humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
        try {
          codeReader = new CodeGraphReader(defaultCodeDbPath(project));
        } catch (e: any) {
          console.warn(`⚠️  Code graph not available: ${e.message}`);
          console.warn('    Sync will work in human-only mode (no auto module/route notes).');
        }

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
            if (result.errors.length > 5) console.log(`    ... and ${result.errors.length - 5} more`);
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
          console.log(`  Edges created/refreshed: ${result.edgesCreated}`);
          console.log(`  Edges deleted (stale): ${result.edgesDeleted}`);
          if (result.orphanNotes.length > 0) {
            console.log(`  Orphan notes (no cbm_node_id): ${result.orphanNotes.length}`);
          }
          if (result.errors.length > 0) {
            console.log(`  Errors: ${result.errors.length}`);
            for (const e of result.errors.slice(0, 5)) {
              console.log(`    - ${e.path}: ${e.error}`);
            }
            if (result.errors.length > 5) console.log(`    ... and ${result.errors.length - 5} more`);
          }
        }

        console.log('');
        console.log('✅ Sync complete');
      } finally {
        humanStore?.close();
        codeReader?.close();
      }
    });

  obsidian
    .command('export')
    .description('Export DB → vault (one-shot, with HUMAN NOTES preserved)')
    .option('--project <name>')
    .option('--vault <path>')
    .option('--force', 'Regenerate even if unchanged', false)
    .option('--dry-run', 'Preview without writing')
    .action((opts) => {
      const config = loadConfig();
      const project = deriveProject(opts);
      const vaultPath = deriveVault(opts, config);
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      let codeReader: CodeGraphReader | undefined;
      try { codeReader = new CodeGraphReader(defaultCodeDbPath(project)); } catch {}

      try {
        const result = generateVault({
          project, vaultPath, humanStore, codeReader,
          backupBeforeWrite: config.v2.obsidian.backupBeforeWrite,
          dryRun: !!opts.dryRun,
          autoGenerateModuleNotes: config.v2.obsidian.autoGenerateModuleNotes,
          autoGenerateRouteNotes: config.v2.obsidian.autoGenerateRouteNotes,
          minDegreeForModuleNote: config.v2.obsidian.minDegreeForModuleNote,
        });
        console.log(`✅ Export: ${result.created.length} created, ${result.updated.length} updated, ${result.unchanged.length} unchanged`);
      } finally {
        humanStore?.close();
        codeReader?.close();
      }
    });

  obsidian
    .command('import')
    .description('Import vault → DB (one-shot)')
    .option('--project <name>')
    .option('--vault <path>')
    .option('--dry-run', 'Preview without writing')
    .action((opts) => {
      const config = loadConfig();
      const project = deriveProject(opts);
      const vaultPath = deriveVault(opts, config);
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      let codeReader: CodeGraphReader | undefined;
      try { codeReader = new CodeGraphReader(defaultCodeDbPath(project)); } catch {}

      try {
        const result = importVault({ project, vaultPath, humanStore, codeReader, dryRun: !!opts.dryRun });
        console.log(`✅ Import: ${result.created.length} created, ${result.updated.length} updated, ${result.unchanged.length} unchanged, ${result.edgesCreated} edges created, ${result.edgesDeleted} edges deleted`);
      } finally {
        humanStore?.close();
        codeReader?.close();
      }
    });

  obsidian
    .command('report')
    .description('Print a report of the vault state (file counts by directory)')
    .option('--project <name>')
    .option('--vault <path>')
    .option('--format <fmt>', 'md | json', 'md')
    .action((opts) => {
      const config = loadConfig();
      const vaultPath = deriveVault(opts, config);
      const files = walkVault(vaultPath);
      const byDir: Record<string, number> = {};
      for (const f of files) {
        const dir = f.includes('/') ? f.split('/')[0] : 'root';
        byDir[dir] = (byDir[dir] || 0) + 1;
      }
      const report = {
        project: opts.project || deriveProjectName(),
        vaultPath,
        totalFiles: files.length,
        byDir,
        files,
      };
      if (opts.format === 'json') {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`# Vault report — ${report.project}`);
        console.log('');
        console.log(`Total .md files: ${report.totalFiles}`);
        console.log('');
        console.log('| Directory | Notes |');
        console.log('|---|---|');
        for (const [dir, count] of Object.entries(byDir).sort()) {
          console.log(`| ${dir} | ${count} |`);
        }
      }
    });

  obsidian
    .command('create-adr')
    .description('Create an ADR note + human_node (run `cbm-v2 obsidian sync --direction export` afterward to materialize the file)')
    .option('--project <name>')
    .option('--vault <path>')
    .option('--title <title>', 'ADR title (required)')
    .option('--module <name>', 'Module to link via DECIDES edge')
    .option('--status <status>', 'draft | active | reviewed | deprecated', 'draft')
    .action((opts) => {
      if (!opts.title) {
        console.error('Error: --title is required');
        console.error('Usage: cbm-v2 obsidian create-adr --title "ADR-XXX: ..." [--module <name>] [--status draft]');
        process.exitCode = 1;
        return;
      }
      const validStatuses = ['draft', 'active', 'reviewed', 'deprecated'];
      if (!validStatuses.includes(opts.status)) {
        console.error(`Error: --status must be one of ${validStatuses.join(', ')} (got "${opts.status}")`);
        process.exitCode = 1;
        return;
      }
      const project = deriveProject(opts);
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      let codeReader: CodeGraphReader | undefined;
      try { codeReader = new CodeGraphReader(defaultCodeDbPath(project)); } catch {}

      try {
        const cbmNodeIds: number[] = [];
        if (opts.module && codeReader) {
          const modules = codeReader.findModulesByName(project, opts.module, 1);
          if (modules.length === 0) {
            console.error(`Error: no module matching "${opts.module}" in project "${project}"`);
            process.exitCode = 1;
            return;
          }
          cbmNodeIds.push(modules[0].id);
        }
        try {
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
          console.log('Run `cbm-v2 obsidian sync --direction export` to materialize the file in the vault.');
        } catch (e: any) {
          console.error(`Error creating ADR: ${e.message}`);
          process.exitCode = 1;
          return;
        }
      } finally {
        humanStore?.close();
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
        process.exitCode = 1;
        return;
      }
      const project = deriveProject(opts);
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      let codeReader: CodeGraphReader | undefined;
      try { codeReader = new CodeGraphReader(defaultCodeDbPath(project)); } catch {}

      try {
        if (!codeReader) {
          console.error('Error: code graph not available. Run `cbm index_repository` first.');
          process.exitCode = 1;
          return;
        }
        const modules = codeReader.findModulesByName(project, opts.module, 1);
        if (modules.length === 0) {
          console.error(`Error: no module matching "${opts.module}"`);
          process.exitCode = 1;
          return;
        }
        const m = modules[0];
        const slug = slugify(m.name);
        const obsidianPath = `Modules/${slug}.md`;
        // R15: check for existing node by obsidian_path BEFORE creating.
        // createNode would succeed (auto-suffixing the slug) but produce a
        // node with a different obsidian_path than expected, causing confusion.
        const existing = humanStore.getNodeByObsidianPath(project, obsidianPath);
        if (existing) {
          console.error(`Error: a ModuleNote already exists for this module (id=${existing.id}, path=${obsidianPath}).`);
          console.error('       Use `cbm-v2 human show ' + existing.id + '` to view it.');
          process.exitCode = 1;
          return;
        }
        try {
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
        } catch (e: any) {
          console.error(`Error: ${e.message}`);
          process.exitCode = 1;
          return;
        }
      } finally {
        humanStore?.close();
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
        console.error('Usage: cbm-v2 obsidian create-route-note --method POST --path /api/login');
        process.exitCode = 1;
        return;
      }
      const project = deriveProject(opts);
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      let codeReader: CodeGraphReader | undefined;
      try { codeReader = new CodeGraphReader(defaultCodeDbPath(project)); } catch {}

      try {
        if (!codeReader) {
          console.error('Error: code graph not available. Run `cbm index_repository` first.');
          process.exitCode = 1;
          return;
        }
        const route = codeReader.findRoute(project, opts.method, opts.path);
        if (!route) {
          console.error(`Error: route ${opts.method} ${opts.path} not found`);
          process.exitCode = 1;
          return;
        }
        const slug = slugify(`${opts.method}-${opts.path}`);
        const obsidianPath = `Routes/${slug}.md`;
        // R15: check for existing node by obsidian_path BEFORE creating.
        const existing = humanStore.getNodeByObsidianPath(project, obsidianPath);
        if (existing) {
          console.error(`Error: a RouteNote already exists for this route (id=${existing.id}, path=${obsidianPath}).`);
          console.error('       Use `cbm-v2 human show ' + existing.id + '` to view it.');
          process.exitCode = 1;
          return;
        }
        try {
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
        } catch (e: any) {
          console.error(`Error: ${e.message}`);
          process.exitCode = 1;
          return;
        }
      } finally {
        humanStore?.close();
        codeReader?.close();
      }
    });
}
