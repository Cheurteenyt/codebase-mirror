// v2/tests/obsidian/sync-conflict.test.ts
// Tests for bidirectional sync conflict scenarios.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HumanMemoryStore } from '../../src/human/store.js';
import { generateVault } from '../../src/obsidian/generator.js';
import { importVault } from '../../src/obsidian/importer.js';
import { readNote, walkVault, ensureVaultDirs } from '../../src/obsidian/vault.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Sync conflict scenarios', () => {
  let humanStore: HumanMemoryStore;
  let vaultPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cbm-v2-conflict-'));
    vaultPath = join(tmpDir, 'vault');
    ensureVaultDirs(vaultPath);
    humanStore = HumanMemoryStore.openMemory();
  });

  afterEach(() => {
    humanStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves HUMAN NOTES when DB body changes (export regenerates AUTO-GENERATED only)', () => {
    const node = humanStore.createNode({
      project: 'test',
      label: 'ModuleNote',
      title: 'Module: auth',
      body_markdown: 'Original DB body',
    });

    // First export.
    generateVault({
      project: 'test',
      vaultPath,
      humanStore,
      backupBeforeWrite: false,
      autoGenerateModuleNotes: false,
      autoGenerateRouteNotes: false,
    });

    // User edits HUMAN NOTES in vault.
    const notePath = node.obsidian_path!;
    const initialContent = readNote(vaultPath, notePath)!;
    const editedContent = initialContent.replace(
      /## HUMAN NOTES[\s\S]*$/,
      '## HUMAN NOTES\n\nMy critical decision: use JWT.\n'
    );
    writeFileSync(join(vaultPath, notePath), editedContent, 'utf-8');

    // Update the DB body (simulating agent IA creating the note with body).
    humanStore.updateNode(node.id, { body_markdown: 'Updated DB body from agent' });

    // Re-export — should preserve the user's HUMAN NOTES.
    generateVault({
      project: 'test',
      vaultPath,
      humanStore,
      backupBeforeWrite: false,
      autoGenerateModuleNotes: false,
      autoGenerateRouteNotes: false,
    });

    const finalContent = readNote(vaultPath, notePath)!;
    expect(finalContent).toContain('My critical decision: use JWT.');
    // The DB body is in the AUTO-GENERATED section now? No — the DB body_markdown
    // is what goes into HUMAN NOTES for non-generated notes. Let me check the logic:
    // In generator.ts renderNoteForVault, body_markdown goes into mergeSections(`# ${node.title}`, autoContent, node.body_markdown)
    // — so body_markdown IS the HUMAN NOTES content for human-authored notes.
    // When we re-export with preserveSections, the user's vault HUMAN NOTES wins.
    expect(finalContent).not.toContain('Updated DB body from agent');
  });

  it('imports vault HUMAN NOTES back into DB on import direction', () => {
    const node = humanStore.createNode({
      project: 'test',
      label: 'ModuleNote',
      title: 'Module: auth',
      body_markdown: '',
    });

    // Export to create the file.
    generateVault({
      project: 'test',
      vaultPath,
      humanStore,
      backupBeforeWrite: false,
      autoGenerateModuleNotes: false,
      autoGenerateRouteNotes: false,
    });

    // User edits HUMAN NOTES.
    const notePath = node.obsidian_path!;
    const initialContent = readNote(vaultPath, notePath)!;
    const editedContent = initialContent.replace(
      /## HUMAN NOTES[\s\S]*$/,
      '## HUMAN NOTES\n\nImported human content.\n'
    );
    writeFileSync(join(vaultPath, notePath), editedContent, 'utf-8');

    // Import.
    const result = importVault({
      project: 'test',
      vaultPath,
      humanStore,
    });

    expect(result.updated).toContain(notePath);
    const updatedNode = humanStore.getNodeById(node.id);
    expect(updatedNode!.body_markdown).toContain('Imported human content');
  });

  it('detects no-op imports (no changes → unchanged)', () => {
    const node = humanStore.createNode({
      project: 'test',
      label: 'ADR',
      title: 'ADR-001: Test',
      body_markdown: 'Original body',
      tags: ['adr'],
    });

    // Export.
    generateVault({
      project: 'test',
      vaultPath,
      humanStore,
      backupBeforeWrite: false,
      autoGenerateModuleNotes: false,
      autoGenerateRouteNotes: false,
    });

    // Import without modifying the vault — should be unchanged.
    const result = importVault({
      project: 'test',
      vaultPath,
      humanStore,
    });

    expect(result.unchanged).toContain(node.obsidian_path);
    expect(result.updated).not.toContain(node.obsidian_path);
  });

  it('deletes stale edges when wikilinks are removed from a note', () => {
    const node = humanStore.createNode({
      project: 'test',
      label: 'ADR',
      title: 'ADR-002: Links',
      body_markdown: 'See [[1]] and [[2]].',
      cbm_node_ids: [],
    });

    // Export to create the file with both wikilinks.
    generateVault({
      project: 'test',
      vaultPath,
      humanStore,
      backupBeforeWrite: false,
      autoGenerateModuleNotes: false,
      autoGenerateRouteNotes: false,
    });

    // Import to create edges from wikilinks.
    let result = importVault({
      project: 'test',
      vaultPath,
      humanStore,
    });
    expect(result.edgesCreated).toBeGreaterThanOrEqual(2);

    // Verify edges exist.
    const edgesAfterCreate = humanStore.listEdgesFromNode(node.id);
    expect(edgesAfterCreate.length).toBeGreaterThanOrEqual(2);

    // Remove [[2]] from the note.
    const notePath = node.obsidian_path!;
    const content = readNote(vaultPath, notePath)!;
    const editedContent = content.replace('and [[2]]', '');
    writeFileSync(join(vaultPath, notePath), editedContent, 'utf-8');

    // Re-import.
    result = importVault({
      project: 'test',
      vaultPath,
      humanStore,
    });
    expect(result.edgesDeleted).toBeGreaterThanOrEqual(1);

    // The edge to cbm_node_id=2 should be gone.
    const edgesAfterDelete = humanStore.listEdgesFromNode(node.id);
    const hasEdgeTo2 = edgesAfterDelete.some((e) => e.target_cbm_node_id === 2);
    expect(hasEdgeTo2).toBe(false);
  });

  it('does not crash on a vault with no notes', () => {
    const result = importVault({
      project: 'test',
      vaultPath,
      humanStore,
    });
    expect(result.created).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
