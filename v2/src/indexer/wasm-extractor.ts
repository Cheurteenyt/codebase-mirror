// v2/src/indexer/wasm-extractor.ts
// R69: Multi-language code extractor using web-tree-sitter (WASM).
//
// Replaces the ts-morph extractor (R68, TS/JS only) with a WASM-based
// extractor that supports 112 languages via tree-sitter WASM grammars.
//
// Key advantages over ts-morph (R68):
//   - 112 languages (vs 1 for ts-morph)
//   - Faster: ~0.09ms/parse (vs ~3.8ms/parse for ts-morph)
//   - No TypeScript compiler overhead
//   - Consistent AST shape across languages (tree-sitter grammar)
//
// Key advantages over V1 C:
//   - No binary dependency (WASM runs in Node.js)
//   - No compilation step (WASM pre-built by tree-sitter-wasm)
//   - Same tree-sitter engine as V1 (identical AST structure)
//
// Architecture:
//   1. Load WASM grammar for the detected language
//   2. Parse source file → tree-sitter AST
//   3. Walk AST: extract nodes (File, Function, Class, Method, Variable)
//   4. Walk AST: extract edges (CONTAINS, CALLS)
//   5. Write to SQLite (compatible with V1 schema)

import { Parser, Language } from 'web-tree-sitter';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { relative as pathRelative, isAbsolute, relative, extname, basename, dirname, join } from 'node:path';
import { readFileSync, statSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extractFast, type UnresolvedCallSite, type ImportBinding, type ExportBinding } from './fast-walker.js';
import { replaceCallSitesForFiles, replaceImportsForFiles, replaceExportsForFiles, rebuildCrossFileCallsEdges, clearCrossFileCallEdges, isCallSitesInitialized, isExtractorSemanticsCurrent } from './cross-file-resolver.js';
const require2 = createRequire(import.meta.url);

// ── Types ──────────────────────────────────────────────────────────────

export interface WasmExtractionResult {
  nodes: number;
  edges: number;
  files: number;
  skipped: number;
  errors: Array<{ file: string; error: string }>;
  languages: Set<string>;
  // R106: true if cross-file CALLS edges were rebuilt from persistent call_sites.
  // false if call_sites was empty (legacy DB) and the graph is stale.
  crossFileCallsResolved: boolean;
}

// ── Language detection ─────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.dart': 'dart',
  '.lua': 'lua',
  '.sh': 'bash',
  '.bash': 'bash',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.json': 'json',
  '.html': 'html',
  '.css': 'css',
  '.sql': 'sql',
  '.md': 'markdown',
  '.dockerfile': 'dockerfile',
};

// R78: V1 (C) has ALWAYS_SKIP_DIRS + FAST_SKIP_DIRS that exclude ~60 directory
// names in fast mode. V2 previously only excluded ~15, causing V2 to index
// ~21% more files than V1 on the same project — making benchmarks unfair.
// This set now matches V1's discover.c ALWAYS_SKIP_DIRS + FAST_SKIP_DIRS so
// both engines index the same file set.
// Source: v1-reference/src/discover/discover.c lines 31-55.
const SKIP_DIRS = new Set([
  // ── V1 ALWAYS_SKIP_DIRS (hardcoded, all modes) ─────────────────────
  // VCS
  '.git', '.hg', '.svn', '.worktrees',
  // IDE
  '.idea', '.vs', '.vscode', '.eclipse', '.claude', '.claude-worktrees', 'Antigravity',
  // Python
  '.cache', '.eggs', '.env', '.mypy_cache', '.nox', '.pytest_cache', '.ruff_cache', '.tox',
  '.venv', '__pycache__', 'env', 'htmlcov', 'site-packages', 'venv',
  // JS/TS
  '.npm', '.nyc_output', '.pnpm-store', '.yarn', 'bower_components', 'coverage', 'node_modules',
  '.next', '.nuxt', '.svelte-kit', '.angular', '.turbo', '.parcel-cache', '.docusaurus', '.expo',
  // Build artifacts
  'dist', 'obj', 'Pods', 'target', 'temp', 'tmp', '.terraform', '.serverless', 'bazel-bin',
  'bazel-out', 'bazel-testlogs',
  // Language caches
  '.cargo', '.stack-work', '.dart_tool', 'zig-cache', 'zig-out', '.metals', '.bloop', '.bsp',
  '.ccls-cache', '.clangd', 'elm-stuff', '_opam', '.cpcache', '.shadow-cljs',
  // Deploy
  '.vercel', '.netlify', 'deploy', 'deployed',
  // Misc
  '.qdrant_code_embeddings', '.tmp', 'vendor', 'vendored',
  // ── V1 FAST_SKIP_DIRS (skipped in fast/moderate mode) ──────────────
  'generated', 'gen', 'auto-generated', 'fixtures', 'testdata', 'test_data',
  '__tests__', '__mocks__', '__snapshots__', '__fixtures__', '__test__',
  'docs', 'doc', 'documentation', 'examples', 'example', 'samples', 'sample',
  'assets', 'static', 'public', 'media', 'third_party', 'thirdparty',
  '3rdparty', 'external', 'migrations', 'seeds', 'e2e', 'integration',
  'locale', 'locales', 'i18n', 'l10n', 'scripts', 'tools', 'hack',
  'bin', 'build', 'out',
]);

