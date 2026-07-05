// v2/src/cli/commands/watch.ts
// R29: `cbm-v2 watch` daemon — auto-sync when vault files change.
//
// Uses Node.js native fs.watch (recursive, Node 18+) to monitor the vault
// directory. When a .md file is created/modified/deleted, it triggers an
// incremental import (vault -> DB). When the human DB changes via MCP/API,
// it triggers an incremental export (DB -> vault).
//
// The watch daemon attaches a NotifyHub to the HumanMemoryStore so that
// mutations from MCP tools (running in the same process) push WebSocket
// notifications. For external mutations (CLI, other processes), the file
// watcher detects vault changes and triggers a sync + notification.
//
// Architecture:
//   ┌─────────────┐  file change   ┌──────────────┐  import   ┌──────────┐
//   │ fs.watch    │ ─────────────► │ debounce     │ ────────► │ importVault
//   │ (recursive) │                │ 500ms        │           │ (incremental)
//   └─────────────┘                └──────────────┘           └──────────┘
//                                                                      │
//   ┌─────────────┐  DB mutation    ┌──────────────┐  export   ┌──────────┐
//   │ MCP tools   │ ─────────────► │ NotifyHub    │ ────────► │ generateVault
//   │ /api/*      │                │ (debounce    │           │ (incremental)
//   │             │                │  200ms)      │           └──────────┘
//   └─────────────┘                └──────────────┘

