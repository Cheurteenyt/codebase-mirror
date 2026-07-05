// v2/tests/human/store.test.ts (additions)
// Additional tests for slug collision, edge dedup, cross-project rejection,
// JSON corruption resilience, markSynced.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HumanMemoryStore } from '../../src/human/store.js';
import { createHash } from 'node:crypto';

describe('HumanMemoryStore — additional bug-regression tests', () => {
  let store: HumanMemoryStore;

  beforeEach(() => {
    store = HumanMemoryStore.openMemory();
  });

  afterEach(() => {
    store.close();
  });

  describe('slug collision handling', () => {
    it('auto-suffixes slug on collision', () => {
      const n1 = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Use JWT',
      });
      const n2 = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Use JWT',
      });
      expect(n1.slug).toBe('use-jwt');
      expect(n2.slug).toBe('use-jwt-2');
      expect(n1.id).not.toBe(n2.id);
    });

    it('handles multiple collisions with -3, -4, etc.', () => {
      store.createNode({ project: 'test', label: 'ADR', title: 'Same Title' });
      store.createNode({ project: 'test', label: 'ADR', title: 'Same Title' });
      const n3 = store.createNode({ project: 'test', label: 'ADR', title: 'Same Title' });
      expect(n3.slug).toBe('same-title-3');
    });

    it('rejects empty title', () => {
      expect(() => store.createNode({ project: 'test', label: 'ADR', title: '' })).toThrow(/empty title/i);
      expect(() => store.createNode({ project: 'test', label: 'ADR', title: '   ' })).toThrow(/empty title/i);
    });

    it('rejects title with newlines', () => {
      expect(() => store.createNode({ project: 'test', label: 'ADR', title: 'title\nwith newline' })).toThrow(/newline/i);
    });

    it('falls back to a stable slug for non-Latin titles', () => {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: '日本語のタイトル',
      });
      expect(node.slug).toBeTruthy();
      expect(node.slug.length).toBeGreaterThan(0);
    });

    it('truncates very long titles to 200 chars', () => {
      const longTitle = 'A'.repeat(300);
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: longTitle,
      });
      expect(node.slug.length).toBeLessThanOrEqual(200);
    });
  });

  describe('obsidian_path validation', () => {
    it('rejects obsidian_path with ..', () => {
      expect(() =>
        store.createNode({
          project: 'test',
          label: 'ADR',
          title: 'Test',
          obsidian_path: '../../../etc/passwd',
        })
      ).toThrow(/\.\.|path traversal|backslash/i);
    });

    it('rejects obsidian_path with backslashes', () => {
      expect(() =>
        store.createNode({
          project: 'test',
          label: 'ADR',
          title: 'Test',
          obsidian_path: 'foo\\bar.md',
        })
      ).toThrow(/backslash|path traversal/i);
    });
  });

  describe('edge dedup', () => {
    it('returns existing edge on duplicate creation', () => {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Test',
        cbm_node_ids: [42],
      });
      const e1 = store.createEdge({
        project: 'test',
        source_human_node_id: node.id,
        target_kind: 'code',
        target_cbm_node_id: 42,
        type: 'DECIDES',
      });
      const e2 = store.createEdge({
        project: 'test',
        source_human_node_id: node.id,
        target_kind: 'code',
        target_cbm_node_id: 42,
        type: 'DECIDES',
      });
      expect(e1.id).toBe(e2.id); // same edge returned
    });

    it('allows different edge types between same nodes', () => {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Test',
        cbm_node_ids: [42],
      });
      const e1 = store.createEdge({
        project: 'test',
        source_human_node_id: node.id,
        target_kind: 'code',
        target_cbm_node_id: 42,
        type: 'DECIDES',
      });
      const e2 = store.createEdge({
        project: 'test',
        source_human_node_id: node.id,
        target_kind: 'code',
        target_cbm_node_id: 42,
        type: 'MENTIONS',
      });
      expect(e1.id).not.toBe(e2.id);
    });
  });

  describe('cross-project edge rejection', () => {
    it('rejects edge when source node belongs to a different project', () => {
      const node = store.createNode({
        project: 'projectA',
        label: 'ADR',
        title: 'Test',
      });
      expect(() =>
        store.createEdge({
          project: 'projectB', // wrong project!
          source_human_node_id: node.id,
          target_kind: 'code',
          target_cbm_node_id: 42,
          type: 'DECIDES',
        })
      ).toThrow(/cross-project/i);
    });

    it('rejects edge when source node does not exist', () => {
      expect(() =>
        store.createEdge({
          project: 'test',
          source_human_node_id: 99999, // doesn't exist
          target_kind: 'code',
          target_cbm_node_id: 42,
          type: 'DECIDES',
        })
      ).toThrow(/not found/i);
    });
  });

  describe('JSON corruption resilience', () => {
    it('returns empty arrays when cbm_node_ids JSON is corrupt', () => {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Test',
        cbm_node_ids: [1, 2, 3],
      });
      // Corrupt the JSON directly in the DB.
      store.getRawDb()
        .prepare('UPDATE human_nodes SET cbm_node_ids = ? WHERE id = ?')
        .run('{corrupt json', node.id);
      const retrieved = store.getNodeById(node.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.cbm_node_ids).toEqual([]); // graceful fallback
    });

    it('returns empty arrays when tags JSON is corrupt', () => {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Test',
        tags: ['foo', 'bar'],
      });
      store.getRawDb()
        .prepare('UPDATE human_nodes SET tags = ? WHERE id = ?')
        .run('not json at all', node.id);
      const retrieved = store.getNodeById(node.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.tags).toEqual([]);
    });
  });

  describe('markSynced', () => {
    it('records sync_state on export (default hash)', () => {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Test',
      });
      store.markSynced(node.id, 'export');
      const rows = store.getRawDb()
        .prepare('SELECT * FROM sync_state WHERE project = ? AND obsidian_path = ?')
        .all('test', node.obsidian_path) as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].last_direction).toBe('export');
      expect(rows[0].last_synced_hash).toBeTruthy();
    });

    it('records sync_state on import with DB-derived hash (ignores vaultContentHash param)', () => {
      // R14 fix: markSynced now ALWAYS computes the hash from the DB representation
      // (body + frontmatter + cbm_ids + tags), regardless of direction. The
      // vaultContentHash parameter is accepted for API compatibility but ignored.
      // This ensures export and import produce the SAME hash for the same DB state,
      // making conflict detection actually work.
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Test',
      });
      const vaultHash = createHash('sha256').update('vault content').digest('hex');
      store.markSynced(node.id, 'import', vaultHash);
      const rows = store.getRawDb()
        .prepare('SELECT * FROM sync_state WHERE project = ? AND obsidian_path = ?')
        .all('test', node.obsidian_path) as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].last_direction).toBe('import');
      // The stored hash should NOT be the vault hash — it should be the DB-derived hash.
      expect(rows[0].last_synced_hash).not.toBe(vaultHash);
      expect(rows[0].last_synced_hash).toBeTruthy();
      // Verify the hash matches what we'd compute from the DB node.
      const expectedHash = createHash('sha256')
        .update(node.body_markdown)
        .update('\x00')
        .update(node.frontmatter_json)
        .update('\x00')
        .update([...node.cbm_node_ids].sort((a, b) => a - b).join(','))
        .update('\x00')
        .update([...node.tags].sort().join(','))
        .digest('hex');
      expect(rows[0].last_synced_hash).toBe(expectedHash);
    });
  });

  describe('deleteStaleEdgesFromNode', () => {
    it('deletes edges that were not seen in this pass', () => {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Test',
        cbm_node_ids: [1, 2, 3],
      });
      const e1 = store.createEdge({
        project: 'test',
        source_human_node_id: node.id,
        target_kind: 'code',
        target_cbm_node_id: 1,
        type: 'MENTIONS',
        source_file: 'ADR/test.md',
      });
      const e2 = store.createEdge({
        project: 'test',
        source_human_node_id: node.id,
        target_kind: 'code',
        target_cbm_node_id: 2,
        type: 'MENTIONS',
        source_file: 'ADR/test.md',
      });
      // Simulate: keep only e1 (e2 was removed from the note).
      const deleted = store.deleteStaleEdgesFromNode(node.id, 'ADR/test.md', [e1.id]);
      expect(deleted).toBe(1);
      const remaining = store.listEdgesFromNode(node.id);
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe(e1.id);
    });
  });

  describe('error messages', () => {
    it('includes valid labels in error message', () => {
      try {
        store.createNode({ project: 'test', label: 'InvalidLabel' as any, title: 'Test' });
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).toMatch(/Invalid human node label/i);
        expect(e.message).toContain('ADR');
        expect(e.message).toContain('BugNote');
      }
    });

    it('includes valid edge types in error message', () => {
      const node = store.createNode({ project: 'test', label: 'ADR', title: 'Test' });
      try {
        store.createEdge({
          project: 'test',
          source_human_node_id: node.id,
          target_kind: 'code',
          target_cbm_node_id: 1,
          type: 'INVALID_TYPE' as any,
        });
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).toMatch(/Invalid human edge type/i);
        expect(e.message).toContain('DECIDES');
        expect(e.message).toContain('MENTIONS');
      }
    });

    it('includes offending value in target validation error', () => {
      const node = store.createNode({ project: 'test', label: 'ADR', title: 'Test' });
      try {
        store.createEdge({
          project: 'test',
          source_human_node_id: node.id,
          target_kind: 'code',
          target_cbm_node_id: null,
          type: 'DECIDES',
        });
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('target_cbm_node_id required');
        expect(e.message).toContain('null'); // includes the offending value
      }
    });
  });
});
