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
//      - Look up candidates by callee name (or last segment if not found).
//      - Cap at 5 candidates. Compute confidence = 1/n (or 0.3 max for member calls).
//      - Skip self-calls (source QN == candidate QN).
//      - Insert a CALLS edge with properties_json containing resolution metadata.
//
// Performance:
//   - O(N) for nodes table scan (N = nodes in project)
//   - O(M) for call_sites scan (M = call_sites in project)
//   - O(1) per call_site for symbol lookup (Map)
//   - For a typical 10k-node project with 5k call_sites: ~50-100ms
//   - Acceptable for Phase 1. Future optimization: only re-resolve call_sites
//     from changed files + only delete cross-file edges touching changed files.

import type Database from 'better-sqlite3';
import type { UnresolvedCallSite, ImportBinding } from './fast-walker.js';

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

  // 4. Resolve each call_site to candidates and insert CALLS edges.
  //    R110: import-aware resolution — try imports first, then name-based fallback.
  //    R111: default imports now use the default export marker for correct resolution.
  const insertEdge = db.prepare(
    `INSERT INTO edges (project, source_id, target_id, type, properties_json)
     VALUES (?, ?, ?, ?, ?)`
  );

  let edgesInserted = 0;
  for (const cs of allCallSites) {
    const callKind = cs.call_kind as 'identifier_call' | 'member_call' | 'computed_call';

    // R110: Try import-aware resolution first (only for identifier calls).
    // Member calls (obj.method) and computed calls (obj[key]) don't have a
    // simple import binding for the callee expression, so skip import-aware
    // resolution for them.
    if (callKind === 'identifier_call') {
      const fileImports = importsByFile.get(cs.file_path);
      if (fileImports) {
        const impBinding = fileImports.get(cs.callee) || fileImports.get(cs.last_segment);
        if (impBinding) {
          // Resolve the source module to a file path
          const resolvedFile = resolveModulePath(impBinding.sourceModule, cs.file_path, knownFiles);
          if (resolvedFile) {
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
                  targetQn = fileSyms.get(cs.callee);
                  if (targetQn) {
                    resolution = 'cross_file_import_exact';
                    confidence = 1.0;
                  }
                }
              } else {
                // Named or alias import: import { foo } or import { foo as bar }
                // Look up the imported name (original name in source module)
                targetQn = fileSyms.get(impBinding.importedName);
                if (targetQn) {
                  resolution = impBinding.importKind === 'alias'
                    ? 'cross_file_import_alias'
                    : 'cross_file_import_exact';
                  confidence = 1.0;
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

    // R110: Name-based fallback (only if import-aware resolution didn't match)
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
