// v2/src/obsidian/vault.ts
// Vault filesystem helpers — walk, ensure dirs, read/write notes.
// All path-taking functions validate against path traversal.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, relative, extname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_VAULT_DEPTH, MAX_BACKUPS_PER_FILE } from '../constants.js';



const SKIP_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.cache', '.DS_Store']);

/**
 * Validate that a relative path stays inside the vault. Rejects path traversal.
 */
function assertPathInsideVault(vaultPath: string, relPath: string): void {
  if (relPath.includes('..')) {
    throw new Error(`Path traversal rejected: "${relPath}" contains "..".`);
  }
  if (/[\\]/.test(relPath)) {
    throw new Error(`Path traversal rejected: "${relPath}" contains backslashes.`);
  }
  const absVault = resolve(vaultPath);
  const absPath = resolve(join(absVault, relPath));
  if (absPath !== absVault && !absPath.startsWith(absVault + sep)) {
    throw new Error(
      `Path traversal rejected: "${relPath}" resolves outside the vault root "${absVault}".`
    );
  }
}

export const VAULT_DIRS = [
  'Architecture',
  'ADR',
  'Modules',
  'Routes',
  'Refactor',
  'Bugs',
  'Legacy',
  'Conventions',
  'Prompts',
  'Journal',
];

export function ensureVaultDirs(vaultPath: string): void {
  mkdirSync(vaultPath, { recursive: true });
  for (const dir of VAULT_DIRS) {
    const p = join(vaultPath, dir);
    mkdirSync(p, { recursive: true });
  }
}

export function readNote(vaultPath: string, relPath: string): string | null {
  assertPathInsideVault(vaultPath, relPath);
  const absPath = join(vaultPath, relPath);
  if (!existsSync(absPath)) return null;
  return readFileSync(absPath, 'utf-8');
}

/**
 * Write a note. If `backupBeforeWrite` is true, creates a `.bak.<timestamp>` file
 * before overwriting, then prunes old backups beyond MAX_BACKUPS_PER_FILE.
 */
export function writeNote(
  vaultPath: string,
  relPath: string,
  content: string,
  opts: { backupBeforeWrite?: boolean } = {}
): { written: boolean; backupPath: string | null } {
  assertPathInsideVault(vaultPath, relPath);
  const absPath = join(vaultPath, relPath);
  let backupPath: string | null = null;

  if (existsSync(absPath)) {
    const existing = readFileSync(absPath, 'utf-8');
    if (existing === content) {
      return { written: false, backupPath: null };
    }
    if (opts.backupBeforeWrite) {
      backupPath = `${absPath}.bak.${Date.now()}`;
      copyFileSync(absPath, backupPath);
      pruneBackups(absPath);
    }
  }

  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, 'utf-8');
  return { written: true, backupPath };
}

/**
 * Keep only the N most recent `.bak.<ts>` files for a given note path.
 */
function pruneBackups(absNotePath: string): void {
  try {
    const dir = dirname(absNotePath);
    // R23: use basename() instead of split(sep).pop() — split produces an empty
    // string when the path ends with a separator, which would match ALL .bak.
    // files in the directory (startsWith('' + '.bak.') matches everything).
    const baseName = basename(absNotePath);
    if (!baseName) return; // defensive: shouldn't happen but guards against edge cases
    const entries = readdirSync(dir);
    const backups = entries
      .filter((e) => e.startsWith(baseName + '.bak.'))
      .map((e) => ({ name: e, path: join(dir, e), ts: parseInt(e.split('.bak.').pop() || '0', 10) || 0 }))
      .sort((a, b) => b.ts - a.ts);
    for (const b of backups.slice(MAX_BACKUPS_PER_FILE)) {
      try { unlinkSync(b.path); } catch { /* ignore */ }
    }
  } catch {
    // ignore — backup pruning is best-effort
  }
}

/**
 * Walk the vault and return all `.md` files as relative paths.
 * Skips well-known directories (.obsidian, .git, .trash, node_modules, .cache).
 * Uses an iterative walk with a depth limit (MAX_VAULT_DEPTH) and symlink detection
 * to prevent stack overflow and infinite loops.
 *
 * R36: also available as a generator (walkVaultIter) for memory-efficient
 * iteration over large vaults. walkVault() now delegates to walkVaultIter()
 * and collects into an array — the API is unchanged but the implementation
 * is shared.
 */
export function walkVault(vaultPath: string): string[] {
  const results: string[] = [];
  for (const relPath of walkVaultIter(vaultPath)) {
    results.push(relPath);
  }
  return results.sort();
}

/**
 * R36: Generator version of walkVault. Yields relative paths one at a time,
 * avoiding the need to hold all paths in memory simultaneously.
 * Useful for large vaults (1000+ files) where the array version would
 * consume significant memory.
 *
 * Example:
 *   for (const relPath of walkVaultIter(vaultPath)) {
 *     // process one file at a time
 *   }
 */
