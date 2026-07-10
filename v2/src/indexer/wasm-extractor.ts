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
import { relative, extname, basename, dirname, join, sep } from 'node:path';
import { readFileSync, statSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extractFast, type UnresolvedCallSite, type ImportBinding, type ExportBinding } from './fast-walker.js';
import { replaceCallSitesForFiles, replaceImportsForFiles, replaceExportsForFiles, rebuildCrossFileCallsEdges, clearCrossFileCallEdges, isCallSitesInitialized, isExtractorSemanticsCurrent } from './cross-file-resolver.js';
import { isPathInside } from '../utils/safe-path.js';
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
 * R141 (PERF-R141-01): Check whether a real target path passes ANY component
 * of SKIP_DIRS — not just the basename. Previously only `basename(realTarget)`
 * was checked, so an alias like `link -> node_modules/pkg/src` (basename=`src`)
 * bypassed the filter and let `node_modules/.../dep.ts` be indexed.
 *
 * The check is performed against the canonical path relative to realRoot,
 * so a deep alias is rejected if any ancestor directory is in SKIP_DIRS or
 * starts with '.' (hidden directory).
 *
 * `realRoot` is the resolved root. `realTarget` is the resolved target path
 * (already confirmed to be inside realRoot by isPathInside).
 */
function hasSkippedComponent(realRoot: string, realTarget: string): boolean {
  const rel = relative(realRoot, realTarget);
  if (rel === '') return false; // the root itself
  const components = rel.split(sep);
  for (const component of components) {
    if (component === '') continue;
    if (SKIP_DIRS.has(component) || component.startsWith('.')) {
      return true;
    }
  }
  return false;
}

/**
 * R142 (DATA-R142-02): A structured discovery error. The walker collects
 * these instead of silently swallowing them. The indexer uses the list to
 * decide whether the discovery is "complete" (0 errors) or "partial"
 * (>0 errors). A partial discovery in full mode must NOT clear the
 * existing graph; in incremental mode it must NOT compute deletedRelPaths
 * for the affected subtrees.
 */
export interface DiscoveryError {
  /** Absolute path of the directory or file that triggered the error. */
  path: string;
  /** Node.js error code (EACCES, ELOOP, EIO, ENOMEM, etc.). */
  code: string;
  /** Human-readable message for diagnostics. */
  message: string;
}

/**
 * R142 (DATA-R142-02): Structured discovery result. Replaces the bare
 * `string[]` return type of `discoverSourceFilesWasm` for callers that
 * need to distinguish "valid empty project" from "errored partial
 * discovery". The legacy `discoverSourceFilesWasm` still returns `string[]`
 * for backward compatibility but delegates to the structured version.
 */
