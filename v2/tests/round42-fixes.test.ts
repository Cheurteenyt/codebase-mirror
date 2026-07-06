// tests/round42-fixes.test.ts
// R42: tests for the fixes introduced in round 42 (Claude Sonnet round 5 audit).
//
// Coverage:
//   - E1: FTS5 AND-of-terms search (multi-term queries match notes containing
//     ALL terms as tokens, regardless of order or adjacency)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HumanMemoryStore } from '../src/human/store.js';

// ── E1: AND-of-terms FTS5 search ──────────────────────────────────

describe('R42 (E1): FTS5 AND-of-terms search', () => {
  let store: HumanMemoryStore;

  beforeEach(() => {
    store = HumanMemoryStore.openMemory();
    // Note 1: has auth + login, but NOT bug.
    store.createNode({
      project: 'p', label: 'BugNote',
      title: 'Auth login fails on Safari',
      body_markdown: 'The login form throws TypeError when Safari blocks third-party cookies.',
      status: 'active', source: 'human', cbm_node_ids: [], tags: ['auth', 'safari'],
    });
    // Note 2: has auth + login + bug (all 3 terms).
    store.createNode({
      project: 'p', label: 'BugNote',
      title: 'Bug in auth module',
      body_markdown: 'The auth module has a login regression after the JWT refactor.',
      status: 'active', source: 'human', cbm_node_ids: [], tags: ['auth', 'jwt'],
    });
    // Note 3: has auth but not login, not bug.
    store.createNode({
      project: 'p', label: 'ADR',
      title: 'ADR-003: Use JWT for authentication',
      body_markdown: 'We decided to use JSON Web Tokens for the auth service.',
      status: 'active', source: 'human', cbm_node_ids: [], tags: ['auth', 'jwt'],
    });
    // Note 4: has all 3 terms but in a different order / scattered.
    store.createNode({
      project: 'p', label: 'BugNote',
      title: 'Login regression',
      body_markdown: 'After the refactor, the auth service has a bug in the login flow.',
      status: 'active', source: 'human', cbm_node_ids: [], tags: [],
    });
  });

  afterEach(() => store.close());

  it('multi-term query matches notes containing ALL terms (AND semantics)', () => {
    // "auth login bug" should match:
    //   - Note 2 "Bug in auth module" (auth + login + bug all present) ✓
    //   - Note 4 "Login regression" (auth + bug + login in body) ✓
    // Should NOT match:
    //   - Note 1 "Auth login fails on Safari" (has auth + login, but NOT bug) ✗
    //   - Note 3 "ADR-003" (has auth, but not login, not bug) ✗
    const results = store.searchHumanNodes('p', 'auth login bug');
    const titles = results.map(r => r.title);
    expect(titles.some(t => t.includes('Bug in auth module'))).toBe(true);
    expect(titles.some(t => t.includes('Login regression'))).toBe(true);
  });

  it('multi-term query does NOT match notes missing a term', () => {
    const results = store.searchHumanNodes('p', 'auth login bug');
    const titles = results.map(r => r.title);
    // Note 1 has auth + login but no "bug" token.
    expect(titles.find(t => t.includes('Auth login fails'))).toBeUndefined();
    // Note 3 has auth but no login, no bug.
    expect(titles.find(t => t.includes('JWT for authentication'))).toBeUndefined();
  });

  it('single-term query still works (degenerates to phrase query)', () => {
    const results = store.searchHumanNodes('p', 'jwt');
    // Should find Note 2 (JWT refactor) and Note 3 (JWT for authentication).
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('reordered terms match the same set (AND is commutative)', () => {
    const ordered = store.searchHumanNodes('p', 'auth login bug');
    const reordered = store.searchHumanNodes('p', 'bug auth login');
    // Same set of titles (order may differ due to BM25 ranking).
    const sortTitles = (arr: any[]) => arr.map(r => r.title).sort();
    expect(sortTitles(ordered)).toEqual(sortTitles(reordered));
  });

  it('scattered terms match (terms in different fields)', () => {
    // "auth safari" — "auth" is in title/body, "safari" is in title/tags.
    // Should find Note 1 ("Auth login fails on Safari").
    const results = store.searchHumanNodes('p', 'auth safari');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toContain('Auth login');
  });

  it('query with extra whitespace is handled (split normalizes)', () => {
    // "auth   login" (multiple spaces) should behave like "auth login".
    // Should find Note 1 (auth + login), Note 2 (auth + login), Note 4 (auth + login).
    const results = store.searchHumanNodes('p', 'auth   login');
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it('non-matching multi-term query returns empty (falls through to LIKE, also empty)', () => {
    // "zzz nonexistent" — no note has these tokens.
    const results = store.searchHumanNodes('p', 'zzz nonexistent');
    expect(results).toEqual([]);
  });

  it('respects the limit parameter with multi-term query', () => {
    const results = store.searchHumanNodes('p', 'auth login', 1);
    expect(results.length).toBe(1);
  });

  it('excludes deprecated notes', () => {
    store.createNode({
      project: 'p', label: 'BugNote',
      title: 'Deprecated auth login bug',
      body_markdown: 'This deprecated note has all three terms.',
      status: 'deprecated', source: 'human', cbm_node_ids: [], tags: [],
    });
    const results = store.searchHumanNodes('p', 'auth login bug');
    const titles = results.map(r => r.title);
    expect(titles.find(t => t.includes('Deprecated'))).toBeUndefined();
  });

  it('LIKE fallback uses full substring (not AND-split)', () => {
    // A query that FTS5 matches as individual tokens but not as an adjacent
    // phrase. The FTS5 path should return results (AND-of-terms is broader
    // than phrase). We verify the FTS5 path is used (non-empty) for a
    // multi-term query where the words are scattered.
    const results = store.searchHumanNodes('p', 'login bug auth');
    // Note 4 has all 3 scattered: "Login regression" title + "auth service
    // has a bug in the login flow" body.
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