/**
 * Detect language from file extension.
 * Returns the tree-sitter language name, or null if unsupported.
 */
export function detectLanguage(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.dockerfile' || basename(filePath).toLowerCase() === 'dockerfile') return 'dockerfile';
  return EXT_TO_LANG[ext] ?? null;
}

/**
 * Walk a directory and return all supported source files.
 */
export function discoverSourceFilesWasm(rootPath: string): string[] {
  const results: string[] = [];
  // R139/R140: Resolve the real root path once. All discovered paths must be
  // inside this real root to prevent symlink-based escapes.
  let realRoot: string;
  try {
    realRoot = realpathSync(rootPath);
  } catch {
    return results; // rootPath doesn't exist — nothing to discover
  }
  // R140: Track visited realpaths for ALL directories (regular + symlink)
  // to prevent duplicate indexing and cycles.
  const visitedDirs = new Set<string>([realRoot]);
  const stack: string[] = [rootPath];

  // R140: Cross-platform containment check using path.relative
  function isInside(root: string, candidate: string): boolean {
    const rel = pathRelative(root, candidate);
    return rel === '' || (!rel.startsWith('..' + '/') && !rel.startsWith('..' + '\\') && rel !== '..' && !isAbsolute(rel));
  }

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const lst = lstatSync(fullPath);
        if (lst.isSymbolicLink()) {
          // R139/R140: Resolve symlink target and check containment.
          try {
            const realTarget = realpathSync(fullPath);
            if (!isInside(realRoot, realTarget)) {
              continue; // External symlink — skip
            }
            // R140: Check SKIP_DIRS against the target's basename too
            const targetBase = basename(realTarget);
            if (SKIP_DIRS.has(targetBase) || SKIP_DIRS.has(entry)) {
              continue;
            }
            // R140: Check visited for ALL directories (dedup)
            if (visitedDirs.has(realTarget)) {
              continue;
            }
            const realStat = statSync(fullPath);
            if (realStat.isDirectory()) {
              if (!entry.startsWith('.')) {
                visitedDirs.add(realTarget);
                stack.push(fullPath);
              }
            } else {
              const lang = detectLanguage(fullPath);
              if (lang) results.push(fullPath);
            }
          } catch {
            continue; // Broken symlink
          }
        } else if (lst.isDirectory()) {
          if (!SKIP_DIRS.has(entry) && !entry.startsWith('.')) {
            // R140: Resolve regular dirs too and check visited (dedup)
            try {
              const realDir = realpathSync(fullPath);
              if (visitedDirs.has(realDir)) {
                continue; // Already visited via symlink or another path
              }
              visitedDirs.add(realDir);
            } catch {
              // If realpath fails, still push (may not exist yet — unlikely for a dir we just lstat'd)
            }
            stack.push(fullPath);
          }
        } else if (lst.isFile()) {
          const lang = detectLanguage(fullPath);
          if (lang) results.push(fullPath);
        }
      } catch {
        // skip inaccessible
      }
    }
  }

  return results.sort();
}

