// v2/src/cli/commands/demo.ts
// Demo command — creates a sample project with ADRs, bugs, modules, runs sync, shows the vault.

import { Command } from 'commander';
import { HumanMemoryStore, defaultHumanDbPath } from '../../human/store.js';
import { generateVault } from '../../obsidian/generator.js';
import { ensureVaultDirs } from '../../obsidian/vault.js';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

export function registerDemoCommand(program: Command): void {
  program
    .command('demo')
    .description('Create a demo project with sample notes and generate a vault')
    .option('--vault <path>', 'Vault path (default: temp directory)')
    .option('--keep', 'Keep the demo files after completion (default: cleanup)')
    .action((opts) => {
      const project = 'demo-project';
      const vaultPath = opts.vault
        ? resolve(opts.vault)
        : mkdtempSync(resolve(tmpdir(), 'cbm-v2-demo-'));
      const keep = !!opts.keep;
      const cleanup = !keep && !opts.vault;

      console.log('');
      console.log('  ╔══════════════════════════════════════════════════╗');
      console.log('  ║  Codebase Memory V2 — Demo                       ║');
      console.log('  ╚══════════════════════════════════════════════════╝');
      console.log(`  Project: ${project}`);
      console.log(`  Vault:   ${vaultPath}`);
      console.log(`  Keep:    ${keep}`);
      console.log('');

      // Create a fresh human DB for the demo
      const dbPath = defaultHumanDbPath(project);
      const humanStore = new HumanMemoryStore(dbPath);

      try {
        console.log('  ┌─ Step 1: Creating sample notes ────────────────┐');

        // ADRs
        const adr1 = humanStore.createNode({
          project,
          label: 'ADR',
          title: 'ADR-001: Use JWT for authentication',
          body_markdown: '## Context\n\nWe needed a stateless auth mechanism.\n\n## Decision\n\nUse JWT tokens signed with HS256.\n\n## Consequences\n\n- Logout requires token blocklist\n- Token refresh needed',
          tags: ['auth', 'security', 'jwt'],
        });
        console.log(`  │ ✅ ADR-001: Use JWT for authentication          │`);

        const adr2 = humanStore.createNode({
          project,
          label: 'ADR',
          title: 'ADR-002: Extract SessionProvider from auth module',
          body_markdown: '## Context\n\nSessionProvider is too coupled.\n\n## Decision\n\nExtract to src/session/provider.ts with ISessionStore interface.\n\n## Consequences\n\n- 47 callers to adapt\n- Need tests for SessionProvider',
          tags: ['refactor', 'session', 'auth'],
        });
        console.log(`  │ ✅ ADR-002: Extract SessionProvider             │`);

        // Bug notes
        const bug1 = humanStore.createNode({
          project,
          label: 'BugNote',
          title: 'Bug: Token refresh fails with concurrent sessions',
          body_markdown: '## Symptom\n\nWhen user has 2 sessions, refresh token expires prematurely.\n\n## Cause\n\nRefresh token is overwritten at each login (line 67).\n\n## Status: OPEN',
          tags: ['bug', 'auth', 'session'],
        });
        console.log(`  │ ✅ Bug: Token refresh fails                     │`);

        humanStore.createNode({
          project,
          label: 'BugNote',
          title: 'Bug: API returns 500 on malformed JSON body',
          body_markdown: '## Symptom\n\nPOST /api/login with invalid JSON body crashes the server.\n\n## Cause\n\nMissing try/catch around JSON.parse in the middleware.\n\n## Status: FIXED in v1.2.3',
          tags: ['bug', 'api', 'middleware'],
        });
        console.log(`  │ ✅ Bug: API 500 on malformed JSON               │`);

        // Refactor plan
        const refactor1 = humanStore.createNode({
          project,
          label: 'RefactorPlan',
          title: 'Refactor: Extract SessionProvider',
          body_markdown: '## Motivation\n\nSessionProvider is too coupled to auth module.\n\n## Scope\n\n- Extract to src/session/provider.ts\n- Create ISessionStore interface\n- Adapt auth module\n\n## Priority: HIGH',
          tags: ['refactor', 'session', 'high-priority'],
        });
        console.log(`  │ ✅ Refactor: Extract SessionProvider            │`);

        // Convention
        humanStore.createNode({
          project,
          label: 'Convention',
          title: 'Convention: All routes must be prefixed with /api/v2',
          body_markdown: 'All new HTTP routes must be prefixed with `/api/v2`.\nLegacy `/api/v1` routes are deprecated and will be removed in v3.0.',
          tags: ['convention', 'api', 'routing'],
        });
        console.log(`  │ ✅ Convention: /api/v2 prefix                   │`);

        // Legacy note
        humanStore.createNode({
          project,
          label: 'LegacyNote',
          title: 'Legacy: old-billing module is deprecated',
          body_markdown: 'The `old-billing` module is legacy and should not be modified.\nAll new billing logic goes in `billing-v2`.\nDo not add new dependencies to `old-billing`.',
          tags: ['legacy', 'billing'],
        });
        console.log(`  │ ✅ Legacy: old-billing deprecated               │`);

        // Create edges (link ADRs to bugs, refactors)
        humanStore.createEdge({
          project,
          source_human_node_id: adr1.id,
          target_kind: 'human',
          target_human_node_id: bug1.id,
          type: 'MENTIONS',
        });
        humanStore.createEdge({
          project,
          source_human_node_id: refactor1.id,
          target_kind: 'human',
          target_human_node_id: adr2.id,
          type: 'MENTIONS',
        });
        humanStore.createEdge({
          project,
          source_human_node_id: adr2.id,
          target_kind: 'human',
          target_human_node_id: bug1.id,
          type: 'AFFECTS',
        });

        console.log('  └─────────────────────────────────────────────────┘');
        console.log('');

        // Step 2: Generate vault
        console.log('  ┌─ Step 2: Generating Obsidian vault ────────────┐');
        ensureVaultDirs(vaultPath);
        const result = generateVault({
          project,
          vaultPath,
          humanStore,
          backupBeforeWrite: false,
          autoGenerateModuleNotes: false,
          autoGenerateRouteNotes: false,
        });
        console.log(`  │ ✅ Vault generated: ${vaultPath}`);
        console.log(`  │    Notes created: ${result.created.length}`);
        console.log(`  │    Index + ADR template: 2 files`);
        console.log('  └─────────────────────────────────────────────────┘');
        console.log('');

        // Step 3: Show stats
        console.log('  ┌─ Step 3: Project statistics ───────────────────┐');
        console.log(`  │ ADRs:           ${humanStore.countNodes(project, 'ADR')}`);
        console.log(`  │ BugNotes:       ${humanStore.countNodes(project, 'BugNote')}`);
        console.log(`  │ RefactorPlans:  ${humanStore.countNodes(project, 'RefactorPlan')}`);
        console.log(`  │ Conventions:    ${humanStore.countNodes(project, 'Convention')}`);
        console.log(`  │ LegacyNotes:    ${humanStore.countNodes(project, 'LegacyNote')}`);
        console.log(`  │ Total notes:    ${humanStore.countNodes(project)}`);
        console.log(`  │ Total edges:    ${humanStore.countEdges(project)}`);
        console.log('  └─────────────────────────────────────────────────┘');
        console.log('');

        // Step 4: What to do next
        console.log('  ┌─ Next steps ───────────────────────────────────┐');
        console.log('  │ 1. Open the vault in Obsidian:                 │');
        console.log(`  │    ${vaultPath}`);
        console.log('  │                                                │');
        console.log('  │ 2. Edit the HUMAN NOTES sections in the .md    │');
        console.log('  │    files — they will be preserved on re-sync.  │');
        console.log('  │                                                │');
        console.log('  │ 3. Re-sync to import your edits:               │');
        console.log(`  │    cbm-v2 obsidian sync --project ${project}`);
        console.log('  │                                                │');
        console.log('  │ 4. Start the MCP server for AI agents:         │');
        console.log(`  │    cbm-v2 mcp --project ${project}`);
        console.log('  │                                                │');
        console.log('  │ 5. View stats:                                 │');
        console.log(`  │    cbm-v2 stats --project ${project}`);
        if (cleanup) {
          console.log('  │                                                │');
          console.log('  │ Note: demo files will be cleaned up.           │');
          console.log('  │ Use --keep to preserve them.                   │');
        }
        console.log('  └─────────────────────────────────────────────────┘');
        console.log('');
            } catch (e: any) {
        console.error('Error: ' + e.message);
        process.exitCode = 1;
        humanStore.close();
        return;
      }

      // Cleanup
      if (cleanup) {
        try {
          rmSync(vaultPath, { recursive: true, force: true });
          // Also clean the demo DB
          const dbFile = defaultHumanDbPath(project);
          rmSync(dbFile, { force: true });
          rmSync(dbFile + '-wal', { force: true });
          rmSync(dbFile + '-shm', { force: true });
        } catch {
          // ignore
        }
      }
    });
}