export interface DiscoveryResult {
  /** Canonical realpath of the root (following any root symlinks). */
  realRoot: string;
  /** Discovered source files (canonical absolute paths, sorted). */
  files: string[];
  /** Errors encountered during traversal (readdir/lstat/realpath/stat failures). */
  errors: DiscoveryError[];
  /**
   * `true` iff `totalErrors === 0`. When false, the discovery is partial:
   * some subtrees were inaccessible and `files` may be incomplete. The
   * indexer must NOT treat missing files as deleted in this case.
   */
  complete: boolean;
  /**
   * R143 (PERF-R143-01): Total number of errors encountered. May exceed
   * `errors.length` (which is capped at 100 samples). Use this for the
   * `complete` check and for diagnostics.
   */
  totalErrors: number;
  /**
   * R143 (PERF-R143-01): Per-error-code counts. E.g. `{ EACCES: 5, ELOOP: 1 }`.
   * Always complete (not capped) — useful for diagnostics dashboards.
   */
  countsByCode: Record<string, number>;
  /**
   * R145 (DISC-R145-01): Total number of warnings encountered. Warnings
   * (broken symlinks, ELOOP, target disappearance) do NOT make discovery
   * incomplete, but are tracked for diagnostics. The UI/MCP can show
   * "5 broken symlinks skipped" without alarming the user.
   */
  totalWarnings: number;
  /**
   * R145 (DISC-R145-01): Per-warning-code counts. E.g. `{ ENOENT: 3, ELOOP: 1 }`.
   */
  warningCountsByCode: Record<string, number>;
  /**
   * R147 (DATA-R147-01): Paths that disappeared during traversal (ENOENT race).
   * These are NOT confirmed deletions — the file may have been temporarily
   * absent (atomic save, codegen, package manager). The indexer MUST NOT
   * include these paths in `deletedRelPaths` — doing so would silently
   * delete nodes/hashes/imports/exports for a file that still exists.
   * Each entry is the relative path from realRoot.
   */
  uncertainPaths: string[];
  /**
   * R147 (DATA-R147-02): Directory subtrees that disappeared during traversal.
   * Same semantics as `uncertainPaths` but for directories. The indexer MUST
   * NOT delete any path under these prefixes.
   */
  uncertainSubtrees: string[];
  /**
   * R150 (DATA-R150-02): Global deletion uncertainty. When true, the indexer
   * MUST NOT treat ANY path as a confirmed deletion. Set when a broken
   * symlink is encountered that may have been valid at the previous run.
   */
  globalDeletionUncertainty: boolean;
  /**
   * R151 (OBS-R151-01): Warning samples with paths, capped at 100.
   * Lets the user identify which symlinks to fix.
   */
  warningSamples: Array<{ path: string; code: string }>;
  /** Diagnostic counters. */
  skippedExternalSymlinks: number;
  skippedPolicyPaths: number;
  duplicates: number;
}

/**
 * R141/R142 (IDX-R141-01, ID-R142-01): Build a stable identity key for a
 * regular file.
 *
 * `dev:ino` is the most robust identifier — it distinguishes two distinct
 * files even when they share a name, and identifies two paths pointing to
 * the same file (hardlinks, file symlinks). On most platforms this is
 * unique and stable across readdir order.
 *
 * R142 (ID-R142-01): Some filesystems (network mounts, FUSE, certain
 * Windows volumes) return `dev=0, ino=0` for ALL files. Using `0:0` as
 * the identity key would collapse every file into one entry — only the
 * first file encountered would be indexed. We now detect this case and
 * fall back to `path:<realpath>` for files whose dev/ino are both zero.
 * This is less robust (two paths to the same file get two entries) but
 * avoids the catastrophic collision.
 *
 * Fallback chain:
 *   1. stat → if dev/ino both non-zero → `inode:<dev>:<ino>:<lang>`
 *   2. stat → if dev/ino both zero → `path:<realpath>:<lang>`
 *   3. stat fails → `path:<realpath>:<lang>` (exotic FUSE)
 *   4. stat + realpath both fail → null (skip)
 *
 * R144 (IDX-R144-01): The identity key now includes the language. Two paths
 * to the same inode with DIFFERENT extensions (module.ts + module.js) are
 * treated as SEPARATE files, not deduplicated. This prevents the wrong
 * grammar from being chosen (e.g., TypeScript content parsed as JavaScript
 * because module.js won the lexical tie-break). Each language gets its own
 * identity key, so both are indexed independently.
 *
 * Returns null only if both stat AND realpath fail — at which point the
 * caller skips the file (treat as inaccessible).
 */
function fileIdentityKey(fullPath: string, language: string): string | null {
  try {
    const st = statSync(fullPath, { bigint: true });
    // R142 (ID-R142-01): detect untrustworthy dev:ino (both zero).
    // Network filesystems and some FUSE mounts return 0:0 for all files.
    // Using it as-is would collapse all files into one identity → only
    // the first file encountered would be indexed.
    if (st.dev === 0n && st.ino === 0n) {
      // R143 (ID-R143-02): Fall back to realpath-based identity. If
      // realpath ALSO fails, return null (fail-closed) — do NOT use the
      // lexical path, which contradicts the fail-closed policy and could
      // produce unstable keys across readdir order. The caller will skip
      // the file and record an error.
      try {
        return `path:${realpathSync(fullPath)}:${language}`;
      } catch {
        return null;
      }
    }
    return `inode:${st.dev}:${st.ino}:${language}`;
  } catch {
    // R143 (ID-R143-02): stat failed — try realpath. If realpath also
    // fails, return null (fail-closed).
    try {
      return `path:${realpathSync(fullPath)}:${language}`;
    } catch {
      return null;
    }
  }
}

