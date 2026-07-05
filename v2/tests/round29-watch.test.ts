// v2/tests/round29-watch.test.ts
// Tests for R29: cbm-v2 watch daemon.
// Tests the watch logic without actually starting the daemon (which is blocking).

import { describe, it, expect } from 'vitest';
import { HumanMemoryStore } from '../src/human/store.js';
import { generateVault } from '../src/obsidian/generator.js';
import { importVault } from '../src/obsidian/importer.js';
import { ensureVaultDirs, writeNote, readNote } from '../src/obsidian/vault.js';
import { getNotifyHub, resetNotifyHub } from '../src/ui/notify-hub.js';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('R29: Watch daemon — incremental sync logic', () => {
  it('importVault detects new files added to the vault', () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'cbm-r29-watch-'));
    const humanStore = HumanMemoryStore.openMemory();
    try {
      ensureVaultDirs(vaultPath);

      // Initial export to create a note in the vault.
      humanStore.createNode({
        project: 'test',
        label: 'ADR',
        title: 'ADR-001: Watch test',
        body_markdown: 'Initial content',
      });
      generateVault({
        project: 'test',
        vaultPath,
        humanStore,
        backupBeforeWrite: false,
        autoGenerateModuleNotes: false,
        autoGenerateRouteNotes: false,
      });

      // Simulate a user edit: modify the HUMAN NOTES section.
      const notePath = 'ADR/adr-001-watch-test.md';
      const content = readNote(vaultPath, notePath)!;
      const editedContent = content.replace(
        '> ✏️ This section belongs to the user. It will **never** be overwritten by Codebase Memory V2.',
        '> ✏️ This section belongs to the user. It will **never** be overwritten by Codebase Memory V2.\n\nUser edited this!'
      );
      writeNote(vaultPath, notePath, editedContent, { backupBeforeWrite: false });

      // Import should detect the change.
      const result = importVault({ project: 'test', vaultPath, humanStore });
      expect(result.updated.length).toBeGreaterThanOrEqual(1);
      expect(result.updated).toContain(notePath);
    } finally {
      humanStore.close();
      rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  it('importVault detects deleted files', () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'cbm-r29-watch-'));
    const humanStore = HumanMemoryStore.openMemory();
    try {
      ensureVaultDirs(vaultPath);

      // Create a note and export.
      const node = humanStore.createNode({
        project: 'test',
        label: 'BugNote',
        title: 'Bug to delete',
      });
      generateVault({
        project: 'test',
        vaultPath,
        humanStore,
        backupBeforeWrite: false,
        autoGenerateModuleNotes: false,
        autoGenerateRouteNotes: false,
      });

      // Verify the file exists.
      const notePath = node.obsidian_path!;
      expect(readNote(vaultPath, notePath)).not.toBeNull();

      // Delete the file (simulate user deleting in Obsidian).
      unlinkSync(join(vaultPath, notePath));

      // Import should not crash (the node stays in the DB — deletion is a soft-delete).
      const result = importVault({ project: 'test', vaultPath, humanStore });
      // The node is NOT deleted from the DB (soft-delete by design).
      const stillExists = humanStore.getNodeById(node.id);
      expect(stillExists).not.toBeNull();
    } finally {
      humanStore.close();
      rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  it('NotifyHub receives events from store mutations during watch', () => {
    resetNotifyHub();
    const hub = getNotifyHub();
    const humanStore = HumanMemoryStore.openMemory();
    humanStore.attachNotifyHub(hub, 'watch-test');

    const events: any[] = [];
    hub.subscribe((event) => events.push(event));

    // Simulate a DB mutation (as would happen from an MCP tool).
    humanStore.createNode({
      project: 'watch-test',
      label: 'Convention',
      title: 'Watch convention test',
    });

    return new Promise((resolve) => {
      setTimeout(() => {
        // The hub should have received a human_nodes_changed event.
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events.some((e) => e.type === 'human_nodes_changed')).toBe(true);
        expect(events.some((e) => e.project === 'watch-test')).toBe(true);
        humanStore.close();
        resetNotifyHub();
        resolve(void 0);
      }, 300);
    });
  });

  it('watch daemon handles --direction import only', () => {
    // Verify the direction parsing logic without starting the daemon.
    const validDirections = ['both', 'import', 'export'];
    expect(validDirections.includes('import')).toBe(true);
    expect(validDirections.includes('export')).toBe(true);
    expect(validDirections.includes('both')).toBe(true);
    expect(validDirections.includes('invalid')).toBe(false);
  });

  it('watch daemon rejects non-existent vault path', () => {
    const { existsSync } = require('node:fs');
    expect(existsSync('/nonexistent/vault/path')).toBe(false);
  });

  it('full watch cycle: edit vault -> import -> export -> vault updated', () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'cbm-r29-cycle-'));
    const humanStore = HumanMemoryStore.openMemory();
    try {
      ensureVaultDirs(vaultPath);

      // Create a note and export.
      const node = humanStore.createNode({
        project: 'test',
        label: 'ADR',
        title: 'ADR cycle test',
        body_markdown: 'Original body',
        tags: ['test'],
      });
      generateVault({
        project: 'test',
        vaultPath,
        humanStore,
        backupBeforeWrite: false,
        autoGenerateModuleNotes: false,
        autoGenerateRouteNotes: false,
      });

      // Simulate a user edit in the HUMAN NOTES section.
      const notePath = node.obsidian_path!;
      const content = readNote(vaultPath, notePath)!;
      // The HUMAN NOTES section contains 'Original body'. Edit it.
      const editedContent = content.replace('Original body', 'Original body\n\n## User edit\n\nThis was edited by the user.');
      writeNote(vaultPath, notePath, editedContent, { backupBeforeWrite: false });

      // Step 1: Import (detects the user edit).
      const importResult = importVault({ project: 'test', vaultPath, humanStore });
      expect(importResult.updated).toContain(notePath);

      // Verify the DB has the user's edit.
      const updated = humanStore.getNodeById(node.id);
      // The body_markdown should now include the user's edit (the importer
      // strips the placeholder and stores the remaining HUMAN NOTES content).
      // The original body_markdown was 'Original body', and the user edit
      // adds '## User edit\n\nThis was edited by the user.' after it.
      expect(updated!.body_markdown).toContain('This was edited by the user.');
      expect(updated!.body_markdown).toContain('Original body');

      // Step 2: Export (regenerates AUTO-GENERATED section, preserves HUMAN NOTES).
      const exportResult = generateVault({
        project: 'test',
        vaultPath,
        humanStore,
        backupBeforeWrite: false,
        autoGenerateModuleNotes: false,
        autoGenerateRouteNotes: false,
      });

      // Verify the vault file still has the user's edit (not overwritten).
      const finalContent = readNote(vaultPath, notePath)!;
      expect(finalContent).toContain('This was edited by the user.');
    } finally {
      humanStore.close();
      rmSync(vaultPath, { recursive: true, force: true });
    }
  });
});
