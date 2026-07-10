// v2/src/indexer/cross-file-resolver.ts
// R106: Shared cross-file CALLS resolution using the persistent `call_sites` table.
//
// Before R106: cross-file CALLS edges were only resolved in full mode. In
// incremental mode, the global symbol index would only contain symbols from
// changed files, dropping edges to/from unchanged files. The
// `crossFileCallsStale` flag marked the graph as stale until a full reindex.
//
// R106: introduces a persistent `call_sites` table. Each unresolved call-site
// is stored with its source QN, callee name, call kind, and source file path.
// In incremental mode, only call_sites for changed/deleted files are removed;
// call_sites for unchanged files remain. Cross-file CALLS edges are then
// rebuilt from the full call_sites table + the current nodes table.
//
// This module is shared between the single-thread path (wasm-extractor.ts)
// and the parallel path (indexer.ts) to avoid duplicating the resolution logic.
//
// Resolution algorithm:
//   1. Build global symbol index (name → QN[]) from ALL nodes in DB for the project.
//   2. Build QN → node ID map from ALL nodes in DB.
//   3. Delete ALL existing cross-file CALLS edges (identified by properties_json
//      containing "resolution":"cross_file_*"). Intra-file CALLS edges
//      (resolution="intra_file") are preserved.
//   4. For each call_site in the persistent table:
//      - Try import-aware resolution (named/alias/default/namespace).
//      - R126: if the import binding is explicit but the source module is
//        unresolved, OR the export resolution returns `unknown`/`missing`/
//        `ambiguous`, the call-site is TERMINAL — no name-based fallback —
//        when the project's extractor_semantics_version is current.
//      - Otherwise (no import binding, or legacy semantics version), fall
//        back to name-based resolution with up to 5 candidates.
//
// Performance:
//   - O(N) for nodes table scan (N = nodes in project)
//   - O(M) for call_sites scan (M = call_sites in project)
//   - O(1) per call_site for symbol lookup (Map)
//   - O(E × U) worst-case for star re-export traversal, where E is the number
//     of `export *` edges and U is the number of distinct (file, name) pairs
//     resolved in a single rebuild. The depth is capped at 10 and each branch
//     carries its own visited set, so the traversal is bounded.
//   - R126 NOTE: the previous "O(1) per call_site" comment was correct only
//     when star re-exports were not detected (pre-R125B). With R125B's Bug 57
//     fix, barrels are actually traversed, so the worst case is now
//     O(N + M + E × U). A per-rebuild (file, name) cache is planned for R128.
//   - For a typical 10k-node project with 5k call_sites and <100 barrels:
//     ~50-150ms. Deep barrel chains (10+) or diamond topologies may add
//     20-50ms. Acceptable for Phase 1.

import type Database from 'better-sqlite3';
import type { UnresolvedCallSite, ImportBinding, ExportBinding } from './fast-walker.js';
import { BUILTIN_METHOD_NAMES } from './fast-walker.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from './schema.js';
// R126: CURRENT_EXTRACTOR_SEMANTICS_VERSION is re-exported via the helper
// isExtractorSemanticsCurrent() for callers that need to check the stored
// version (e.g. incremental mode deciding whether to pass semanticsCurrent=true).

// R116: moved from extraction-time to resolution-time filter
const BUILTIN_METHOD_NAMES_SET = BUILTIN_METHOD_NAMES;

/**
 * R106: Insert (or replace) call_sites for a set of files.
 *
 * Deletes existing call_sites for the given file paths, then inserts the new
 * call_sites. Must be called INSIDE a transaction by the caller.
 *
 * @param db          SQLite database handle.
 * @param project     Project name.
 * @param filePaths   File paths to delete existing call_sites for (changed + deleted files).
 * @param newSites    New call_sites to insert (from changed files only).
 */
export function replaceCallSitesForFiles(
  db: Database.Database,
  project: string,
  filePaths: string[],
  newSites: UnresolvedCallSite[],
): void {
  // 1. Delete existing call_sites for the given file paths.
  //    This covers both changed files (will be re-inserted below) and deleted
  //    files (no new sites to insert, so they just disappear).
  if (filePaths.length > 0) {
    const ph = filePaths.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM call_sites WHERE project = ? AND file_path IN (${ph})`
    ).run(project, ...filePaths);
  }

  // 2. Insert new call_sites (batch INSERT for performance).
  //    Use explicit prepared statement; for very large batches a multi-row
  //    INSERT could be faster, but typical changed-file count is small (<100).
  const insertStmt = db.prepare(
    `INSERT INTO call_sites (project, file_path, source_qn, callee, last_segment, call_kind, line)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const cs of newSites) {
    insertStmt.run(
      project,
      cs.filePath,
      cs.sourceQn,
      cs.calleeName,
      cs.lastSegment,
      cs.callKind,
      cs.line,
    );
  }
}