export function* walkVaultIter(vaultPath: string): Generator<string> {
  if (!existsSync(vaultPath)) return;

  // Iterative walk to avoid stack overflow on deep directories.
  const stack: { dir: string; depth: number }[] = [{ dir: vaultPath, depth: 0 }];
  const visitedInodes = new Set<string>(); // protects against symlink loops

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > MAX_VAULT_DEPTH) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        // Use statSync (follows symlinks) — if it's a symlink to a dir, we descend.
        stat = statSync(full, { throwIfNoEntry: false });
      } catch {
        continue;
      }
      if (!stat) continue;

      if (stat.isDirectory()) {
        // Skip well-known non-vault directories. Allow other dotfiles (e.g., .attachments).
        if (SKIP_DIRS.has(entry)) continue;
        // Detect symlink loops via inode.
        try {
          const realStat = statSync(full);
          const inodeKey = realStat.ino ? `${realStat.dev}:${realStat.ino}` : full;
          if (visitedInodes.has(inodeKey)) continue;
          visitedInodes.add(inodeKey);
        } catch {
          // ignore
        }
        stack.push({ dir: full, depth: depth + 1 });
      } else if (stat.isFile() && extname(entry).toLowerCase() === '.md') {
        // Skip backup files and deleted files.
        if (entry.includes('.bak.') || entry.includes('.deleted.') || entry.includes('.conflict.')) continue;
        yield relative(vaultPath, full);
      }
    }
  }
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function deleteNote(vaultPath: string, relPath: string): boolean {
  assertPathInsideVault(vaultPath, relPath);
  const absPath = join(vaultPath, relPath);
  if (!existsSync(absPath)) return false;
  // Soft delete: rename to .deleted.<ts>
  const deletedPath = `${absPath}.deleted.${Date.now()}`;
  renameSync(absPath, deletedPath);
  return true;
}

/**
 * Generate the 00_Index.md content for the vault.
 */
export function renderVaultIndex(opts: {
  projectName: string;
  stats: {
    modulesCount: number;
    routesCount: number;
    adrsCount: number;
    bugsCount: number;
    refactorsCount: number;
    notesTotal: number;
  };
}): string {
  const today = new Date().toISOString().split('T')[0];
  return `---
type: index
project: ${opts.projectName}
last_generated: ${today}
---

# ${opts.projectName} — Codebase Memory Vault

> Vault generated and synced by **Codebase Memory V2**.
> Editable in Obsidian, VS Code (Foam), or any Markdown editor.

## Statistics

| Metric | Value |
|---|---|
| Modules | ${opts.stats.modulesCount} |
| Routes | ${opts.stats.routesCount} |
| ADRs | ${opts.stats.adrsCount} |
| Known bugs | ${opts.stats.bugsCount} |
| Refactors | ${opts.stats.refactorsCount} |
| Total notes | ${opts.stats.notesTotal} |

## Vault structure

- [[Architecture/overview|Architecture]] — overview, hotspots, risk map
- [[ADR/]] — Architecture Decision Records
- [[Modules/]] — one note per module
- [[Routes/]] — one note per HTTP route
- [[Refactor/]] — refactor plans
- [[Bugs/]] — known bugs
- [[Legacy/]] — legacy zones
- [[Conventions/]] — project conventions
- [[Prompts/]] — useful prompts for AI agents
- [[Journal/]] — activity journal

## How to use this vault

### For developers

1. Open the vault folder in Obsidian
2. Navigate via backlinks and wikilinks
3. **Edit only the \`## HUMAN NOTES\` section** of each note
4. The \`## AUTO-GENERATED\` section is regenerated by V2 on the next sync

### For AI agents

Use the V2 MCP tools:

- \`get_project_overview\` — executive view
- \`get_module_context\` — rich module context (code + human)
- \`get_undocumented_hotspots\` — critical modules without notes
- \`create_human_note\` — create an ADR, BugNote, etc.
- \`link_note_to_code_node\` — link a note to a code node
- \`search_code_and_memory\` — unified search

## Sync

\`\`\`bash
# Bidirectional sync (DB ↔ vault)
cbm-v2 obsidian sync

# Preview without writing
cbm-v2 obsidian sync --dry-run

# Export only (DB → vault)
cbm-v2 obsidian export
\`\`\`
`;
}

/**
 * Return the ADR template content. Computed on each call so the date is fresh
 * (the previous module-load-time constant froze the date for long-running processes).
 */
export function getAdrTemplate(): string {
  const today = new Date().toISOString().split('T')[0];
  return `---
type: adr
status: draft
source: human
last_generated: ${today}
tags:
  - adr
---

# ADR-XXX: <title>

## AUTO-GENERATED

> This section is controlled by Codebase Memory V2 and may be regenerated.

### Metadata

- **Status** : draft
- **Date** : ${today}
- **Linked to** : (no code node linked yet)

---

## HUMAN NOTES

### Context

<Describe the problem or constraint that motivates this decision>

### Decision

<Describe the decision made>

### Consequences

- <Positive consequence 1>
- <Positive consequence 2>
- <Negative consequence 1>

### Alternatives considered

- <Alternative 1> — <reason for rejection>
- <Alternative 2> — <reason for rejection>
`;
}