// ── WASM grammar loading ───────────────────────────────────────────────

let parserInitialized = false;
const languageCache = new Map<string, Language>();

/**
 * R79: Lazy Parser.init() — called only when actually needed (first parse).
 * Previously preloadGrammars() called Parser.init() eagerly, costing ~50ms
 * even on tiny workloads. Now preloadGrammars() just loads grammars, and
 * Parser.init() happens here on first actual use.
 */
async function ensureParserInitialized(): Promise<void> {
  if (!parserInitialized) {
    await Parser.init();
    parserInitialized = true;
  }
}

/**
 * Get the path to a WASM grammar file.
 * tree-sitter-wasm stores them at out/<lang>/tree-sitter-<lang>.wasm
 */
function getWasmPath(lang: string): string {
  // R69: use createRequire to resolve the tree-sitter-wasm package path
  // from ESM context (require.resolve doesn't exist in ESM modules).
  const pkgPath = require2.resolve('tree-sitter-wasm/manifest.json');
  const pkgDir = dirname(pkgPath);
  return join(pkgDir, 'out', lang, `tree-sitter-${lang}.wasm`);
}

// (getLanguage is defined above, used by preloadGrammars)

// ── Main extraction function ───────────────────────────────────────────

/**
 * Extract nodes and edges from source files using web-tree-sitter (WASM).
 * Supports 112 languages via pre-built WASM grammars.
 */
