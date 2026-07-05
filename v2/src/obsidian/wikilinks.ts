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
 */
export function inferEdgeTypeFromContext(
  markdown: string,
  wikilink: Wikilink
): 'DECIDES' | 'AFFECTS' | 'TODO_FOR' | 'MENTIONS' | 'EXPLAINS' {
  const before = markdown.substring(0, wikilink.startIndex);
  const lines = before.split('\n');

  // Walk backwards to find the most recent heading OUTSIDE a code fence.
  // First, scan forward to determine the fence state at each line.
  // We need to know whether the fence is open when we encounter a heading.
  const fenceStateAtLine: boolean[] = new Array(lines.length).fill(false);
  let currentlyInFence = false;
  let currentFenceChar = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!currentlyInFence) {
      const fenceMatch = line.match(/^(`{3,}|~{3,})/);
      if (fenceMatch) {
        currentlyInFence = true;
        currentFenceChar = fenceMatch[1][0];
        fenceStateAtLine[i] = true; // the fence delimiter line itself is "inside"
      } else {
        fenceStateAtLine[i] = false;
      }
    } else {
      fenceStateAtLine[i] = true;
      const closeMatch = line.match(new RegExp('^' + currentFenceChar + '{3,}'));
      if (closeMatch) {
        currentlyInFence = false;
        currentFenceChar = '';
      }
    }
  }

  // Walk backwards to find the last heading that was NOT inside a fence.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (fenceStateAtLine[i]) continue;
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
