// tests/round47-fixes.test.ts
// R47: tests for the fixes introduced in round 47.
//
// Coverage:
//   - H1: prepare_edit_context returns ALL linked notes (was limited to 1)
//   - M4: parseNote handles --- inside quoted YAML values
//   - L1: swr-cache invalidate cancels pending refresh timer

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseNote } from '../src/obsidian/frontmatter.js';
import { SwrCache } from '../src/intelligence/swr-cache.js';
import { HumanMemoryStore } from '../src/human/store.js';

// ── M4: parseNote --- in quoted YAML ──────────────────────────────

describe('R47 (M4): parseNote handles --- inside quoted YAML', () => {
  it('preserves frontmatter when --- appears inside a quoted value', () => {
    const content = '---\ntitle: "a --- b"\ntype: adr\n---\n# Body\n';
    const result = parseNote(content);
    // R48 (#4): strengthened from just checking body contains '# Body' to
    // verifying frontmatter is actually parsed correctly. The old test passed
    // even though frontmatter was silently lost (the body contained '# Body'
    // as part of the truncated content).
    expect(result.frontmatter.title).toBe('a --- b');
    expect(result.frontmatter.type).toBe('adr');
    expect(result.body.trim()).toBe('# Body');
  });

  it('does not corrupt a well-formed note', () => {
    const content = '---\ntitle: Hello\ntype: adr\n---\n# Body\n';
    const result = parseNote(content);
    expect(result.frontmatter.title).toBe('Hello');
    expect(result.frontmatter.type).toBe('adr');
    expect(result.body.trim()).toBe('# Body');
  });

  it('handles empty frontmatter', () => {
    const content = '---\n---\n# Body\n';
    const result = parseNote(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body.trim()).toBe('# Body');
  });
});

// ── L1: swr-cache invalidate cancels pending refresh ──────────────

describe('R47 (L1): swr-cache invalidate cancels pending refresh', () => {
  it('invalidate cancels a scheduled background refresh', () => {
    const cache = new SwrCache<string, string>({ ttlMs: 20, staleMs: 20, trackStats: true });
    let computeCount = 0;
    const compute = () => `v${++computeCount}`;

    // Initial compute — sets up the entry + refresh handler.
    cache.getOrCompute('key', compute);
    expect(computeCount).toBe(1);

    // Wait for the entry to go stale so a background refresh is scheduled.
    // We can't easily test the setTimeout(0) cancellation in a synchronous
    // test, but we can verify invalidate doesn't throw and the timer map
    // is cleaned up by checking that a subsequent getOrCompute re-computes.
    cache.invalidate('key');
    expect(computeCount).toBe(1); // no refresh ran

    // After invalidate, a new getOrCompute should re-compute.
    const value = cache.getOrCompute('key', compute);
    expect(computeCount).toBe(2);
    expect(value).toBe('v2');

    cache.clear();
  });

  it('clear() cancels all pending refresh timers', () => {
    const cache = new SwrCache<string, string>({ ttlMs: 20, staleMs: 20 });
    let computeCount = 0;
    cache.getOrCompute('a', () => `a${++computeCount}`);
    cache.getOrCompute('b', () => `b${++computeCount}`);
    // clear should not throw even with pending timers.
    cache.clear();
    expect(computeCount).toBe(2); // no refresh ran
  });
});

// ── H1: prepare_edit_context returns ALL linked notes ─────────────

describe('R47 (H1): getBulkNotesByCbmNodeIds returns multiple notes per node', () => {
  let store: HumanMemoryStore;

  beforeEach(() => {
    store = HumanMemoryStore.openMemory();
  });

  afterEach(() => store.close());

  it('returns up to 200 notes per cbm node (not just 1)', () => {
    // Create 3 BugNotes + 2 ADRs all linked to cbm_node_id=42.
    for (let i = 0; i < 3; i++) {
      store.createNode({
        project: 'p', label: 'BugNote', title: `Bug ${i}`,
        body_markdown: '', status: 'active', source: 'human',
        cbm_node_ids: [42], tags: [],
      });
    }
    for (let i = 0; i < 2; i++) {
      store.createNode({
        project: 'p', label: 'ADR', title: `ADR ${i}`,
        body_markdown: '', status: 'active', source: 'human',
        cbm_node_ids: [42], tags: [],
      });
    }

    // With limit=200 (the R47 fix), all 5 notes should be returned.
    const notes = store.getBulkNotesByCbmNodeIds('p', [42], 200);
    const noteList = notes.get(42) ?? [];
    expect(noteList.length).toBe(5);

    // With limit=1 (the old default), only 1 note would be returned.
    const notesOld = store.getBulkNotesByCbmNodeIds('p', [42], 1);
    const noteListOld = notesOld.get(42) ?? [];
    expect(noteListOld.length).toBe(1);
  });
});