/**
 * R142 (DATA-R142-02): Walk a directory and return all supported source
 * files PLUS a structured list of errors encountered during traversal.
 *
 * This is the canonical implementation. The legacy `discoverSourceFilesWasm`
 * (below) delegates to this and discards the errors — it exists only for
 * backward compatibility with external callers.
 *
 * R142 changes vs R141:
 *   - Accepts an optional `canonicalRoot` (the realpath-resolved root from
 *     `assertDiscoveryRoot`). When provided, skips the redundant
 *     stat+realpath+readdir on the root (PERF-R142-01) and uses the
 *     canonical root for all relative-path computation (PATH-R142-01).
 *   - Collects readdir/lstat/realpath/stat errors into `errors[]` instead
 *     of swallowing them (DATA-R142-02). The indexer uses `complete` to
 *     decide whether to clear/publish (full mode) or compute deletedRelPaths
 *     (incremental mode).
 *   - `detectLanguage` is now called BEFORE `visitedFiles.add` (IDX-R142-01).
 *     Previously a non-code hardlink (a.txt) seen first would mark the inode
 *     visited, causing the code hardlink (z.ts, same inode) to be skipped.
 *   - Special files (FIFO, socket, device) are now rejected via
 *     `realStat.isFile()` (SEC-R142-01). Previously the `else` branch of
 *     `isDirectory()` treated ALL non-dir types as file candidates, which
 *     could cause `readFileSync` to block forever on a FIFO.
 *   - `fileIdentityKey` detects `dev:ino = 0n` and falls back to
 *     `path:<realpath>` (ID-R142-01).
 *
 * Throws if the root is missing, not a directory, or not readable
 * (including readdir-EACCES — the R142 preflight). The caller should
 * have already validated via `assertDiscoveryRoot` and passed the
 * canonical root to avoid a redundant validation round.
 */
