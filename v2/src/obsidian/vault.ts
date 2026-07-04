// v2/src/obsidian/vault.ts
// Vault filesystem helpers — walk, ensure dirs, read/write notes.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, renameSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { createHash } from 'node:crypto';

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
  if (!existsSync(vaultPath)) {
    mkdirSync(vaultPath, { recursive: true });
  }
  for (const dir of VAULT_DIRS) {
    const p = join(vaultPath, dir);
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
    }
  }
}

export function readNote(vaultPath: string, relPath: string): string | null {
  const absPath = join(vaultPath, relPath);
  if (!existsSync(absPath)) return null;
  return readFileSync(absPath, 'utf-8');
}

export function writeNote(
  vaultPath: string,
  relPath: string,
  content: string,
  opts: { backupBeforeWrite?: boolean } = {}
): { written: boolean; backupPath: string | null } {
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
    }
  }

  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, 'utf-8');
  return { written: true, backupPath };
}

export function walkVault(vaultPath: string): string[] {
  const results: string[] = [];
  if (!existsSync(vaultPath)) return results;

  function walk(dir: string) {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        // Skip .obsidian, .git, node_modules
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        walk(full);
      } else if (extname(entry).toLowerCase() === '.md') {
        results.push(relative(vaultPath, full));
      }
    }
  }

  walk(vaultPath);
  return results.sort();
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function deleteNote(vaultPath: string, relPath: string): boolean {
  const absPath = join(vaultPath, relPath);
  if (!existsSync(absPath)) return false;
  // Soft delete: rename to .deleted
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
  return `---
type: index
project: ${opts.projectName}
last_generated: ${new Date().toISOString().split('T')[0]}
---

# ${opts.projectName} — Codebase Memory Vault

> Vault généré et synchronisé par **Codebase Memory V2**.
> Éditable dans Obsidian, VS Code (Foam), ou tout éditeur Markdown.

## Statistiques

| Métrique | Valeur |
|---|---|
| Modules | ${opts.stats.modulesCount} |
| Routes | ${opts.stats.routesCount} |
| ADRs | ${opts.stats.adrsCount} |
| Bugs connus | ${opts.stats.bugsCount} |
| Refactors | ${opts.stats.refactorsCount} |
| Notes totales | ${opts.stats.notesTotal} |

## Structure du vault

- [[Architecture/overview|Architecture]] — vue d'ensemble, hotspots, risk map
- [[ADR/]] — Architecture Decision Records
- [[Modules/]] — une note par module
- [[Routes/]] — une note par route HTTP
- [[Refactor/]] — plans de refactor
- [[Bugs/]] — bugs connus
- [[Legacy/]] — zones legacy
- [[Conventions/]] — conventions projet
- [[Prompts/]] — prompts utiles pour agents IA
- [[Journal/]] — journal d'activité

## Comment utiliser ce vault

### Pour un développeur

1. Ouvrir le vault dans Obsidian
2. Naviguer via les backlinks et wikilinks
3. **Éditer uniquement la section \`## HUMAN NOTES\`** de chaque note
4. La section \`## AUTO-GENERATED\` est régénérée par V2 au prochain sync

### Pour un agent IA

Utiliser les tools MCP V2 :

- \`get_project_overview\` — vue exécutive
- \`get_module_context\` — contexte riche d'un module (code + humain)
- \`get_undocumented_hotspots\` — modules critiques sans note
- \`create_human_note\` — créer une ADR, BugNote, etc.
- \`link_note_to_code_node\` — lier une note à un code node
- \`search_code_and_memory\` — recherche unifiée

## Sync

\`\`\`bash
# Sync双向 (DB ↔ vault)
cbm-v2 obsidian sync

# Preview sans write
cbm-v2 obsidian sync --dry-run

# Export uniquement (DB → vault)
cbm-v2 obsidian export
\`\`\`
`;
}

export const ADR_TEMPLATE = `---
type: adr
status: draft
source: human
last_generated: ${new Date().toISOString().split('T')[0]}
tags:
  - adr
---

# ADR-XXX: <title>

## AUTO-GENERATED

> Cette section est contrôlée par Codebase Memory V2 et peut être régénérée.

### Métadonnées

- **Status** : draft
- **Date** : ${new Date().toISOString().split('T')[0]}
- **Lié à** : (aucun code node lié pour l'instant)

---

## HUMAN NOTES

### Contexte

<Décrire le problème ou la contrainte qui motive cette décision>

### Décision

<Décrire la décision prise>

### Conséquences

- <Conséquence positive 1>
- <Conséquence positive 2>
- <Conséquence négative 1>

### Alternatives considérées

- <Alternative 1> — <raison du rejet>
- <Alternative 2> — <raison du rejet>
`;