/**
 * R110: Insert (or replace) imports for a set of files.
 *
 * Deletes existing imports for the given file paths, then inserts the new
 * imports. Must be called INSIDE a transaction by the caller.
 *
 * @param db          SQLite database handle.
 * @param project     Project name.
 * @param filePaths   File paths to delete existing imports for (changed + deleted files).
 * @param newImports  New imports to insert (from changed files only).
 */
export function replaceImportsForFiles(
  db: Database.Database,
  project: string,
  filePaths: string[],
  newImports: ImportBinding[],
): void {
  // 1. Delete existing imports for the given file paths.
  if (filePaths.length > 0) {
    const ph = filePaths.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM imports WHERE project = ? AND file_path IN (${ph})`
    ).run(project, ...filePaths);
  }

  // 2. Insert new imports.
  const insertStmt = db.prepare(
    `INSERT INTO imports (project, file_path, local_name, source_module, imported_name, import_kind, line)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const imp of newImports) {
    insertStmt.run(
      project,
      imp.filePath,
      imp.localName,
      imp.sourceModule,
      imp.importedName,
      imp.importKind,
      imp.line,
    );
  }
}

/**
 * R119: Insert (or replace) exports for a set of files.
 * Same pattern as replaceImportsForFiles.
 */
export function replaceExportsForFiles(
  db: Database.Database,
  project: string,
  filePaths: string[],
  newExports: ExportBinding[],
): void {
  if (filePaths.length > 0) {
    const ph = filePaths.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM exports WHERE project = ? AND file_path IN (${ph})`
    ).run(project, ...filePaths);
  }
  const insertStmt = db.prepare(
    `INSERT INTO exports (project, file_path, exported_name, local_name, source_module, imported_name, export_kind, line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const exp of newExports) {
    insertStmt.run(
      project,
      exp.filePath,
      exp.exportedName,
      exp.localName,
      exp.sourceModule,
      exp.importedName,
      exp.exportKind,
      exp.line,
    );
  }
}

/**
 * R110: Resolve a source module path to a file path in the project.
 *
 * Handles relative imports like './b', '../utils/helpers', './b.ts'.
 * Tries common extensions and index files.
 *
 * R111: also handles imports with explicit extensions (./b.ts, ./b.js, ./dir/index.ts).
 * Before R111, importing './b.ts' would produce basePath='b.ts', then try
 * 'b.ts.ts', 'b.ts.tsx', etc. — never matching the actual file 'b.ts'.
 *
 * @param sourceModule  The module path as written in the import (e.g. './b')
 * @param currentFile   The file path of the importing file (e.g. 'a.ts')
 * @param knownFiles    Set of known file paths in the project
 * @returns The resolved file path, or null if not found
 */
function resolveModulePath(
  sourceModule: string,
  currentFile: string,
  knownFiles: Set<string>,
): string | null {
  // Only resolve relative imports (./ or ../)
  if (!sourceModule.startsWith('.')) return null;

  // Get the directory of the current file
  const currentDir = currentFile.includes('/')
    ? currentFile.substring(0, currentFile.lastIndexOf('/'))
    : '';

  // Resolve the relative path
  let resolved = sourceModule;
  // Handle ./ and ../
  const parts = (currentDir ? currentDir.split('/') : []);
  const modParts = resolved.split('/');
  const resultParts: string[] = [];
  for (const p of parts) resultParts.push(p);
  for (const p of modParts) {
    if (p === '.') continue;
    if (p === '..') {
      resultParts.pop();
      continue;
    }
    resultParts.push(p);
  }
  const basePath = resultParts.join('/');

  // R111: First, try basePath directly (handles imports with explicit extensions
  // like './b.ts', './b.js', './dir/index.ts'). Before R111, this case was missed:
  // importing './b.ts' produced basePath='b.ts', then the extension loop tried
  // 'b.ts.ts', 'b.ts.tsx', etc. — never matching the actual file 'b.ts'.
  if (knownFiles.has(basePath)) return basePath;

  // Try common extensions
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  for (const ext of extensions) {
    const candidate = basePath + ext;
    if (knownFiles.has(candidate)) return candidate;
  }
  // Try index files
  for (const ext of extensions) {
    const candidate = basePath + '/index' + ext;
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

/**
 * R106: Rebuild ALL cross-file CALLS edges for a project from the persistent
 * call_sites table + current nodes table.
 *
 * This function:
 *   1. Deletes ALL existing cross-file CALLS edges (preserves intra-file CALLS).
 *   2. Loads ALL nodes for the project, builds (name → QN[]) and (QN → id) maps.
 *   3. Loads ALL call_sites for the project.
 *   4. For each call_site, resolves to up to 5 candidates and inserts CALLS edges.
 *
 * R110: import-aware resolution. Before name-based fallback, the resolver
 * checks if the callee name matches an import binding in the call-site's file.
 * If so, it resolves to the imported symbol with high confidence.
 *
 * R126: the `semanticsCurrent` parameter controls whether `unknown` and
 * unresolved-source states are TERMINAL (no name-based fallback). Callers
 * MUST pass true for full reindex (the extractor just produced fresh data).
 * For incremental, callers MUST pass true iff the stored
 * extractor_semantics_version equals CURRENT_EXTRACTOR_SEMANTICS_VERSION.
 * When in doubt, passing false preserves the pre-R126 behavior (safe default
 * that avoids false negatives on legacy DBs).
 *
 * Returns the number of cross-file CALLS edges inserted.
 *
 * R109: safe to call when nodesCount=0 — deletes any stale cross-file edges,
 * then inserts 0 new edges (allNodes and allCallSites are empty arrays).
 * However, callers typically skip the call when nodesCount=0 for efficiency.
 *
 * Must be called INSIDE a transaction by the caller.
 */
export function rebuildCrossFileCallsEdges(
  db: Database.Database,
  project: string,
  semanticsCurrent: boolean = false,
): number {
  // 1. Delete ALL existing cross-file CALLS edges for this project.
  //    Identify by properties_json containing "resolution":"cross_file".
  //    Intra-file CALLS edges (resolution="intra_file") are preserved.
  db.prepare(
    `DELETE FROM edges
     WHERE project = ? AND type = 'CALLS'
       AND properties_json LIKE '%"resolution":"cross_file%'`
  ).run(project);

  // 2. Load ALL nodes for the project. Build:
  //    - globalSymbolIndex: name → QN[] (for name-based fallback resolution)
  //    - qnToId: QN → node id (for edge source_id/target_id resolution)
  //    - fileQnToPath: file QN → file path (for import-aware resolution)
  //    - knownFiles: set of file paths (for module path resolution)
  const allNodes = db.prepare(
    'SELECT id, name, qualified_name, file_path FROM nodes WHERE project = ?'
  ).all(project) as Array<{ id: number; name: string; qualified_name: string; file_path: string }>;

  const globalSymbolIndex = new Map<string, string[]>();
  const qnToId = new Map<string, number>();
  const knownFiles = new Set<string>();
  // R110: map from (filePath, symbolName) → QN for import-aware resolution.
  // This lets us resolve an import to a specific symbol in a specific file.
  const fileSymbolIndex = new Map<string, Map<string, string>>(); // filePath → (name → QN)
  for (const node of allNodes) {
    qnToId.set(node.qualified_name, node.id);
    knownFiles.add(node.file_path);
    // Build per-file symbol index for import-aware resolution
    let fileMap = fileSymbolIndex.get(node.file_path);
    if (!fileMap) {
      fileMap = new Map();
      fileSymbolIndex.set(node.file_path, fileMap);
    }
    if (!node.name.startsWith('anonymous#')) {
      // Only store the first QN per name per file (most common case)
      if (!fileMap.has(node.name)) {
        fileMap.set(node.name, node.qualified_name);
      }
    }
    // Skip anonymous functions — they can't be called by name cross-file
    if (node.name.startsWith('anonymous#')) continue;
    const existing = globalSymbolIndex.get(node.name);
    if (existing) existing.push(node.qualified_name);
    else globalSymbolIndex.set(node.name, [node.qualified_name]);
  }

  // 3. Load ALL call_sites for the project.
  //    R110: also load file_path for import-aware resolution.
  const allCallSites = db.prepare(
    'SELECT source_qn, callee, last_segment, call_kind, file_path FROM call_sites WHERE project = ?'
  ).all(project) as Array<{
    source_qn: string;
    callee: string;
    last_segment: string;
    call_kind: string;
    file_path: string;
  }>;

  // R110: Load ALL imports for the project and build per-file import maps.
  // importsByFile: filePath → Map<localName, ImportBinding>
  const allImports = db.prepare(
    'SELECT file_path, local_name, source_module, imported_name, import_kind FROM imports WHERE project = ?'
  ).all(project) as Array<{
    file_path: string;
    local_name: string;
    source_module: string;
    imported_name: string;
    import_kind: string;
  }>;
  const importsByFile = new Map<string, Map<string, { importedName: string; sourceModule: string; importKind: string }>>();
  for (const imp of allImports) {
    let fileMap = importsByFile.get(imp.file_path);
    if (!fileMap) {
      fileMap = new Map();
      importsByFile.set(imp.file_path, fileMap);
    }
    fileMap.set(imp.local_name, {
      importedName: imp.imported_name,
      sourceModule: imp.source_module,
      importKind: imp.import_kind,
    });
  }

  // R111: Build a map of filePath → default export QN.
  // Stored as marker rows in imports with local_name='__default_export__'
  // and imported_name = the QN of the default export target.
  const defaultExportByFile = new Map<string, string>();
  for (const imp of allImports) {
    if (imp.import_kind === 'default_export' && imp.local_name === '__default_export__') {
      defaultExportByFile.set(imp.file_path, imp.imported_name);
    }
  }

  // R119/R123: Build exportsByFile with separate named and star exports.
  // R123 fix: star exports (export *) are stored in an array, not a Map,
  // because multiple export * from different files would collide under the
  // same key '*' in a Map. Named exports stay in the Map for O(1) lookup.
  const allExports = db.prepare(
    'SELECT file_path, exported_name, local_name, source_module, imported_name, export_kind FROM exports WHERE project = ?'
  ).all(project) as Array<{
    file_path: string; exported_name: string; local_name: string | null;
    source_module: string | null; imported_name: string | null; export_kind: string;
  }>;
  interface FileExports {
    named: Map<string, { localName: string | null; sourceModule: string | null; importedName: string | null; exportKind: string }>;
    stars: Array<{ sourceModule: string }>;
  }
  const exportsByFile = new Map<string, FileExports>();
  for (const exp of allExports) {
    let fileExp = exportsByFile.get(exp.file_path);
    if (!fileExp) {
      fileExp = { named: new Map(), stars: [] };
      exportsByFile.set(exp.file_path, fileExp);
    }
    if (exp.export_kind === 'star_re_export') {
      // R123: star exports go in the array, not the Map
      if (exp.source_module) {
        fileExp.stars.push({ sourceModule: exp.source_module });
      }
    } else {
      fileExp.named.set(exp.exported_name, {
        localName: exp.local_name, sourceModule: exp.source_module,
        importedName: exp.imported_name, exportKind: exp.export_kind,
      });
    }
  }

  // R124: Resolution result type — distinguishes resolved/missing/ambiguous/unknown
  // R126: `unknown` now carries a structured reason so callers and diagnostics
  // can distinguish "no export tracking" from "unresolved star source" from
  // "depth limit hit". The reason is informational and does NOT change the
  // terminal semantics: any `unknown` is terminal when the project's extractor
  // semantics version is current (no name-based fallback).
  type UnknownReason =
    | 'legacy_export_tracking'    // file has no row in exports table (pre-R119 DB or never indexed)
    | 'unresolved_reexport_module' // `export * from './missing'` — source module not found
    | 'depth_limit'                // barrel chain exceeded the depth cap (10)
    | 'untracked_export_form';     // export form not yet supported (e.g. `export * as ns`)
  type ResolutionResult =
    | { kind: 'resolved'; qn: string }
    | { kind: 'missing' }
    | { kind: 'ambiguous' }
    | { kind: 'unknown'; reason: UnknownReason };

  // R124: Resolve an exported name to a target QN, following re-exports.
  // Returns a structured result so callers can distinguish:
  // - resolved: exactly one target found
  // - missing: no export binding and no symbol found (file IS tracked)
  // - ambiguous: multiple distinct targets (ESM SyntaxError)
  // - unknown: no export tracking for this file, OR an unresolved re-export
  //   source, OR depth limit hit. R126: `unknown` is TERMINAL for modern DBs
  //   (extractor_semantics_version current) — the caller must NOT fall back
  //   to name-based resolution, because we cannot trust that the symbol is
  //   not exported through a path we couldn't follow.
  function resolveExportedSymbol(filePath: string, exportedName: string, depth: number, visited: Set<string>): ResolutionResult {
    if (depth > 10) return { kind: 'unknown', reason: 'depth_limit' }; // R126: was `missing` — depth limit is an unknown, not a definitive "not exported"
    const key = `${filePath}::${exportedName}`;
    if (visited.has(key)) return { kind: 'missing' }; // cycle — treat as missing (definitive: we'd just loop)
    visited.add(key);

    const fileExp = exportsByFile.get(filePath);
    if (!fileExp) {
      // R124/R126: No exports tracked — return unknown (not missing).
      // This means we don't know if the symbol is exported or not.
      // R126: for modern DBs, the caller treats this as terminal and does
      // NOT fall back to fileSyms for private symbols. For legacy DBs
      // (extractor_semantics_version=0), the caller may still fall back.
      return { kind: 'unknown', reason: 'legacy_export_tracking' };
    }

    // R123: Check named exports first (explicit exports win over star)
    const expBinding = fileExp.named.get(exportedName);
    if (expBinding) {
      if (expBinding.exportKind === 'local_named' || expBinding.exportKind === 'local_alias') {
        const fileSyms = fileSymbolIndex.get(filePath);
        const qn = fileSyms?.get(expBinding.localName || exportedName);
        return qn ? { kind: 'resolved', qn } : { kind: 'missing' };
      }
      if (expBinding.exportKind === 're_export_named' || expBinding.exportKind === 're_export_alias') {
        if (!expBinding.sourceModule) return { kind: 'missing' };
        const resolvedFile = resolveModulePath(expBinding.sourceModule, filePath, knownFiles);
        if (!resolvedFile) {
          // R126: re-export source module unresolved. ESM would throw
          // ERR_MODULE_NOT_FOUND at runtime. Treat as unknown (terminal for
          // modern DBs) rather than missing, because the symbol MAY exist
          // in the unresolved module — we just can't verify.
          return { kind: 'unknown', reason: 'unresolved_reexport_module' };
        }
        return resolveExportedSymbol(resolvedFile, expBinding.importedName || exportedName, depth + 1, new Set(visited));
      }
    }

    // R123/R124: No named export found — check ALL star re-exports
    // R124: Use a per-branch visited set (copy) to avoid order-dependent results
    // R126: Propagate `unknown` from any star branch — a single unknown branch
    //   means we cannot trust the resolved target from another branch (the
    //   unknown branch might also export the same name, making the result
    //   ambiguous). This prevents false-positive "exact" edges when a star
    //   source is missing or a legacy DB has incomplete export tracking.
    const starTargets = new Set<string>();
    let hasAmbiguous = false;
    let hasUnknown = false;
    for (const starExp of fileExp.stars) {
      const starResolvedFile = resolveModulePath(starExp.sourceModule, filePath, knownFiles);
      if (!starResolvedFile) {
        // R126: IDX-R126-01 — star source unresolved. Don't silently ignore;
        // mark this branch as unknown so the parent can't claim an exact
        // target from a different branch.
        hasUnknown = true;
        continue;
      }
      const result = resolveExportedSymbol(starResolvedFile, exportedName, depth + 1, new Set(visited));
      if (result.kind === 'resolved') {
        starTargets.add(result.qn);
      } else if (result.kind === 'ambiguous') {
        // R124: Propagate ambiguous — don't treat as missing
        hasAmbiguous = true;
      } else if (result.kind === 'unknown') {
        // R126: IDX-R126-02 — propagate unknown. Previously this was silently
        // ignored, which let another branch's resolved target become a false
        // "exact" edge even when the unknown branch could have produced a
        // different target or an ambiguity.
        hasUnknown = true;
      }
      // 'missing' doesn't add targets and is NOT propagated (a star branch
      // that definitively doesn't export the name is fine).
    }

    // R126: precedence — ambiguous > unknown > resolved-count.
    //   - If any branch is ambiguous, the overall result is ambiguous (ESM
    //     would throw SyntaxError).
    //   - Else if any branch is unknown, the overall result is unknown (we
    //     cannot trust the resolved count from other branches).
    //   - Else the result is determined by the number of distinct resolved
    //     targets (0=missing, 1=resolved, >1=ambiguous).
    if (hasAmbiguous) {
      return { kind: 'ambiguous' };
    }
    if (hasUnknown && starTargets.size === 0) {
      // All branches were unknown or missing — unknown wins over missing.
      return { kind: 'unknown', reason: 'unresolved_reexport_module' };
    }
    if (hasUnknown && starTargets.size > 0) {
      // At least one resolved + at least one unknown — we cannot trust the
      // resolved target to be the unique answer.
      return { kind: 'unknown', reason: 'unresolved_reexport_module' };
    }
    if (starTargets.size === 1) {
      return { kind: 'resolved', qn: starTargets.values().next().value! };
    }
    if (starTargets.size > 1) {
      return { kind: 'ambiguous' };
    }

    // R124: No export binding found, no star targets, no unknown/ambiguous.
    // Return 'missing' (not 'unknown') because we DO have export tracking
    // for this file — the symbol is just not exported.
    return { kind: 'missing' };
  }

  // R126: `semanticsCurrent` is now a parameter (see function doc). When true,
  // `unknown` and unresolved source modules are TERMINAL — the caller must NOT
  // fall back to name-based resolution, because the file_hashes are valid for
  // the current extractor and we can trust that "no export tracking" really
  // means "no export". When false (legacy / pre-R126 DB or incremental with
  // stale version), we preserve the pre-R126 behavior and fall back, so we
  // don't introduce false negatives on DBs that haven't been fully reindexed.
  //
  // NOTE: callers MUST pass the correct value. The resolver does NOT read
  // extractor_semantics_version from the DB itself, because in full mode the
  // projects row may not have been updated yet (updateProjectStats runs AFTER
  // the extraction transaction). The caller knows the correct value:
  //   - full reindex → true (the extractor just produced fresh data)
  //   - incremental → true iff stored version == CURRENT

  // 4. Resolve each call_site to candidates and insert CALLS edges.
  //    R110: import-aware resolution — try imports first, then name-based fallback.
  //    R111: default imports now use the default export marker for correct resolution.
  //    R126: when semanticsCurrent, an explicit import whose source module is
  //    unresolved, OR whose exported symbol resolves to `unknown`/`missing`/
  //    `ambiguous`, is TERMINAL — no name-based fallback.
  const insertEdge = db.prepare(
    `INSERT INTO edges (project, source_id, target_id, type, properties_json)
     VALUES (?, ?, ?, ?, ?)`
  );

  let edgesInserted = 0;
  for (const cs of allCallSites) {
    const callKind = cs.call_kind as 'identifier_call' | 'member_call' | 'computed_call';

    // R115: Namespace import resolution for member calls.
    // For `import * as ns from './api'; ns.foo()`, the callee is 'ns.foo'
    // and call_kind is 'member_call'. We check if 'ns' (the first segment
    // before the dot) is a namespace import in the file's imports. If yes,
    // resolve the source module and look up 'foo' (last segment) in that file.
    if (callKind === 'member_call') {
      const fileImports = importsByFile.get(cs.file_path);
      if (fileImports) {
        // Extract the object name (first segment before the first dot)
        const dotIndex = cs.callee.indexOf('.');
        if (dotIndex > 0) {
          const objectName = cs.callee.substring(0, dotIndex);
          const nsBinding = fileImports.get(objectName);
          if (nsBinding && nsBinding.importKind === 'namespace') {
            // R126: IDX-R125-02 — if the namespace import's source module is
            // unresolved, the call-site is TERMINAL when semanticsCurrent.
            // ESM would throw ERR_MODULE_NOT_FOUND; we must not publish a
            // false-positive edge via name-based fallback.
            const resolvedFile = resolveModulePath(nsBinding.sourceModule, cs.file_path, knownFiles);
            if (!resolvedFile) {
              if (semanticsCurrent) continue;
              // legacy DB: fall through to name-based fallback below
            } else {
              const fileSyms = fileSymbolIndex.get(resolvedFile);
              if (fileSyms) {
                // Look up the last segment (method name) in the source file
                const nsResult = resolveExportedSymbol(resolvedFile, cs.last_segment, 0, new Set());
                const targetQn = nsResult.kind === 'resolved' ? nsResult.qn : undefined;
                if (nsResult.kind === 'ambiguous' || nsResult.kind === 'missing') {
                  // R124: namespace call to ambiguous/missing export — no edge
                  continue;
                }
                if (nsResult.kind === 'unknown') {
                  // R126: namespace call to unknown export. Terminal when
                  // semanticsCurrent (don't fall back to name-based); fall
                  // through for legacy DBs.
                  if (semanticsCurrent) continue;
                }
                if (targetQn && targetQn !== cs.source_qn) {
                  const sourceId = qnToId.get(cs.source_qn);
                  const targetId = qnToId.get(targetQn);
                  if (sourceId && targetId) {
                    insertEdge.run(
                      project,
                      sourceId,
                      targetId,
                      'CALLS',
                      JSON.stringify({
                        callee: cs.callee,
                        inferred: true,
                        resolution: 'cross_file_namespace_exact',
                        confidence: 1.0,
                        candidate_count: 1,
                        candidate_index: 0,
                        call_kind: callKind,
                        import_kind: 'namespace',
                        source_module: nsBinding.sourceModule,
                      }),
                    );
                    edgesInserted++;
                    // Namespace resolved — skip name-based fallback
                    continue;
                  }
                }
              }
            }
          }
        }
      }
    }

    // R110: Try import-aware resolution first (only for identifier calls).
    // Member calls (obj.method) and computed calls (obj[key]) don't have a
    // simple import binding for the callee expression, so skip import-aware
    // resolution for them.
    // R115: exception — namespace imports are handled above for member calls.
    if (callKind === 'identifier_call') {
      const fileImports = importsByFile.get(cs.file_path);
      if (fileImports) {
        const impBinding = fileImports.get(cs.callee) || fileImports.get(cs.last_segment);
        if (impBinding) {
          // R126: IDX-R125-02 — if the import's source module is unresolved,
          // the call-site is TERMINAL when semanticsCurrent. ESM would throw
          // ERR_MODULE_NOT_FOUND; we must not publish a false-positive edge
          // via name-based fallback. For legacy DBs, fall through.
          const resolvedFile = resolveModulePath(impBinding.sourceModule, cs.file_path, knownFiles);
          if (!resolvedFile) {
            if (semanticsCurrent) continue;
            // legacy DB: fall through to name-based fallback below
          } else {
            const fileSyms = fileSymbolIndex.get(resolvedFile);
            if (fileSyms) {
              // For named/alias imports, look up the imported name
              // For default imports, look up 'default' (but TS default exports
              // are usually the function name, so try the local name first)
              // For namespace imports, skip (would need member access tracking)
              let targetQn: string | undefined;
              let resolution = '';
              let confidence = 0;

              if (impBinding.importKind === 'namespace') {
                // Namespace import: ns.foo() — the callee would be 'ns.foo',
                // not 'ns', so we wouldn't reach here for a pure namespace import.
                // Skip import-aware resolution for namespace bindings.
                // (resolution stays '', confidence stays 0)
              } else if (impBinding.importKind === 'default') {
                // R111: Default import: import foo from './b'
                // The local name (foo) may differ from the exported name (realName).
                // Use the default export marker to find the correct QN.
                const defaultQn = defaultExportByFile.get(resolvedFile);
                if (defaultQn) {
                  targetQn = defaultQn;
                  resolution = 'cross_file_import_exact';
                  confidence = 1.0;
                } else {
                  // Fallback: try the local name (old R110 behavior — works when
                  // the default export name matches the local import name)
                  const defaultResult = resolveExportedSymbol(resolvedFile, cs.callee, 0, new Set());
                  if (defaultResult.kind === 'resolved') {
                    targetQn = defaultResult.qn;
                    resolution = 'cross_file_import_exact';
                    confidence = 1.0;
                  } else if (defaultResult.kind === 'ambiguous' || defaultResult.kind === 'missing') {
                    continue; // R124: no fallback for invalid explicit import
                  } else if (defaultResult.kind === 'unknown') {
                    // R126: IDX-R125-01 — terminal when semanticsCurrent.
                    if (semanticsCurrent) continue;
                    // legacy DB: fall through to name-based fallback
                  }
                }
              } else {
                // Named or alias import: import { foo } or import { foo as bar }
                // Look up the imported name (original name in source module)
                const namedResult = resolveExportedSymbol(resolvedFile, impBinding.importedName, 0, new Set());
                if (namedResult.kind === 'resolved') {
                  targetQn = namedResult.qn;
                  resolution = impBinding.importKind === 'alias'
                    ? 'cross_file_import_alias'
                    : 'cross_file_import_exact';
                  confidence = 1.0;
                } else if (namedResult.kind === 'ambiguous' || namedResult.kind === 'missing') {
                  // R124: Import is explicit but export is ambiguous/missing.
                  // Do NOT fall back to name-based resolution — the import is invalid.
                  // Skip this call_site entirely.
                  continue;
                } else if (namedResult.kind === 'unknown') {
                  // R126: IDX-R125-01 — terminal when semanticsCurrent.
                  // The file has no export tracking (legacy_export_tracking),
                  // or a re-export source is unresolved (unresolved_reexport_module),
                  // or the depth cap was hit (depth_limit). In all cases, we
                  // cannot trust name-based fallback for modern DBs.
                  if (semanticsCurrent) continue;
                  // legacy DB: fall through to name-based fallback
                }
              }

              if (targetQn && resolution) {
                // Skip self-calls
                if (targetQn === cs.source_qn) continue;
                const sourceId = qnToId.get(cs.source_qn);
                const targetId = qnToId.get(targetQn);
                if (sourceId && targetId) {
                  insertEdge.run(
                    project,
                    sourceId,
                    targetId,
                    'CALLS',
                    JSON.stringify({
                      callee: cs.callee,
                      inferred: true,
                      resolution,
                      confidence: parseFloat(confidence.toFixed(2)),
                      candidate_count: 1,
                      candidate_index: 0,
                      call_kind: callKind,
                      import_kind: impBinding.importKind,
                      source_module: impBinding.sourceModule,
                    }),
                  );
                  edgesInserted++;
                  // Import resolved — skip name-based fallback
                  continue;
                }
              }
            }
          }
        }
      }
    }

    // R116: Builtin filter for member calls NOT resolved via namespace.
    if (callKind === 'member_call') {
      const seg = cs.last_segment.toLowerCase();
      if (BUILTIN_METHOD_NAMES_SET.has(seg)) continue;
    }

    // R110: Name-based fallback (only if import-aware resolution didn't match)
    // R126: this branch is reached for legacy DBs (semantics not current) or
    // for call-sites with no import binding. When semanticsCurrent, an
    // explicit import that didn't match has already `continue`d above, so
    // name-based fallback here is safe — it only fires for call-sites with
    // no import binding at all (genuine global symbol lookup).
    // Try exact callee name first, then last segment (e.g. for obj.method)
    const candidates =
      globalSymbolIndex.get(cs.callee) ||
      globalSymbolIndex.get(cs.last_segment);
    if (!candidates || candidates.length === 0) continue;

    // R98: cap at 5 candidates to avoid edge explosion
    const capped = candidates.slice(0, 5);
    const confidence = capped.length === 1 ? 1.0 : 1.0 / capped.length;
    // R99: member calls get lower confidence — name match is less reliable
    const adjustedConfidence =
      callKind === 'member_call' ? Math.min(confidence, 0.3) : confidence;

    for (let ci = 0; ci < capped.length; ci++) {
      // Skip self-calls
      if (capped[ci] === cs.source_qn) continue;
      const sourceId = qnToId.get(cs.source_qn);
      const targetId = qnToId.get(capped[ci]);
      if (!sourceId || !targetId) continue;

      // R110: distinguish name-based exact from name-based fallback
      // If there was no import for this callee, it's a name_fallback.
      // If there was an import but it didn't resolve, it's also name_fallback.
      const resolution = capped.length === 1
        ? 'cross_file_name_fallback'
        : 'cross_file_ambiguous';
      insertEdge.run(
        project,
        sourceId,
        targetId,
        'CALLS',
        JSON.stringify({
          callee: cs.callee,
          inferred: true,
          resolution,
          confidence: parseFloat(adjustedConfidence.toFixed(2)),
          candidate_count: capped.length,
          candidate_index: ci,
          call_kind: callKind,
        }),
      );
      edgesInserted++;
    }
  }

  return edgesInserted;
}

/**
 * R120: Check whether the exports table is populated for a project.
 *
 * R121: This helper is currently UNUSED — the hasExports gate was removed in R120
 * because it was too aggressive (most files use `export function foo()` which
 * doesn't create export bindings, so the exports table can be legitimately empty
 * even on a fully initialized R119+ DB). The resolver's resolveExportedSymbol()
 * falls back to fileSyms.get() when no export binding exists, which is sufficient.
 *
 * Kept for potential future use (e.g., upgrade detection, diagnostics, or
 * re-enabling a smarter legacy gate that checks for export-containing files
 * rather than just any exports row).
 */
export function hasExports(db: Database.Database, project: string): boolean {
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM exports WHERE project = ?'
  ).get(project) as { c: number };
  return row.c > 0;
}

/**
 * R106: Check whether the persistent call_sites table is populated for a project.
 *
 * Used by the incremental path to decide whether cross-file CALLS can be
 * rebuilt (returns true) or whether the project needs a full reindex first
 * (returns false — legacy DB or first run after R106 migration).
 *
 * Returns true iff there is at least one call_site row for the project.
 *
 * R107: this function alone is NOT sufficient to detect legacy DBs, because a
 * valid R106 DB can have 0 call-sites (project with no unresolved cross-file
 * calls). Use isCallSitesInitialized() for the legacy DB detection instead.
 */
export function hasCallSites(db: Database.Database, project: string): boolean {
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM call_sites WHERE project = ?'
  ).get(project) as { c: number };
  return row.c > 0;
}

/**
 * R107: Check whether the project has been initialized by a full R106+ reindex.
 *
 * This is the authoritative signal for "is this DB legacy (pre-R106)?".
 * - Returns true: a full R106+ reindex has run → call_sites is authoritative
 *   (even if it's empty because the project has 0 unresolved cross-file calls).
 * - Returns false: legacy pre-R106 DB, or brand-new project that hasn't been
 *   fully indexed yet → incremental should mark stale=true to force full reindex.
 *
 * This replaces the R106 heuristic of using hasCallSites()===false as the
 * legacy signal, which was ambiguous (R108 P2 bug).
 */
export function isCallSitesInitialized(db: Database.Database, project: string): boolean {
  const row = db.prepare(
    'SELECT call_sites_initialized FROM projects WHERE name = ?'
  ).get(project) as { call_sites_initialized?: number } | undefined;
  return row?.call_sites_initialized === 1;
}

/**
 * R126: Read the project's stored extractor_semantics_version.
 *
 * Returns 0 for legacy / pre-R126 DBs (the column's default), or the integer
 * version written by the last successful full reindex. Callers compare this
 * to CURRENT_EXTRACTOR_SEMANTICS_VERSION to decide whether the file_hashes
 * can be trusted for the current extractor's semantics.
 */
export function getExtractorSemanticsVersion(db: Database.Database, project: string): number {
  const row = db.prepare(
    'SELECT extractor_semantics_version AS v FROM projects WHERE name = ?'
  ).get(project) as { v?: number } | undefined;
  return row?.v ?? 0;
}

/**
 * R126: Convenience wrapper — returns true iff the project's stored
 * extractor_semantics_version matches CURRENT_EXTRACTOR_SEMANTICS_VERSION.
 *
 * When this returns true, `unknown` / unresolved-source / missing-export
 * states are TERMINAL (no name-based fallback). When false (legacy or stale
 * DB), the resolver preserves the pre-R126 behavior to avoid false negatives
 * on DBs that haven't been fully reindexed yet.
 */
export function isExtractorSemanticsCurrent(db: Database.Database, project: string): boolean {
  return getExtractorSemanticsVersion(db, project) === CURRENT_EXTRACTOR_SEMANTICS_VERSION;
}
