// v2/src/obsidian/wikilinks.ts
// Parse and resolve [[wikilinks]] in Markdown notes.

export interface Wikilink {
  raw: string;          // e.g. [[adr-003|ADR JWT]]
  target: string;       // e.g. adr-003
  alias: string | null; // e.g. ADR JWT
  startIndex: number;
  endIndex: number;
}

const WIKILINK_REGEX = /\[\[([^\]|\[]+)(?:\|([^\]]+))?\]\]/g;

export function parseWikilinks(markdown: string): Wikilink[] {
  const links: Wikilink[] = [];
  let match: RegExpExecArray | null;
  WIKILINK_REGEX.lastIndex = 0;
  while ((match = WIKILINK_REGEX.exec(markdown)) !== null) {
    links.push({
      raw: match[0],
      target: match[1].trim(),
      alias: match[2]?.trim() ?? null,
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }
  return links;
}

/**
 * Classify a wikilink target.
 * - "integer" → code node reference (cbm_node_id)
 * - "slug-like" → human node reference (lowercase-kebab)
 * - "path-like" (contains /) → file path in vault
 */
export type WikilinkKind = 'code' | 'human' | 'path' | 'unknown';

export function classifyWikilinkTarget(target: string): WikilinkKind {
  if (/^\d+$/.test(target)) return 'code';
  if (target.includes('/') || target.includes('\\')) return 'path';
  if (/^[a-z0-9][a-z0-9-]*$/.test(target)) return 'human';
  return 'unknown';
}

/**
 * Extract the cbm_node_id from a wikilink target (if it's a code reference).
 */
export function parseCodeNodeId(target: string): number | null {
  const match = target.match(/^(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Strip a vault path to its slug component.
 * e.g. "Modules/auth.md" → "auth"
 */
export function pathToSlug(path: string): string {
  const basename = path.split(/[\\/]/).pop() || path;
  return basename.replace(/\.md$/i, '');
}

/**
 * R40 (M8): Pre-compute the code-fence state for every line of a markdown note.
 * Returns an Int8Array where 1 = "line is inside a fenced code block" and
 * 0 = "line is regular markdown". The fence delimiter lines themselves are
 * marked as inside (consistent with the previous inline implementation).
 *
 * This is factored out of inferEdgeTypeFromContext so the state can be
 * computed ONCE per note and reused across all wikilinks in that note
 * (the previous implementation rescanned the entire note per wikilink,
 * giving O(K×N) behavior for K wikilinks and N lines).
 */
export function buildFenceState(lines: string[]): Int8Array {
  const state = new Int8Array(lines.length);
  let inFence = false;
  let fenceChar = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFence) {
      const fenceMatch = line.match(/^(`{3,}|~{3,})/);
      if (fenceMatch) {
        inFence = true;
        fenceChar = fenceMatch[1][0];
        state[i] = 1; // the fence delimiter line itself counts as "inside"
      } else {
        state[i] = 0;
      }
    } else {
      state[i] = 1;
      const closeMatch = line.match(new RegExp('^' + fenceChar + '{3,}'));
      if (closeMatch) {
        inFence = false;
        fenceChar = '';
      }
    }
  }
  return state;
}

/**
 * Detect the human edge type implied by the context around a wikilink.
 * Heuristics:
 * - Inside section "## Décisions" or "### Décisions" + ADR target → DECIDES
 * - Inside "### Bugs connus" + BugNote target → AFFECTS
 * - Inside "## À faire" or "### À faire" + RefactorPlan target → TODO_FOR
 * - Default → MENTIONS
 *
 * CRITICAL: fenced code blocks (``` or ~~~) are tracked so that `#` characters
 * inside code (e.g., shell comments, Python comments) are NOT mistaken for
 * Markdown headings. Without this, a wikilink after a code block containing
 * `# some comment` would be classified under that fake heading.
 *
 * R40 (M8): the (markdown, wikilink) signature is kept for backward compat
 * and for tests. New callers should use buildFenceState + the
 * inferEdgeTypeFromContextWithState variant to avoid O(K×N) work.
 */
export function inferEdgeTypeFromContext(
  markdown: string,
  wikilink: Wikilink
): 'DECIDES' | 'AFFECTS' | 'TODO_FOR' | 'MENTIONS' | 'EXPLAINS' {
  const before = markdown.substring(0, wikilink.startIndex);
  const lines = before.split('\n');
  const fenceState = buildFenceState(lines);
  return inferEdgeTypeFromContextWithState(lines, fenceState);
}

/**
 * R40 (M8): state-precomputed variant of inferEdgeTypeFromContext.
 * Callers that process multiple wikilinks from the same note should:
 *   1. Split the note into lines ONCE.
 *   2. Call buildFenceState(lines) ONCE.
 *   3. For each wikilink, slice the lines/fenceState up to the wikilink's
 *      line index and call this function.
 * This reduces total work from O(K×N) to O(N + K×L) where L is the average
 * backward-scan distance (typically a few lines).
 */
export function inferEdgeTypeFromContextWithState(
  lines: string[],
  fenceState: Int8Array,
): 'DECIDES' | 'AFFECTS' | 'TODO_FOR' | 'MENTIONS' | 'EXPLAINS' {
  // Walk backwards to find the last heading that was NOT inside a fence.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (fenceState[i]) continue;
    const headingMatch = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const lastHeading = headingMatch[2].toLowerCase().trim();
      if (lastHeading.includes('décision') || lastHeading.includes('decision')) return 'DECIDES';
      if (lastHeading.includes('bug')) return 'AFFECTS';
      if (lastHeading.includes('à faire') || lastHeading.includes('todo') || lastHeading.includes('refactor')) return 'TODO_FOR';
      if (lastHeading.includes('explication') || lastHeading.includes('explique') || lastHeading.includes('explications') || lastHeading.includes('contexte')) return 'EXPLAINS';
      return 'MENTIONS';
    }
  }

  return 'MENTIONS';
}
