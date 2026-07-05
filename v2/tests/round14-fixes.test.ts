// v2/tests/round14-fixes.test.ts
// Regression tests for bugs found and fixed in Round 14.

import { describe, it, expect } from 'vitest';
import { safeJsonParse } from '../src/constants.js';
import { computeRiskScore } from '../src/reports/risk.js';
import { HumanMemoryStore } from '../src/human/store.js';
import { parseWikilinks, inferEdgeTypeFromContext } from '../src/obsidian/wikilinks.js';

describe('R14: safeJsonParse array validation', () => {
  it('returns default [] for null JSON', () => {
    expect(safeJsonParse('null', [])).toEqual([]);
  });

  it('returns default [] for non-array JSON', () => {
    expect(safeJsonParse('"hello"', [])).toEqual([]);
    expect(safeJsonParse('42', [])).toEqual([]);
    expect(safeJsonParse('true', [])).toEqual([]);
    expect(safeJsonParse('{}', [])).toEqual([]);
  });

  it('returns parsed array for valid JSON array', () => {
    expect(safeJsonParse('[1, 2, 3]', [])).toEqual([1, 2, 3]);
    expect(safeJsonParse('["a", "b"]', [])).toEqual(['a', 'b']);
  });

  it('returns default object for null JSON', () => {
    expect(safeJsonParse('null', { a: 1 })).toEqual({ a: 1 });
  });

  it('returns default object for array JSON when default is object', () => {
    expect(safeJsonParse('[1,2]', { a: 1 })).toEqual({ a: 1 });
  });
});

describe('R14: computeRiskScore dead code fix', () => {
  it('returns 0.0 for dead code (degree=0) even without docs', () => {
    // Previously this returned 0.2 — penalizing dead code for being undocumented.
    // Dead code doesn't need documentation; the penalty is now gated on degree > 0.
    expect(computeRiskScore(0, 0, 0)).toBeCloseTo(0.0, 5);
    expect(computeRiskScore(0, 15, 0)).toBeCloseTo(0.225, 5); // complexity only, no penalty
  });

  it('penalizes live code (degree>0) for missing docs', () => {
    expect(computeRiskScore(10, 0, 0)).toBeCloseTo(0.25, 5); // 0.05 + 0.2
    expect(computeRiskScore(50, 10, 0)).toBeCloseTo(0.6, 5); // 0.25 + 0.15 + 0.2
  });

  it('does not penalize live code WITH docs', () => {
    expect(computeRiskScore(50, 10, 3)).toBeCloseTo(0.4, 5); // 0.25 + 0.15 + 0
  });
});

describe('R14: markSynced consistent hash', () => {
  it('produces the SAME hash for export and import on the same DB state', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Hash Consistency Test',
        body_markdown: 'body content',
        tags: ['tag1', 'tag2'],
        cbm_node_ids: [42, 17],
      });

      // Export sync
      store.markSynced(node.id, 'export');
      const exportRows = store.getRawDb()
        .prepare('SELECT last_synced_hash FROM sync_state WHERE project = ? AND obsidian_path = ?')
        .all('test', node.obsidian_path) as any[];
      const exportHash = exportRows[0].last_synced_hash;

      // Import sync (with a bogus vault hash that should be IGNORED)
      store.markSynced(node.id, 'import', 'bogus-vault-hash-that-should-be-ignored');
      const importRows = store.getRawDb()
        .prepare('SELECT last_synced_hash FROM sync_state WHERE project = ? AND obsidian_path = ?')
        .all('test', node.obsidian_path) as any[];
      const importHash = importRows[0].last_synced_hash;

      // Both directions must produce the same hash (computed from DB state).
      expect(exportHash).toBe(importHash);
      expect(exportHash).not.toBe('bogus-vault-hash-that-should-be-ignored');
    } finally {
      store.close();
    }
  });
});

describe('R14: updateNode no-op guard', () => {
  it('does NOT bump updated_at when no fields are provided', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'No-Op Test',
      });
      const originalUpdatedAt = node.updated_at;

      // Wait a tiny bit to ensure a new ISO timestamp would differ.
      const result = store.updateNode(node.id, {});
      expect(result).not.toBeNull();
      expect(result!.updated_at).toBe(originalUpdatedAt);
    } finally {
      store.close();
    }
  });

  it('DOES bump updated_at when a field changes', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Update Test',
      });
      const originalUpdatedAt = node.updated_at;

      // Wait 10ms to ensure timestamp differs.
      const start = Date.now();
      while (Date.now() - start < 10) { /* spin */ }

      const result = store.updateNode(node.id, { title: 'Updated Title' });
      expect(result).not.toBeNull();
      expect(result!.updated_at).not.toBe(originalUpdatedAt);
      expect(result!.title).toBe('Updated Title');
    } finally {
      store.close();
    }
  });
});

describe('R14: inferEdgeTypeFromContext respects code fences', () => {
  it('ignores # headings inside fenced code blocks', () => {
    const markdown = [
      '## HUMAN NOTES',
      '',
      'Some intro text.',
      '',
      '```bash',
      '# This is a comment, not a heading',
      'export FOO=bar',
      '```',
      '',
      '[[42]]',
    ].join('\n');

    const wikilinks = parseWikilinks(markdown);
    expect(wikilinks.length).toBe(1);
    const edgeType = inferEdgeTypeFromContext(markdown, wikilinks[0]);
    // The last heading BEFORE the wikilink (outside fences) is "## HUMAN NOTES".
    // "HUMAN NOTES" doesn't match any keyword, so default MENTIONS.
    expect(edgeType).toBe('MENTIONS');
  });

  it('detects heading after a closed code fence', () => {
    const markdown = [
      '```python',
      '# python comment',
      'x = 1',
      '```',
      '',
      '### Décisions',
      '',
      '[[42]]',
    ].join('\n');

    const wikilinks = parseWikilinks(markdown);
    expect(wikilinks.length).toBe(1);
    const edgeType = inferEdgeTypeFromContext(markdown, wikilinks[0]);
    expect(edgeType).toBe('DECIDES');
  });
});