import { Command } from 'commander';
import { HumanMemoryStore, defaultHumanDbPath } from '../../human/store.js';
import { CodeGraphReader, defaultCodeDbPath } from '../../bridge/sqlite-ro.js';
import { importVault } from '../../obsidian/importer.js';
import { generateVault } from '../../obsidian/generator.js';
import { getNotifyHub } from '../../ui/notify-hub.js';
import { loadConfig, deriveProjectName } from '../../config.js';
import { resolve } from 'node:path';
import { watch, FSWatcher } from 'node:fs';
import { existsSync } from 'node:fs';

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Watch the Obsidian vault for changes and auto-sync (daemon)')
    .option('--project <name>', 'Project name')
    .option('--vault <path>', 'Vault path (default: from config)')
    .option('--direction <dir>', 'Direction: both | import | export', 'both')
    .option('--debounce <ms>', 'Debounce delay in milliseconds (default: 500)', '500')
    .option('--no-backup', 'Skip backup files before write')
    .option('--no-auto-modules', 'Skip auto-generating module notes')
    .option('--no-auto-routes', 'Skip auto-generating route notes')
    .option('--min-degree <n>', 'Min degree for auto module notes')
    .action((opts) => {
      const config = loadConfig();
      const project = opts.project || deriveProjectName();
      const vaultPath = resolve(opts.vault || config.v2.obsidian.vaultPath);
      const direction = opts.direction as 'both' | 'import' | 'export';
      const debounceMs = parseInt(opts.debounce, 10) || 500;
      const backup = opts.backup !== false && config.v2.obsidian.backupBeforeWrite;
      const autoModules = opts.autoModules !== false && config.v2.obsidian.autoGenerateModuleNotes;
      const autoRoutes = opts.autoRoutes !== false && config.v2.obsidian.autoGenerateRouteNotes;
      const minDegreeParsed = opts.minDegree ? parseInt(opts.minDegree, 10) : NaN;
      const minDegree = Number.isFinite(minDegreeParsed) ? minDegreeParsed : config.v2.obsidian.minDegreeForModuleNote;

      if (!existsSync(vaultPath)) {
        console.error(`Error: vault path not found: ${vaultPath}`);
        console.error('       Run "cbm-v2 obsidian init" first to create the vault structure.');
        process.exitCode = 1;
        return;
      }

      const validDirections = ['both', 'import', 'export'];
      if (!validDirections.includes(direction)) {
        console.error(`Error: --direction must be one of: ${validDirections.join(', ')} (got "${direction}")`);
        process.exitCode = 1;
        return;
      }

      console.log(`[cbm-v2 watch] Watching vault: ${vaultPath}`);
      console.log(`[cbm-v2 watch] Project: ${project}`);
      console.log(`[cbm-v2 watch] Direction: ${direction}`);
      console.log(`[cbm-v2 watch] Debounce: ${debounceMs}ms`);
      console.log(`[cbm-v2 watch] Press Ctrl+C to stop.`);
      console.log('');

      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      let codeReader: CodeGraphReader | undefined;
      try {
        codeReader = new CodeGraphReader(defaultCodeDbPath(project));
      } catch {
        // Code graph not available — watch will work in human-only mode.
        console.warn('[cbm-v2 watch] Code graph not available — running in human-only mode.');
      }

      // R29: attach the NotifyHub so MCP tools (if running in-process) push
      // WebSocket notifications. Also enables the watch daemon to detect
      // DB-side changes via the hub subscriber.
      const hub = getNotifyHub();
      humanStore.attachNotifyHub(hub, project);

      // R30: removed lastKnownFiles tracking — the import uses no-op detection
      // (idempotent via field comparison), so a full import on every file change
      // is safe and simpler than diffing the file set.
      let importTimer: ReturnType<typeof setTimeout> | null = null;
      let exportTimer: ReturnType<typeof setTimeout> | null = null;
      // R32 (C-new-1 fix): replaced the broken isSyncing boolean with a
      // timestamp-based guard. The boolean was always false by the time
      // runIncrementalExport actually ran (NotifyHub debounces 200ms +
      // watch.ts debounces 500ms = ~700ms, but runSync completes in
      // single-digit ms). The timestamp records when the last sync finished;
      // runIncrementalExport skips if it's within the combined debounce window.
      let lastSyncFinishedAt = 0;
      const SYNC_GUARD_WINDOW_MS = 1500; // covers 200ms hub + 500ms watch + margin

      /**
       * R31 (B2 fix): renamed from runIncrementalImport to runSync.
       * The function does a full vault scan (not incremental), so the old
       * name was misleading. The import uses no-op detection (idempotent
       * via field comparison) to keep DB writes cheap.
       *
       * R30: wrapped in try/catch to prevent the daemon from crashing.
       * R32 (C-new-1 fix): records lastSyncFinishedAt timestamp to suppress
       * redundant hub-triggered export within the debounce window.
       * R31 (B3 fix): uses consistent auto-generate flags for both paths.
       */
      function runSync(): void {
        try {

          if (direction === 'import' || direction === 'both') {
            const result = importVault({
              project,
              vaultPath,
              humanStore,
              codeReader,
            });
            if (result.created.length > 0 || result.updated.length > 0 || result.edgesCreated > 0) {
              console.log(`[cbm-v2 watch] Import: ${result.created.length} created, ${result.updated.length} updated, ${result.edgesCreated} edges`);
              // Notify WebSocket clients that the DB changed.
              hub.notify(project, 'human_nodes_changed', { source: 'watch-import' });
              hub.notify(project, 'human_edges_changed', { source: 'watch-import' });
            }
          }

          if (direction === 'export' || direction === 'both') {
            // After import, re-export to update the AUTO-GENERATED sections
            // with the latest DB state.
            const result = generateVault({
              project,
              vaultPath,
              humanStore,
              codeReader,
              backupBeforeWrite: backup,
              autoGenerateModuleNotes: autoModules,
              autoGenerateRouteNotes: autoRoutes,
              minDegreeForModuleNote: minDegree,
            });
            if (result.created.length > 0 || result.updated.length > 0) {
              console.log(`[cbm-v2 watch] Export: ${result.created.length} created, ${result.updated.length} updated`);
            }
          }
        } catch (e: any) {
          console.error(`[cbm-v2 watch] Error during sync: ${e.message}`);
        } finally {
          // R32 (C-new-1 fix): record when the sync finished. The hub-triggered
          // export checks this timestamp and skips if within SYNC_GUARD_WINDOW_MS.
          lastSyncFinishedAt = Date.now();
        }
      }

      /**
       * Run an export (DB -> vault). Triggered when the DB changes via MCP
       * tools or API endpoints (detected via NotifyHub).
       *
       * R32 (C-new-1 fix): skips if the last sync finished within
       * SYNC_GUARD_WINDOW_MS (the sync cycle already ran its own export,
       * so this would be redundant). The previous isSyncing boolean was
       * always false by the time this function ran due to debounce delays.
       * R31 (B3 fix): uses the same auto-generate flags as runSync for
       * consistency. Both paths now respect the user's --auto-modules /
       * --auto-routes settings.
       */
      function runIncrementalExport(): void {
        if (direction !== 'export' && direction !== 'both') return;
        // R32 (C-new-1 fix): timestamp-based guard. Skip if the last sync
        // finished within the guard window — the sync already ran export.
        if (lastSyncFinishedAt > 0 && Date.now() - lastSyncFinishedAt < SYNC_GUARD_WINDOW_MS) {
          return;
        }
        try {
          const result = generateVault({
            project,
            vaultPath,
            humanStore,
            codeReader,
            backupBeforeWrite: backup,
            autoGenerateModuleNotes: autoModules, // R31 (B3): consistent with runSync
            autoGenerateRouteNotes: autoRoutes,
            minDegreeForModuleNote: minDegree,
          });
          if (result.created.length > 0 || result.updated.length > 0) {
            console.log(`[cbm-v2 watch] Export (DB change): ${result.created.length} created, ${result.updated.length} updated`);
          }
        } catch (e: any) {
          console.error(`[cbm-v2 watch] Error during export: ${e.message}`);
        }
      }

      // Subscribe to NotifyHub for DB-side changes (MCP tools, API endpoints).
      // This triggers an export when the DB changes, closing the loop:
      // MCP tool creates note -> NotifyHub -> export -> vault file updated.
      // R31 (B1): the isSyncing guard in runIncrementalExport prevents
      // redundant exports when the change originated from runSync's own import.
      const hubUnsubscribe = hub.subscribe((event) => {
        if (event.project !== project) return;
        // Debounce export on DB changes.
        if (exportTimer) clearTimeout(exportTimer);
        exportTimer = setTimeout(() => {
          exportTimer = null;
          runIncrementalExport();
        }, debounceMs);
      });

      // Start watching the vault directory.
      let watcher: FSWatcher;
      try {
        watcher = watch(vaultPath, { recursive: true }, (_eventType, filename) => {
          if (!filename) return;
          // Only react to .md file changes.
          if (!filename.endsWith('.md')) return;
          // Skip backup/deleted/conflict files.
          if (filename.includes('.bak.') || filename.includes('.deleted.') || filename.includes('.conflict.')) return;

          // Debounce: wait for debounceMs of silence before syncing.
          // This prevents multiple rapid saves from triggering multiple syncs.
          if (importTimer) clearTimeout(importTimer);
          importTimer = setTimeout(() => {
            importTimer = null;
            runSync();
          }, debounceMs);
        });
      } catch (e: any) {
        console.error(`[cbm-v2 watch] Failed to watch vault: ${e.message}`);
        console.error('       Recursive watch may not be supported on this platform.');
        console.error('       Use "cbm-v2 obsidian sync" for manual sync.');
        humanStore.close();
        codeReader?.close();
        process.exitCode = 1;
        return;
      }

      // Graceful shutdown.
      const shutdown = (signal: string) => {
        console.log(`\n[cbm-v2 watch] Received ${signal}, shutting down...`);
        watcher.close();
        hubUnsubscribe();
        if (importTimer) clearTimeout(importTimer);
        if (exportTimer) clearTimeout(exportTimer);
        // Flush any pending notifications.
        hub.flush();
        humanStore.close();
        codeReader?.close();
        process.exit(0);
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));

      // Do an initial sync on startup.
      console.log('[cbm-v2 watch] Initial sync...');
      runSync();
      console.log('[cbm-v2 watch] Watching for changes...');
    });
}