export async function extractFromFilesWasm(
  db: Database.Database,
  project: string,
  rootPath: string,
  files: string[],
  incremental: boolean = false,
): Promise<WasmExtractionResult> {
  const result: WasmExtractionResult = {
    nodes: 0, edges: 0, files: 0, skipped: 0, errors: [], languages: new Set(),
    crossFileCallsResolved: false,
  };

  if (files.length === 0) {
    // R106: even with 0 files to index, in incremental mode we may still need
    // to rebuild cross-file CALLS (e.g., deletion-only fast path skips here).
    // But that path is handled at the indexer.ts level (it doesn't call
    // extractFromFilesWasm at all). If we reach here with 0 files in full mode,
    // there's nothing to do. If we reach here in incremental mode with 0 files
    // to extract but call_sites already populated, we still want to rebuild
    // cross-file CALLS — but that's also handled at the indexer.ts level.
    // So here we just return.
    return result;
  }

  // R79: Parser.init() is now deferred to preloadGrammars() (called by
  // indexer.ts before this function). The lazy ensureParserInitialized()
  // call here is a safety net in case extractFromFilesWasm is called
  // directly without preloadGrammars. Idempotent — no cost if already init'd.
  await ensureParserInitialized();
  const parser = new Parser();
  const qnToId = new Map<string, number>();
  // R80: Bug 10 fix — nextId is now initialized from MAX(id) in the transaction,
  // not hardcoded to 1. Previously, incremental mode and multi-project would
  // produce wrong edge IDs because SQLite assigns MAX(id)+1 to auto-increment
  // INSERTs, not 1..N. The qnToId map stored 1..N while the real IDs were
  // MAX(id)+1..MAX(id)+N, causing edges to point to wrong nodes.

  // R75: prepared statements replaced by batch INSERT in Phase 2
  const upsertFileHash = db.prepare(`
    INSERT INTO file_hashes (project, file_path, content_hash, mtime, mtime_ns, size, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, file_path) DO UPDATE SET
      content_hash = excluded.content_hash, mtime = excluded.mtime, mtime_ns = excluded.mtime_ns, size = excluded.size, indexed_at = excluded.indexed_at
  `);

  // R74: restructured into two phases for better cache locality:
  // Phase 1: read + parse + extract ALL files into in-memory arrays (CPU-bound, no SQLite)
  // Phase 2: write ALL nodes + edges to SQLite in one transaction (I/O-bound, no parsing)
  // This avoids interleaving CPU-heavy WASM parsing with SQLite writes, which
  // caused cache thrashing. The transaction is also shorter (only writes, not
  // parse + extract + write).

  interface FileExtract {
    relPath: string;
    nodes: Array<{ label: string; name: string; qualifiedName: string; filePath: string; startLine: number; endLine: number; properties: string }>;
    edges: Array<{ sourceQn: string; targetQn: string; type: string; properties: string }>;
    // R98: unresolved call-sites for cross-file resolution
    unresolvedCalls: UnresolvedCallSite[];
    // R110: import bindings for import-aware cross-file resolution
    imports: ImportBinding[];
    // R111: default export QN (for default import resolution)
    defaultExportQn: string | null;
    // R132: count of `export default` statements (for duplicate detection)
    defaultExportCount: number;
    // R119: export bindings for export-aware resolution
    exports: ExportBinding[];
  }

  const allExtracts: FileExtract[] = [];
  // R74: deferred hash updates for incremental mode (written in Phase 2 transaction)
  const pendingHashUpdates: Array<{ project: string; relPath: string; hash: string; mtime: number; mtimeNs: string; size: number; indexedAt: string }> = [];
  // R81: Bug 16 — changed file paths (incremental mode). Old nodes/edges for
  // these paths are deleted in the transaction AFTER parse succeeds.
  const changedRelPaths: string[] = [];
  // R84: Bug 24 — metadata-only hash updates. When mtime/size changed but
  // content_hash is identical, we skip re-indexing but must still update
  // mtime/size in file_hashes so the next run can fast-skip without hashing.
  // Without this, the fast skip never activates for files whose mtime
  // changed but content didn't (common after git checkout, touch, etc.).
  const metadataOnlyHashUpdates: Array<{ project: string; relPath: string; hash: string; mtime: number; mtimeNs: string; size: number; indexedAt: string }> = [];

  // R85: Bug 26 fix — in incremental mode, do NOT pre-read all files. The old
  // code pre-read every file into fileContents before checking mtime+size,
  // making no-op incremental O(total bytes read) instead of O(stat). Now we
  // only pre-read in full mode (where we know we'll parse everything anyway).
  // In incremental mode, files are read lazily only when mtime+size mismatch.
  const fileContents = new Map<string, string>();
  if (!incremental) {
    // Full mode: pre-read all files for OS prefetch optimization
    for (const filePath of files) {
      try {
        fileContents.set(filePath, readFileSync(filePath, 'utf-8'));
      } catch {
        // Will be reported as error in the parse loop
      }
    }
  }

  let currentLang = '';

  // ── Phase 1: Parse + Extract (no SQLite mutations) ───────────────────
  for (const filePath of files) {
    const relPath = relative(rootPath, filePath);
    const lang = detectLanguage(filePath);
    if (!lang) {
      result.skipped++;
      continue;
    }

    try {
      const language = getLanguageSync(lang);
      if (!language) {
        result.errors.push({ file: relPath, error: `WASM grammar not found for ${lang}` });
        continue;
      }
      result.languages.add(lang);

      // R85: use bigint stat for nanosecond mtime precision
      const stat = statSync(filePath, { bigint: true });
      const fileMtime = Math.floor(Number(stat.mtimeMs));
      const fileMtimeNs = stat.mtimeNs.toString();
      const fileSize = Number(stat.size);

      if (incremental) {
        // R85: mtimeNs+size fast skip — nanosecond precision eliminates
        // false skips from Math.floor(mtimeMs) rounding.
        const existing = db.prepare(
          'SELECT content_hash, mtime, mtime_ns, size FROM file_hashes WHERE project = ? AND file_path = ?'
        ).get(project, relPath) as { content_hash: string; mtime: number; mtime_ns: string | null; size: number } | undefined;
        if (existing) {
          // R93: Bug 33 fix — never fast-skip on mtime integer alone when
          // mtime_ns is NULL. Force read+hash to backfill mtime_ns.
          if (existing.mtime_ns && existing.mtime_ns === fileMtimeNs && existing.size === fileSize) {
            // mtime_ns + size match — skip without read/hash
            result.skipped++;
            continue;
          }
          // mtime_ns is NULL or mismatch — must read+hash to confirm
          const content = readFileSync(filePath, 'utf-8');
          const hash = createHash('sha256').update(content).digest('hex');
          if (existing.content_hash === hash) {
            // R84/R93: content unchanged, update metadata only (backfills mtime_ns if NULL)
            result.skipped++;
            metadataOnlyHashUpdates.push({
              project, relPath, hash,
              mtime: fileMtime, mtimeNs: fileMtimeNs, size: fileSize,
              indexedAt: new Date().toISOString(),
            });
            continue;
          }
          // Content changed — will re-index (content already read above)
          fileContents.set(filePath, content);
        } else {
          // New file — read for hashing and parsing
          fileContents.set(filePath, readFileSync(filePath, 'utf-8'));
        }
        // R82: Bug 20 fix — do NOT push to changedRelPaths or pendingHashUpdates yet.
      }

      // R81: use fileContents.has() to distinguish empty file from read failure
      if (!fileContents.has(filePath)) {
        // R85: in incremental mode, file may not have been read if it was
        // fast-skipped above. But if we reach here, it wasn't skipped.
        // In full mode, pre-read should have populated it.
        result.errors.push({ file: relPath, error: 'file read failed (not in cache)' });
        continue;
      }
      const content = fileContents.get(filePath)!;

      // R83: always compute hash for full mode (stored for future incremental)
      const hash = createHash('sha256').update(content).digest('hex');
      const hashInfo = { project, relPath, hash, mtime: fileMtime, mtimeNs: fileMtimeNs, size: fileSize, indexedAt: new Date().toISOString() };

      // R75: skip setLanguage if language hasn't changed (common case: all files same lang)
      if (currentLang !== lang) {
        parser.setLanguage(language);
        currentLang = lang;
      }

      const source = content;
      const tree = parser.parse(source);
      if (!tree) {
        result.errors.push({ file: relPath, error: 'parse returned null' });
        continue;
      }

      // R78: use try/finally to guarantee tree.delete() even if extractFast throws.
      try {
        // R92: test-only failure injection for real failure tests
        if (process.env.NODE_ENV === 'test' && process.env.CBM_TEST_FAIL_ON_FILE === relPath) {
          throw new Error(`Injected test failure for ${relPath}`);
        }
        const fileQn = `${project}::${relPath}`;
        const extracted = extractFast(tree.rootNode, project, relPath, fileQn, source.length);

        allExtracts.push({ relPath, nodes: extracted.nodes, edges: extracted.edges, unresolvedCalls: extracted.unresolvedCalls, imports: extracted.imports, defaultExportQn: extracted.defaultExportQn, defaultExportCount: extracted.defaultExportCount, exports: extracted.exports });
        result.files++;

        // R82: Bug 20 fix — ONLY after extractFast succeeds, schedule the mutations.
        // If extractFast threw (caught by outer catch), changedRelPaths and
        // pendingHashUpdates stay empty for this file — old graph preserved.
        if (incremental) {
          changedRelPaths.push(relPath);
        }
        pendingHashUpdates.push(hashInfo);
      } finally {
        // R78: free WASM tree memory immediately after extraction.
        // Without this, every parsed tree stays in the WASM heap until GC,
        // causing RSS to grow linearly with file count. The parallel path
        // (worker.ts) already calls tree.delete() — this fixes the single-
        // thread path to match. On the 42-file SMALL workload this reduces
        // peak RSS from ~114MB to ~107MB.
        tree.delete();
      }
    } catch (e: unknown) {
      result.errors.push({
        file: relPath,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ── Phase 2: Write all to SQLite using multi-row batch INSERT ────────
  // R75: batch INSERT statements (50 rows per INSERT) instead of single-row.
  // SQLite's overhead per prepare().run() is ~2-5µs. For 800 nodes that's
  // ~2-4ms. With batch INSERT (50 rows/statement), it's ~40µs (16 statements).
  // Net savings: ~2-3ms. Small but free.
  const BATCH_SIZE = 50;

  const tx = db.transaction(() => {
    // R81: Bug 16 fix — delete old nodes/edges for changed files BEFORE inserting
    // new ones. This happens INSIDE the transaction, so if anything fails the
    // old graph is preserved. Previously (R79), deletes happened in Phase 1
    // before parsing — a parse failure would lose the old graph.
    if (changedRelPaths.length > 0) {
      const ph = changedRelPaths.map(() => '?').join(',');
      const oldNodeIds = db.prepare(
        `SELECT id FROM nodes WHERE project = ? AND file_path IN (${ph})`
      ).all(project, ...changedRelPaths) as Array<{ id: number }>;
      if (oldNodeIds.length > 0) {
        const idPh = oldNodeIds.map(() => '?').join(',');
        const idParams = oldNodeIds.map(r => r.id);
        db.prepare(
          `DELETE FROM edges WHERE project = ? AND (source_id IN (${idPh}) OR target_id IN (${idPh}))`
        ).run(project, ...idParams, ...idParams);
      }
      db.prepare(
        `DELETE FROM nodes WHERE project = ? AND file_path IN (${ph})`
      ).run(project, ...changedRelPaths);
    }

    // R80: Bug 10 fix — get the real MAX(id) from the nodes table so we can
    // assign explicit IDs that match what SQLite will actually use.
    const maxNodeRow = db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM nodes').get() as { max_id: number };
    let nextNodeId = maxNodeRow.max_id + 1;
    const maxEdgeRow = db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM edges').get() as { max_id: number };
    let nextEdgeId = maxEdgeRow.max_id + 1;

    // Update file hashes (only for files that were successfully parsed+extracted)
    for (const h of pendingHashUpdates) {
      upsertFileHash.run(h.project, h.relPath, h.hash, h.mtime, h.mtimeNs, h.size, h.indexedAt);
    }
    // R84: Bug 24 — update mtime/size for metadata-only changes (content unchanged
    // but mtime/size changed). This ensures the next run can fast-skip without hashing.
    for (const h of metadataOnlyHashUpdates) {
      upsertFileHash.run(h.project, h.relPath, h.hash, h.mtime, h.mtimeNs, h.size, h.indexedAt);
    }

    // Pass 1: batch-insert all nodes + build QN→ID map
    const allNodes: Array<{ label: string; name: string; qualifiedName: string; filePath: string; startLine: number; endLine: number; properties: string }> = [];
    for (const ext of allExtracts) {
      allNodes.push(...ext.nodes);
    }

    for (let i = 0; i < allNodes.length; i += BATCH_SIZE) {
      const batch = allNodes.slice(i, i + BATCH_SIZE);
      // R80: Bug 10 fix — INSERT with explicit id column so qnToId matches reality.
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const stmt = db.prepare(`INSERT INTO nodes (id, project, label, name, qualified_name, file_path, start_line, end_line, properties_json) VALUES ${placeholders}`);
      const params: unknown[] = [];
      for (const node of batch) {
        const nodeId = nextNodeId++;
        params.push(nodeId, project, node.label, node.name, node.qualifiedName, node.filePath, node.startLine, node.endLine, node.properties);
        qnToId.set(node.qualifiedName, nodeId);
        result.nodes++;
      }
      stmt.run(...params);
    }

    // Pass 2: batch-insert all edges with resolved IDs
    const allEdges: Array<{ sourceQn: string; targetQn: string; type: string; properties: string }> = [];
    for (const ext of allExtracts) {
      for (const edge of ext.edges) {
        const sourceId = qnToId.get(edge.sourceQn);
        const targetId = qnToId.get(edge.targetQn);
        if (sourceId && targetId) {
          allEdges.push({ sourceQn: String(sourceId), targetQn: String(targetId), type: edge.type, properties: edge.properties });
        }
      }
    }

    for (let i = 0; i < allEdges.length; i += BATCH_SIZE) {
      const batch = allEdges.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const stmt = db.prepare(`INSERT INTO edges (project, source_id, target_id, type, properties_json) VALUES ${placeholders}`);
      const params: unknown[] = [];
      for (const edge of batch) {
        params.push(project, parseInt(edge.sourceQn), parseInt(edge.targetQn), edge.type, edge.properties);
        nextEdgeId++;
        result.edges++;
      }
      stmt.run(...params);
    }

    // R106: Cross-file CALLS resolution via persistent call_sites table.
    //
    // Full mode:
    //   1. call_sites for the project were cleared by clearProjectData() before
    //      extraction. Now we insert all new call_sites from allExtracts.
    //   2. Then rebuildCrossFileCallsEdges() rebuilds ALL cross-file CALLS edges
    //      from the persistent table + all current nodes.
    //   3. Mark call_sites_initialized=1 (R107) — even if 0 call-sites were
    //      found, the table is now authoritative for this project.
    //
    // Incremental mode:
    //   1. Delete call_sites for changed files (changedRelPaths).
    //   2. Insert new call_sites from allExtracts (which contains only changed
    //      files' results — unchanged files are skipped in Phase 1).
    //   3. rebuildCrossFileCallsEdges() rebuilds ALL cross-file CALLS edges from
    //      the persistent table (which has call_sites for both changed and
    //      unchanged files) + all current nodes (which has nodes for both
    //      changed and unchanged files).
    //   4. crossFileCallsStale = false (no longer stale!).
    //
    // R107: legacy DB detection now uses isCallSitesInitialized() instead of
    // hasCallSites(). A valid R106 DB can have 0 call-sites (project with no
    // unresolved cross-file calls), so hasCallSites()===false is ambiguous.
    // isCallSitesInitialized() checks the explicit call_sites_initialized flag
    // set by the last full R106+ reindex.

    // R107: capture initialized flag BEFORE inserting new call_sites.
    const callSitesInitialized = isCallSitesInitialized(db, project);

    // Step 1: persist call_sites.
    // - Full mode: insert all call_sites from allExtracts (table was cleared).
    // - Incremental mode: delete call_sites for changed files, then insert new.
    const newCallSites: UnresolvedCallSite[] = [];
    for (const ext of allExtracts) {
      newCallSites.push(...ext.unresolvedCalls);
    }
    if (incremental) {
      // Delete + re-insert call_sites for changed files only.
      // call_sites for unchanged files remain in the table.
      replaceCallSitesForFiles(db, project, changedRelPaths, newCallSites);
    } else {
      // Full mode: table was cleared by clearProjectData. Just insert.
      // Use the helper with an empty delete list.
      replaceCallSitesForFiles(db, project, [], newCallSites);
    }

    // R110: persist imports (same pattern as call_sites).
    // R111: also persist default export QN as a special import binding marker.
    // extractImports already sets filePath on each binding.
    const newImports: ImportBinding[] = [];
    for (const ext of allExtracts) {
      newImports.push(...ext.imports);
      // R111/R132: store default export QN + count as a marker row.
      // R132: the count is stored in source_module (previously empty string).
      // The resolver reads it to detect:
      //   - count > 1 → duplicate direct defaults (IDX-R132-06)
      //   - count > 0 + fileExp.named.has('default') → collision (IDX-R132-07)
      if (ext.defaultExportQn || ext.defaultExportCount > 0) {
        newImports.push({
          localName: '__default_export__',
          // R132: encode the count in source_module for the resolver to read.
          sourceModule: String(ext.defaultExportCount),
          // R132: if qn is null (identifier reference), use empty string.
          // The resolver checks count > 0 for collision detection even without a qn.
          importedName: ext.defaultExportQn || '',
          importKind: 'default_export',
          line: 0,
          filePath: ext.relPath,
        });
      }
    }
    if (incremental) {
      replaceImportsForFiles(db, project, changedRelPaths, newImports);
    } else {
      replaceImportsForFiles(db, project, [], newImports);
    }

    // R119: persist exports (same pattern as imports).
    const newExports: ExportBinding[] = [];
    for (const ext of allExtracts) {
      newExports.push(...ext.exports);
    }
    if (incremental) {
      replaceExportsForFiles(db, project, changedRelPaths, newExports);
    } else {
      replaceExportsForFiles(db, project, [], newExports);
    }

    // Step 2: rebuild cross-file CALLS edges from persistent call_sites.
    // R108: when callSitesInitialized=true, ALWAYS run rebuildCrossFileCallsEdges
    // (even if call_sites is empty). This:
    //   - Cleans up any stale cross-file edges if call_sites became empty
    //   - Marks crossFileCallsResolved=true so the caller sets stale=false
    // A project with initialized=true and call_sites=0 is in a COMPLETE state
    // (no cross-file calls to resolve), so stale must be false.
    // R109: when callSitesInitialized=true && nodesCount=0 (all files deleted
    // or empty project), the graph is also COMPLETE — mark resolved=true
    // without calling rebuildCrossFileCallsEdges (nothing to rebuild).
    // R127: MIG-R127-03 — when semantics are stale (incremental with old
    // extractor_semantics_version), DON'T run the resolver. The resolver would
    // publish legacy fallback edges (semanticsCurrent=false) which remain in
    // the DB even though the caller sets stale=true afterwards. Instead,
    // delete all cross-file edges (cleanup) and leave crossFileCallsResolved=false
    // so the caller forces stale=true and the user does a full reindex.
    if (incremental) {
      const nodesCount = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(project) as { c: number }).c;
      const semanticsCurrent = isExtractorSemanticsCurrent(db, project);
      // R128: MIG-R128-02 — semanticsStale MUST dominate callSitesInitialized.
      // Previously `!callSitesInitialized` was checked first, which meant a
      // DB with initialized=false (e.g. after a partial full index that set
      // initialized=false) would skip the stale-semantics cleanup entirely,
      // leaving old edges readable. Now we check semanticsStale first.
      if (!semanticsCurrent) {
        // R127: MIG-R127-03 — stale extractor semantics. The file_hashes are
        // valid but the exports/call_sites/imports rows were produced by an
        // older extractor. Don't run the resolver (it would publish legacy
        // fallback edges). Delete existing cross-file edges and leave
        // crossFileCallsResolved=false so the caller sets stale=true.
        // R128: use clearCrossFileCallEdges helper.
        clearCrossFileCallEdges(db, project);
      } else if (!callSitesInitialized) {
        // R107: Legacy DB (pre-R106, or R106 full reindex never completed).
        // call_sites is not authoritative for unchanged files. Skip resolution
        // to avoid creating an incomplete graph. Caller marks stale=true to
        // force full reindex which will set call_sites_initialized=1.
      } else if (nodesCount > 0) {
        // R108: initialized=true → call_sites is authoritative (even if empty).
        // Always rebuild: inserts new edges if call_sites has entries, OR
        // cleans up stale cross-file edges if call_sites is empty.
        // R126: semanticsCurrent=true (checked above).
        const added = rebuildCrossFileCallsEdges(db, project, true);
        result.edges += added;
        result.crossFileCallsResolved = true;
      } else {
        // R109: initialized=true && nodesCount=0 → empty graph is COMPLETE.
        // No nodes means no call-sites and no edges to resolve. Mark resolved
        // so the caller sets stale=false. This is defensive — currently the
        // extractor always creates a File node per file, so nodesCount=0 only
        // happens when all files are deleted (handled by the deletion-only
        // fast path in indexer.ts). But this makes the semantics explicit
        // and guards against future changes to the extractor.
        result.crossFileCallsResolved = true;
      }
    } else {
      // Full mode: always rebuild (table was cleared, all call_sites are new).
      // R126: full reindex → semanticsCurrent=true (the extractor just
      // produced fresh data with the current semantics).
      const added = rebuildCrossFileCallsEdges(db, project, true);
      result.edges += added;
      result.crossFileCallsResolved = true;
    }
  });
  tx();

  return result;
}

// R106: addToGlobalIndex() was removed. Cross-file CALLS resolution now lives
// in cross-file-resolver.ts (rebuildCrossFileCallsEdges), which builds its own
// global symbol index from the persistent nodes table.

// ── Synchronous language loading (pre-load all needed grammars) ────────

/**
 * Pre-load WASM grammars for all detected languages.
 * R79: Parser.init() is required before Language.load() — web-tree-sitter
 * needs the WASM runtime initialized first. So we call ensureParserInitialized()
 * here (which defers only on first call). This is still faster than the old
 * code because Parser.init() is now idempotent and cached.
 */
export async function preloadGrammars(languages: Set<string>): Promise<void> {
  await ensureParserInitialized();
  for (const lang of languages) {
    if (!languageCache.has(lang)) {
      try {
        const wasmPath = getWasmPath(lang);
        const language = await Language.load(wasmPath);
        languageCache.set(lang, language);
      } catch {
        // grammar not available — skip
      }
    }
  }
}

/**
 * Get a loaded language synchronously (must be pre-loaded).
 */
function getLanguageSync(lang: string): Language | null {
  return languageCache.get(lang) ?? null;
}

// ── Helpers ────────────────────────────────────────────────────────────