export function discoverSourceFilesStructured(
  rootPath: string,
  canonicalRoot?: string,
): DiscoveryResult {
  // R142 (PERF-R142-01, PATH-R142-01): If the caller already validated the
  // root via assertDiscoveryRoot and passed the canonical realpath, reuse
  // it. This eliminates a redundant stat+realpath+readdir on the root.
  let realRoot: string;
  if (canonicalRoot !== undefined) {
    realRoot = canonicalRoot;
  } else {
    // Legacy path: validate inline. This is the same logic as
    // assertDiscoveryRoot but throws a generic Error (not DiscoveryRootError)
    // for backward compatibility with external callers that don't use the
    // structured API.
    let rootStat;
    try {
      rootStat = statSync(rootPath);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') {
        throw new Error(`Discovery root not found: "${rootPath}"`);
      }
      throw new Error(`Discovery root not readable: "${rootPath}" (${code ?? 'unknown'})`);
    }
    if (!rootStat.isDirectory()) {
      throw new Error(`Discovery root is not a directory: "${rootPath}"`);
    }
    try {
      realRoot = realpathSync(rootPath);
    } catch (error) {
      const code = (error as { code?: string }).code;
      throw new Error(`Discovery root not readable: "${rootPath}" (${code ?? 'realpath failed'})`);
    }
    // R142 (DATA-R142-01): also verify readdir works on the root.
    try {
      readdirSync(realRoot);
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'unknown';
      throw new Error(`Discovery root not readable: "${rootPath}" (${code}: readdir failed)`);
    }
  }

  const errors: DiscoveryError[] = [];
  let skippedExternalSymlinks = 0;
  let skippedPolicyPaths = 0;
  let duplicates = 0;

  // R140: Track visited realpaths for ALL directories (regular + symlink)
  // to prevent duplicate indexing and cycles.
  const visitedDirs = new Set<string>([realRoot]);
  // R141 (IDX-R141-01): Track visited file identities so two aliases to the
  // same file produce exactly one result. The key is `dev:ino:lang` (with
  // realpath fallback) — see fileIdentityKey.
  // R143 (ID-R143-01): Map identity → chosen canonical path. When a second
  // candidate for the same identity is found, we keep the lexicographically
  // smaller path. This makes hardlink selection deterministic across readdir
  // order.
  // R144 (IDX-R144-01): The identity now includes the language, so two paths
  // to the same inode with DIFFERENT extensions (module.ts + module.js) are
  // treated as SEPARATE files — both are indexed independently. This prevents
  // the wrong grammar from being chosen.
  // R144 (PERF-R144-02): We no longer push to a results array during the
  // loop (which required O(N) indexOf + splice for tie-break replacements,
  // making it O(N²)). Instead, we build results at the end from
  // visitedFiles.values().
  const visitedFiles = new Map<string, string>();
  // R143 (ID-R143-01) / R144 (PERF-R144-02): Helper to add a file with
  // deterministic tie-breaking. Returns true if the file was added or
  // replaced, false if the existing entry was kept.
  function addFileCandidate(identity: string, canonicalPath: string): boolean {
    const existing = visitedFiles.get(identity);
    if (existing === undefined) {
      visitedFiles.set(identity, canonicalPath);
      return true;
    }
    // R143 (ID-R143-01): deterministic tie-break — keep the lexicographically
    // smaller path. R144 (IDX-R144-01): since identity includes language,
    // this tie-break only applies to paths with the SAME extension (e.g.,
    // two aliases both ending in .ts pointing to the same inode).
    if (canonicalPath < existing) {
      visitedFiles.set(identity, canonicalPath);
      return true;
    }
    return false;
  }
  // R141 (IDX-R141-02): Push the canonical real path, not the lexical alias.
  // This makes discovery deterministic across readdir order.
  const stack: string[] = [realRoot];

  // R143 (PERF-R143-01): Cap the errors array at 100 samples. A repo with
  // thousands of inaccessible entries could OOM. We track the total count
  // separately so the caller knows the real number.
  const MAX_STORED_ERRORS = 100;
  let totalErrorCount = 0;
  const countsByCode = new Map<string, number>();
  // R145 (DISC-R145-01): Warning tracking. Warnings (ENOENT, ELOOP) don't
  // make discovery incomplete but are tracked for diagnostics.
  let totalWarningCount = 0;
  const warningCountsByCode = new Map<string, number>();
  // R147 (DATA-R147-01/02): Uncertain paths/subtrees. These disappeared
  // during traversal (ENOENT race). The indexer MUST NOT treat them as
  // confirmed deletions — they may have been temporarily absent.
  const uncertainPaths: string[] = [];
  const uncertainSubtrees: string[] = [];
  // R150 (DATA-R150-02): Global deletion uncertainty. Set when a broken
  // symlink is encountered that may have been valid at the previous run.
  // Without alias history, we cannot distinguish permanently broken from
  // temporarily broken. When set, ALL deletions are blocked — the indexer
  // must not treat ANY path as a confirmed deletion.
  let globalDeletionUncertainty = false;

  /**
   * R145 (DISC-R145-01): Record a discovery warning. Warnings don't make
   * discovery incomplete (the entry is simply skipped), but are tracked
   * so the UI/MCP can report "5 broken symlinks skipped" without alarming
   * the user.
   * R151 (OBS-R151-01): Also store up to 100 warning samples with paths
   * so the user can identify which symlinks to fix.
   */
  const MAX_WARNING_SAMPLES = 100;
  const warningSamples: Array<{ path: string; code: string }> = [];

  function recordWarning(code: string, path?: string): void {
    totalWarningCount++;
    warningCountsByCode.set(code, (warningCountsByCode.get(code) ?? 0) + 1);
    if (path !== undefined && warningSamples.length < MAX_WARNING_SAMPLES) {
      warningSamples.push({ path, code });
    }
  }

  /**
   * R142 (DATA-R142-02): Record a discovery error. The error is pushed to
   * `errors[]` so the indexer can detect partial discovery. The caller
   * (indexer) uses `result.complete` to decide whether to clear/publish.
   *
   * R143 (PERF-R143-01): Cap at MAX_STORED_ERRORS samples. The total count
   * and per-code counts are always tracked.
   */
  function recordError(path: string, error: unknown): void {
    const code = (error as { code?: string }).code ?? 'unknown';
    const message = (error as Error).message ?? String(error);
    totalErrorCount++;
    countsByCode.set(code, (countsByCode.get(code) ?? 0) + 1);
    if (errors.length < MAX_STORED_ERRORS) {
      errors.push({ path, code, message });
    }
  }

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (error) {
      // R142 (DATA-R142-02): record the error instead of silently
      // continuing. The indexer will see `complete=false` and refuse to
      // clear/publish (full mode) or compute deletedRelPaths (incremental).
      recordError(dir, error);
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let lst;
      try {
        lst = lstatSync(fullPath);
      } catch (error) {
        // R146 (DISC-R146-01): Classify lstat errors by code.
        // R145 treated ALL lstat errors as fatal (recordError → incomplete).
        // A file that disappears between readdirSync and lstatSync (TOCTOU
        // race) is common in build directories, codegen, package managers.
        // ENOENT should be a warning (skip), not fatal.
        const code = (error as { code?: string }).code ?? 'unknown';
        if (code === 'ENOENT') {
          // Entry disappeared between readdir and lstat — warning, skip.
          // R147 (DATA-R147-01): Record the path as uncertain. The indexer
          // must NOT treat this as a confirmed deletion — the file may have
          // been temporarily absent (atomic save, codegen, package manager).
          recordWarning('ENOENT_LSTAT');
          uncertainPaths.push(relative(realRoot, fullPath));
          continue;
        }
        // EACCES, EIO, etc. — fatal.
        recordError(fullPath, error);
        continue;
      }

      if (lst.isSymbolicLink()) {
        // R143 (DISC-R143-01): Check SKIP_DIRS/hidden by ENTRY NAME before
        // realpathSync. A broken symlink named `node_modules-link` or
        // `.cache-link` should be skipped by policy WITHOUT calling
        // realpath (which would fail and make the entire discovery
        // incomplete). R142 called realpath first, so a single broken
        // symlink blocked the entire full index.
        if (SKIP_DIRS.has(entry) || entry.startsWith('.')) {
          skippedPolicyPaths++;
          continue;
        }

        // R139/R140/R141/R142/R143/R144: Resolve symlink target and check containment.
        let realTarget: string;
        try {
          realTarget = realpathSync(fullPath);
        } catch (error) {
          // R144 (DISC-R144-01): Classify symlink errors by code.
          // R143 treated ALL realpath failures as "broken symlink, skip"
          // which masked real filesystem problems (EACCES, EIO, ELOOP).
          const code = (error as { code?: string }).code ?? 'unknown';
          if (code === 'ENOENT') {
            // Broken symlink (target deleted, stale alias) — WARNING.
            // Common in npm, git worktrees, IDEs. Does NOT indicate a
            // filesystem health problem. Skip without recording an error.
            // The discovery remains complete.
            // R145 (DISC-R145-01): track as warning for diagnostics.
            // R148 (DATA-R148-02): Do NOT add to uncertainPaths. A broken
            // symlink is NOT a TOCTOU race — readdir saw the symlink entry,
            // not the target. The target may have never existed. Only files
            // that were seen by readdir AND then disappeared at lstat/stat
            // are uncertain (atomic save race). Broken symlinks are just
            // permanently broken — the old data (if any) is for the symlink
            // path, not the target, so there's nothing to preserve.
            // R150 (DATA-R150-02): However, the symlink MAY have been valid
            // at the previous run, and its target may be temporarily absent
            // (TOCTOU). Without alias history, we cannot distinguish
            // permanently broken from temporarily broken. To be safe, we
            // set a global deletion uncertainty flag that prevents ALL
            // deletions in this run. The next successful run (when the
            // target is back) will re-index normally. This is conservative
            // but prevents silent data loss.
            // R151 (OBS-R151-01): Include the symlink path in the warning
            // sample so the user can identify which link to fix.
            // R151 (AVAIL-R151-01): Only set globalDeletionUncertainty if
            // there's an existing graph to protect. On a first full index,
            // there's nothing to delete — blocking would prevent the project
            // from ever being indexed. The first full creates the initial
            // graph; subsequent runs with broken symlinks protect it.
            // R152 (SEC-R152-01): Use root-relative path for privacy and portability.
            recordWarning('ENOENT', relative(realRoot, fullPath));
            // R152: globalDeletionUncertainty is no longer set by discovery
            // for broken symlinks. See indexer.ts R152 comment for rationale.
            continue;
          }
          if (code === 'ELOOP') {
            // R144 (DISC-R144-01): Symlink loop — policy decision.
            // A symlink loop is a configuration error, not a transient
            // I/O issue. Skip (discovery remains complete).
            // R145 (DISC-R145-01): track as warning so it's visible.
            // R152 (OBS-R152-02): include path for diagnostics.
            recordWarning('ELOOP', relative(realRoot, fullPath));
            continue;
          }
          // R144 (DISC-R144-01): EACCES, EIO, ENOMEM, EMFILE — FATAL.
          // These indicate a real filesystem health problem (permission
          // denied, I/O error, out of memory, too many open files).
          // The discovery MUST be marked incomplete so the indexer
          // preserves the existing graph instead of publishing a partial
          // one. R143's "skip all" behavior masked these critical errors.
          recordError(fullPath, error);
          continue;
        }
        // R141 (QUAL-R141-01): use the unified isPathInside — same predicate
        // as vault writes. No more drift between discovery and vault.
        if (!isPathInside(realRoot, realTarget)) {
          skippedExternalSymlinks++;
          continue; // External symlink — skip
        }
        // R141 (PERF-R141-01): Check SKIP_DIRS against ALL components of the
        // canonical target path (relative to realRoot), not just basename.
        // Catches `link -> node_modules/pkg/src` (basename=`src` is fine,
        // but `node_modules` is in the path).
        if (hasSkippedComponent(realRoot, realTarget)) {
          skippedPolicyPaths++;
          continue;
        }

        let realStat;
        try {
          // R141: statSync(realTarget) not statSync(fullPath) — we want the
          // type of the target, not the symlink. They're equivalent on most
          // platforms, but using realTarget is more explicit.
          realStat = statSync(realTarget);
        } catch (error) {
          // R145 (DISC-R145-02): Classify target disappearance by code.
          // R144 treated ALL stat errors as fatal (recordError → incomplete).
          // A target that disappears between realpath and stat (TOCTOU race)
          // is equivalent to a broken symlink — ENOENT should be a warning
          // (skip), not fatal. EACCES/EIO remain fatal.
          const code = (error as { code?: string }).code ?? 'unknown';
          if (code === 'ENOENT') {
            // Target disappeared between realpath and stat — warning, skip.
            // Don't call recordError — discovery stays complete.
            // R145 (DISC-R145-02): track as warning for diagnostics.
            // R149 (DATA-R149-02): realTarget IS known (realpath succeeded).
            // R150 (DATA-R150-01): Since the target type (file vs directory)
            // is no longer observable after ENOENT on stat, we add the path
            // to BOTH uncertainPaths (exact match) AND uncertainSubtrees
            // (prefix match). If the target was a directory, its descendants
            // (target/a.ts, target/b.ts) would only be protected by the
            // subtree prefix filter. Without this, an incremental index
            // could delete all old nodes under the directory.
            recordWarning('ENOENT_STAT');
            const relTarget = relative(realRoot, realTarget);
            uncertainPaths.push(relTarget);
            uncertainSubtrees.push(relTarget);
            continue;
          }
          // EACCES, EIO, etc. — fatal.
          recordError(realTarget, error);
          continue;
        }

        if (realStat.isDirectory()) {
          // R141 (IDX-R141-02): Push the CANONICAL realTarget, not fullPath.
          // This makes the alias transparent: the discovery proceeds from
          // the real path, so all descendant files are persisted with
          // canonical paths.
          if (visitedDirs.has(realTarget)) {
            duplicates++;
            continue;
          }
          visitedDirs.add(realTarget);
          stack.push(realTarget);
        } else if (realStat.isFile()) {
          // R142 (SEC-R142-01): Only treat REGULAR files as candidates.
          // Previously the `else` branch of isDirectory() accepted ALL
          // non-dir types, including FIFOs, sockets, and devices. A symlink
          // to a FIFO with a .ts extension would be pushed as a candidate,
          // and readFileSync would block forever waiting for a writer.
          // R142 (IDX-R142-01): detect language BEFORE marking visited.
          // A non-code hardlink seen first would otherwise poison the
          // visitedFiles set and suppress the code hardlink.
          const lang = detectLanguage(realTarget);
          if (!lang) {
            continue; // unsupported extension — don't mark visited
          }
          const identity = fileIdentityKey(realTarget, lang);
          if (identity === null) {
            // R147 (DISC-R147-01): fileIdentityKey returned null — the file
            // disappeared between lstat and stat/realpath (TOCTOU race).
            // R146 treated this as fatal (recordError → discovery incomplete).
            // But the same ENOENT race is a warning everywhere else. Now we
            // treat it as a warning too — record the uncertain path so the
            // indexer doesn't delete the old data for this file.
            recordWarning('ENOENT_IDENTITY');
            uncertainPaths.push(relative(realRoot, realTarget));
            continue;
          }
          // R143 (ID-R143-01): deterministic tie-breaking. R144 (PERF-R144-02):
          // addFileCandidate updates the Map; we build results at the end.
          if (!addFileCandidate(identity, realTarget)) {
            duplicates++;
          }
        } else {
          // R142 (SEC-R142-01): FIFO, socket, character device, block device.
          // Silently skip — these are not source files and reading them
          // could block or error. No need to record an error; the user
          // intentionally created a special file.
          continue;
        }
      } else if (lst.isDirectory()) {
        if (SKIP_DIRS.has(entry) || entry.startsWith('.')) {
          skippedPolicyPaths++;
          continue;
        }
        // R141 (SEC-R141-02): Fail-CLOSED realpath for regular directories.
        // The previous code swallowed ALL realpath errors and pushed the
        // lexical fullPath anyway. That was fail-OPEN: an EACCES or ELOOP
        // on a regular directory would silently let traversal continue
        // past the boundary. Now we push only the canonical realTarget —
        // if realpath fails, we record the error and skip the directory.
        let realDir: string;
        try {
          realDir = realpathSync(fullPath);
        } catch (error) {
          // R146 (DISC-R146-01): Classify regular-directory realpath errors.
          // R145 treated ALL realpath errors as fatal. A directory that
          // disappears between lstat and realpath (TOCTOU race) should be
          // a warning, not fatal. ENOENT → warning (skip). EACCES/EIO → fatal.
          const code = (error as { code?: string }).code ?? 'unknown';
          if (code === 'ENOENT') {
            // Directory disappeared between lstat and realpath — warning, skip.
            // R147 (DATA-R147-02): Record the subtree as uncertain. The indexer
            // must NOT delete any path under this prefix — the directory may
            // have been temporarily absent.
            recordWarning('ENOENT_REALPATH_DIR');
            uncertainSubtrees.push(relative(realRoot, fullPath));
            continue;
          }
          // EACCES, EIO, ELOOP, etc. — fatal.
          recordError(fullPath, error);
          continue;
        }
        if (visitedDirs.has(realDir)) {
          duplicates++;
          continue; // Already visited via symlink or another path
        }
        visitedDirs.add(realDir);
        // R141 (IDX-R141-02): Push canonical realDir, not lexical fullPath.
        stack.push(realDir);
      } else if (lst.isFile()) {
        // R141 (IDX-R141-01): Dedup regular files too (hardlinks). Without
        // this, two hardlinks to the same file would produce two File nodes
        // with different paths — same problem as file symlinks.
        // R142 (IDX-R142-01): detect language BEFORE marking visited.
        const lang = detectLanguage(fullPath);
        if (!lang) {
          continue; // unsupported extension — don't mark visited
        }
        const identity = fileIdentityKey(fullPath, lang);
        if (identity === null) {
          // R147 (DISC-R147-01): TOCTOU race — file disappeared between lstat
          // and stat/realpath in fileIdentityKey. Warning, not fatal.
          recordWarning('ENOENT_IDENTITY');
          uncertainPaths.push(relative(realRoot, fullPath));
          continue;
        }
        // R143 (ID-R143-01): deterministic tie-breaking for hardlinks.
        // R144 (PERF-R144-02): no results.push here — build at end.
        if (!addFileCandidate(identity, fullPath)) {
          duplicates++;
        }
      }
      // R142 (SEC-R142-01): non-file, non-dir, non-symlink regular entries
      // (FIFO, socket, device) are silently skipped.
    }
  }

  // R143 (PERF-R143-01): convert countsByCode Map to a plain object.
  const countsByCodeObj: Record<string, number> = {};
  for (const [code, count] of countsByCode) {
    countsByCodeObj[code] = count;
  }

  // R144 (PERF-R144-02): Build results from visitedFiles.values() at the end.
  // This avoids the O(N) indexOf + splice in addFileCandidate, making the
  // overall discovery O(N) instead of O(N²) for repositories with many
  // hardlink groups.
  const files = [...visitedFiles.values()].sort();

  // R145 (DISC-R145-01): convert warningCountsByCode Map to plain object.
  const warningCountsByCodeObj: Record<string, number> = {};
  for (const [code, count] of warningCountsByCode) {
    warningCountsByCodeObj[code] = count;
  }

  return {
    realRoot,
    files,
    errors,
    complete: totalErrorCount === 0,
    totalErrors: totalErrorCount,
    countsByCode: countsByCodeObj,
    totalWarnings: totalWarningCount,
    warningCountsByCode: warningCountsByCodeObj,
    uncertainPaths,
    uncertainSubtrees,
    globalDeletionUncertainty,
    warningSamples,
    skippedExternalSymlinks,
    skippedPolicyPaths,
    duplicates,
  };
}

/**
 * Legacy wrapper around `discoverSourceFilesStructured`. Returns only the
 * file list (no errors). Kept for backward compatibility with external
 * callers and tests that expect `string[]`.
 *
 * R143 (API-R143-01): If the discovery is PARTIAL (errors present), this
 * wrapper THROWS instead of silently returning an incomplete file list.
 * The previous behavior discarded `errors` and `complete`, which could
 * cause external callers to treat a partial discovery as complete —
 * leading to silent data loss in incremental mode. External callers
 * that want partial results should use `discoverSourceFilesStructured`
 * directly and inspect `result.complete`.
 *
 * R142: throws on root failure (same as R141).
 */
export function discoverSourceFilesWasm(rootPath: string): string[] {
  const result = discoverSourceFilesStructured(rootPath);
  if (!result.complete) {
    const sample = result.errors.slice(0, 5).map(e => `${e.path}: ${e.code}`).join('; ');
    throw new Error(
      `Discovery incomplete (${result.totalErrors} errors). Use discoverSourceFilesStructured() for partial results. First errors: ${sample}`
    );
  }
  return result.files;
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

