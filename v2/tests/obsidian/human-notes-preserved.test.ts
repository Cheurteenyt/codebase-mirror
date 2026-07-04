// v2/tests/obsidian/human-notes-preserved.test.ts
// CRITICAL regression test: ## HUMAN NOTES section must NEVER be overwritten.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HumanMemoryStore } from '../../src/human/store.js';
import { generateVault } from '../../src/obsidian/generator.js';
import { importVault } from '../../src/obsidian/importer.js';
import { readNote, walkVault, ensureVaultDirs } from '../../src/obsidian/vault.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CRITICAL: ## HUMAN NOTES section preservation', () => {
  let humanStore: HumanMemoryStore;
  let vaultPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cbm-v2-test-'));
    vaultPath = join(tmpDir, 'vault');
    ensureVaultDirs(vaultPath);

    // Use in-memory DB
    humanStore = HumanMemoryStore.openMemory();
  });

  afterEach(() => {
    humanStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves HUMAN NOTES content across multiple syncs', () => {
    // 1. Create initial note
    const node = humanStore.createNode({
      project: 'test-app',
      label: 'ModuleNote',
      title: 'Module: auth',
      body_markdown: '',
      source: 'human',
      cbm_node_ids: [],
      tags: ['module'],
    });

    // 2. First sync — generates the note
    const r1 = generateVault({
      project: 'test-app',
      vaultPath,
      humanStore,
      backupBeforeWrite: true,
      autoGenerateModuleNotes: false,
      autoGenerateRouteNotes: false,
    });
    expect(r1.created).toContain('Modules/module-auth.md');

    // 3. Manually edit HUMAN NOTES section
    const notePath = 'Modules/module-auth.md';
    const initialContent = readNote(vaultPath, notePath)!;
    expect(initialContent).toContain('## HUMAN NOTES');

    const modifiedContent = initialContent.replace(
      /## HUMAN NOTES[\s\S]*$/,
      '## HUMAN NOTES\n\n### My critical decision\n\nWe use JWT because X.\n'
    );
    writeFileSync(join(vaultPath, notePath), modifiedContent, 'utf-8');

    // 4. Re-sync — should NOT touch HUMAN NOTES
    const r2 = generateVault({
      project: 'test-app',
      vaultPath,
      humanStore,
      backupBeforeWrite: true,
      autoGenerateModuleNotes: false,
      autoGenerateRouteNotes: false,
    });
    expect(r2.updated).toContain(notePath);

    // 5. Verify HUMAN NOTES is preserved
    const finalContent = readNote(vaultPath, notePath)!;
    expect(finalContent).toContain('## HUMAN NOTES');
    expect(finalContent).toContain('### My critical decision');
    expect(finalContent).toContain('We use JWT because X.');
  });

  it('creates backup before modifying', () => {
    const node = humanStore.createNode({
      project: 'test-app',
      label: 'ADR',
      title: 'ADR-001: Test',
      body_markdown: '',
      source: 'human',
      cbm_node_ids: [],
      tags: ['adr'],
    });

    // First sync
    generateVault({
      project: 'test-app',
      vaultPath,
      humanStore,
      backupBeforeWrite: true,
      autoGenerateModuleNotes: false,
      autoGenerateRouteNotes: false,
    });

    // Update node body → triggers backup on next sync
    humanStore.updateNode(node.id, { body_markdown: 'Updated content' });

    const r = generateVault({
      project: 'test-app',
      vaultPath,
      humanStore,
      backupBeforeWrite: true,
      autoGenerateModuleNotes: false,
      autoGenerateRouteNotes: false,
    });

    expect(r.backups.length).toBeGreaterThan(0);
  });

  it('imports HUMAN NOTES section back into DB', () => {
    // 1. Create a note in the vault manually
    const noteContent = `---
type: module
status: active
source: human
cbm_node_id: 1234
tags:
  - module
  - auth
---

# Module: auth

## AUTO-GENERATED

Some auto content.

---

## HUMAN NOTES

This is my human-edited content. Do not overwrite.
`;
    writeFileSync(join(vaultPath, 'Modules', 'auth.md'), noteContent, 'utf-8');

    // 2. Import
    const result = importVault({
      project: 'test-app',
      vaultPath,
      humanStore,
      dryRun: false,
    });

    expect(result.created).toContain('Modules/auth.md');
    const node = humanStore.getNodeByObsidianPath('test-app', 'Modules/auth.md');
    expect(node).not.toBeNull();
    expect(node!.body_markdown).toContain('This is my human-edited content');
    expect(node!.cbm_node_ids).toContain(1234);
  });
});
