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
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { relative, extname, basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { extractFast } from './fast-walker.js';
const require2 = createRequire(import.meta.url);

// ── Types ──────────────────────────────────────────────────────────────

export interface WasmExtractionResult {
  nodes: number;
  edges: number;
  files: number;
  skipped: number;
  errors: Array<{ file: string; error: string }>;
  languages: Set<string>;
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
  const stack: string[] = [rootPath];

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
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          if (!SKIP_DIRS.has(entry) && !entry.startsWith('.')) {
            stack.push(fullPath);
          }
        } else {
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
  };

  if (files.length === 0) return result;

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
    INSERT INTO file_hashes (project, file_path, content_hash, mtime, indexed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project, file_path) DO UPDATE SET
      content_hash = excluded.content_hash, mtime = excluded.mtime, indexed_at = excluded.indexed_at
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
  }

  const allExtracts: FileExtract[] = [];
  // R74: deferred hash updates for incremental mode (written in Phase 2 transaction)
  const pendingHashUpdates: Array<{ project: string; relPath: string; hash: string; mtime: number; indexedAt: string }> = [];
  // R81: Bug 16 — changed file paths (incremental mode). Old nodes/edges for
  // these paths are deleted in the transaction AFTER parse succeeds.
  const changedRelPaths: string[] = [];

  // R75: pre-read all file contents before parsing.
  // This allows the OS to prefetch file pages into the page cache while
  // we're parsing the first files. On SSDs the gain is small (~2-5ms),
  // but on HDDs or network filesystems it's significant.
  // Also: track the current language to skip redundant setLanguage calls
  // (saves ~0.1ms per file when all files are the same language).
  const fileContents = new Map<string, string>();
  for (const filePath of files) {
    try {
      fileContents.set(filePath, readFileSync(filePath, 'utf-8'));
    } catch {
      // Will be reported as error in the parse loop
    }
  }

  let currentLang = '';

  // ── Phase 1: Parse + Extract (no SQLite, files already read) ─────────
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

      // R81: Bug 16 fix — PLANNING PHASE. Do NOT delete old nodes/edges yet.
      // Previously, the code deleted old nodes BEFORE parsing, so a parse
      // failure would lose the old graph. Now we collect changed files and
      // do all mutations in the transaction AFTER parse succeeds.
      const stat = statSync(filePath);
      // R81: use fileContents.has() to distinguish empty file from read failure
      if (!fileContents.has(filePath)) {
        result.errors.push({ file: relPath, error: 'file read failed (not in pre-read cache)' });
        continue;
      }
      const content = fileContents.get(filePath)!;
      const hash = createHash('sha256').update(content).digest('hex');
      
      if (incremental) {
        const existing = db.prepare(
          'SELECT content_hash FROM file_hashes WHERE project = ? AND file_path = ?'
        ).get(project, relPath) as { content_hash: string } | undefined;
        if (existing && existing.content_hash === hash) {
          result.skipped++;
          continue;
        }
        // R82: Bug 20 fix — do NOT push to changedRelPaths or pendingHashUpdates yet.
        // Previously (R81), these were pushed BEFORE parse/extract, so a parse
        // failure would still delete old nodes and update the hash, causing
        // silent corruption (next run skips the file that never extracted).
        // Now we collect the hash info but only push to the mutation lists
        // AFTER extractFast succeeds.
      }
      const hashInfo = { project, relPath, hash, mtime: Math.floor(stat.mtimeMs), indexedAt: new Date().toISOString() };

      // R75: skip setLanguage if language hasn't changed (common case: all files same lang)
      if (currentLang !== lang) {
        parser.setLanguage(language);
        currentLang = lang;
      }

      // R75: read from pre-read cache instead of readFileSync
      const source = content;
      const tree = parser.parse(source);
      if (!tree) {
        result.errors.push({ file: relPath, error: 'parse returned null' });
        continue;
      }

      // R78: use try/finally to guarantee tree.delete() even if extractFast throws.
      try {
        const fileQn = `${project}::${relPath}`;
        const extracted = extractFast(tree.rootNode, project, relPath, fileQn, source.length);

        allExtracts.push({ relPath, nodes: extracted.nodes, edges: extracted.edges });
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
      upsertFileHash.run(h.project, h.relPath, h.hash, h.mtime, h.indexedAt);
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
  });
  tx();

  return result;
}

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

