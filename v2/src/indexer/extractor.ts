// v2/src/indexer/extractor.ts
// R68: TypeScript/JavaScript code extractor using ts-morph.
//
// ⚠️ DEPRECATED (R69): Replaced by wasm-extractor.ts (WASM tree-sitter, 112 languages).
// This file is kept for historical reference only. It is NOT imported by any
// module. Its SKIP_DIRS does not match V1's FAST_SKIP_DIRS and would cause
// unfair file-count comparisons if used.
//
// To remove: delete this file and its test (if any). Safe to remove — no imports.
//
// Extracts nodes (Function, Method, Class, Module, File) and edges
// (CALLS, IMPORTS, CONTAINS) from .ts/.tsx/.js files. Writes to a
// SQLite DB compatible with V1's schema.
//
// This gives V2 partial autonomy: it can index TS/JS projects without
// the `cbm` binary. For other languages (Python, Go, Rust, etc.), V2
// still needs V1.

import { Project, SyntaxKind, type Node, type FunctionDeclaration, type MethodDeclaration, type CallExpression } from 'ts-morph';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { relative, extname, basename, dirname, join } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────

export interface ExtractionResult {
  nodes: number;
  edges: number;
  files: number;
  skipped: number;
  errors: Array<{ file: string; error: string }>;
}



// ── File discovery ─────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.cache', 'coverage',
  '.next', '.nuxt', '.output', '.turbo', '.vite', '__pycache__',
]);

/**
 * Walk a directory and return all supported source files.
 * Skips node_modules, dist, .git, etc.
 */
export function discoverSourceFiles(rootPath: string): string[] {
  const results: string[] = [];
  const stack: string[] = [rootPath];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSyncSafe(dir);
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
        } else if (SUPPORTED_EXTENSIONS.has(extname(entry))) {
          results.push(fullPath);
        }
      } catch {
        // skip inaccessible entries
      }
    }
  }

  return results.sort();
}

function readdirSyncSafe(dir: string): string[] {
  return readdirSync(dir);
}

// ── Extraction ─────────────────────────────────────────────────────────

/**
 * Extract nodes and edges from a set of source files using ts-morph.
 *
 * Node labels: File, Module, Class, Function, Method, Variable
 * Edge types: CONTAINS (file→declaration), IMPORTS (file→file),
 *             CALLS (function→function), USES (any→variable)
 */
export function extractFromFiles(
  db: Database.Database,
  project: string,
  rootPath: string,
  files: string[],
  incremental: boolean = false,
): ExtractionResult {
  const result: ExtractionResult = { nodes: 0, edges: 0, files: 0, skipped: 0, errors: [] };

  if (files.length === 0) return result;

  // Create ts-morph project with the source files
  const tsProject = new Project({
    useInMemoryFileSystem: false,
    compilerOptions: {
      allowJs: true,
      jsx: 2, // React
      declaration: false,
      noEmit: true,
      skipLibCheck: true,
      moduleResolution: 99, // Bundler
      target: 99, // ESNext
    },
  });

  // Add files to the ts-morph project
  for (const file of files) {
    try {
      tsProject.addSourceFileAtPathIfExists(file);
    } catch (e: unknown) {
      result.errors.push({
        file: relative(rootPath, file),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Build a map of qualified names → node IDs for edge resolution
  const qnToId = new Map<string, number>();
  const nameToQns = new Map<string, string[]>(); // name → [qualifiedName, ...]
  const fileToId = new Map<string, number>();

  // Prepared statements (hot-path optimization — same pattern as R58)
  const insertNode = db.prepare(`
    INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line, properties_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEdge = db.prepare(`
    INSERT INTO edges (project, source_id, target_id, type, properties_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  const upsertFileHash = db.prepare(`
    INSERT INTO file_hashes (project, file_path, content_hash, mtime, indexed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project, file_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      mtime = excluded.mtime,
      indexed_at = excluded.indexed_at
  `);

  let nextNodeId = 1;
  let nextEdgeId = 1;

  const tx = db.transaction(() => {
    for (const sourceFile of tsProject.getSourceFiles()) {
      const absPath = sourceFile.getFilePath();
      const relPath = relative(rootPath, absPath);

      try {
        // Check incremental: skip if file hasn't changed
        if (incremental) {
          const stat = statSync(absPath);
          const content = readFileSync(absPath, 'utf-8');
          const hash = createHash('sha256').update(content).digest('hex');
          const existing = db.prepare(
            'SELECT content_hash FROM file_hashes WHERE project = ? AND file_path = ?'
          ).get(project, relPath) as { content_hash: string } | undefined;

          if (existing && existing.content_hash === hash) {
            result.skipped++;
            continue;
          }
          upsertFileHash.run(project, relPath, hash, Math.floor(stat.mtimeMs), new Date().toISOString());
        }

        // ── Create File node ──────────────────────────────────────────
        const fileQn = `${project}::${relPath}`;
        const fileNodeId = nextNodeId++;
        insertNode.run(
          project, 'File', basename(relPath), fileQn, relPath,
          1, sourceFile.getEndLineNumber(),
          JSON.stringify({ language: extname(relPath).slice(1), size: sourceFile.getFullText().length })
        );
        fileToId.set(absPath, fileNodeId);
        qnToId.set(fileQn, fileNodeId);
        addToNameMap(nameToQns, basename(relPath), fileQn);
        result.nodes++;

        // ── Extract imports ────────────────────────────────────────────
        const importDecls = sourceFile.getImportDeclarations();
        for (const imp of importDecls) {
          const moduleSpecifier = imp.getModuleSpecifierValue();
          const resolvedPath = resolveImportPath(moduleSpecifier, absPath, rootPath);
          if (resolvedPath) {
            // Edge: File IMPORTS File (resolved later if target exists)
            const targetQn = `${project}::${relative(rootPath, resolvedPath)}`;
            const sourceId = fileNodeId;
            const targetId = qnToId.get(targetQn);
            if (targetId) {
              insertEdge.run(project, sourceId, targetId, 'IMPORTS',
                JSON.stringify({ specifier: moduleSpecifier }));
              nextEdgeId++;
              result.edges++;
            }
          }
        }

        // ── Extract classes ────────────────────────────────────────────
        const classes = sourceFile.getClasses();
        for (const cls of classes) {
          const name = cls.getName() || 'AnonymousClass';
          const qn = `${fileQn}::${name}`;
          const nodeId = nextNodeId++;
          const start = cls.getStartLineNumber();
          const end = cls.getEndLineNumber();
          const methods = cls.getInstanceMethods();
          const properties = cls.getInstanceProperties();

          insertNode.run(
            project, 'Class', name, qn, relPath, start, end,
            JSON.stringify({
              method_count: methods.length,
              property_count: properties.length,
              is_exported: cls.isExported(),
              is_default_export: cls.isDefaultExport(),
            })
          );
          qnToId.set(qn, nodeId);
          addToNameMap(nameToQns, name, qn);

          // Edge: File CONTAINS Class
          insertEdge.run(project, fileNodeId, nodeId, 'CONTAINS', '{}');
          nextEdgeId++;
          result.nodes++;
          result.edges++;

          // ── Extract methods ────────────────────────────────────────────
          for (const method of methods) {
            const methodName = method.getName() || 'anonymous';
            const methodQn = `${qn}::${methodName}`;
            const methodNodeId = nextNodeId++;
            const mStart = method.getStartLineNumber();
            const mEnd = method.getEndLineNumber();

            insertNode.run(
              project, 'Method', methodName, methodQn, relPath, mStart, mEnd,
              JSON.stringify({
                is_static: method.isStatic(),
                is_async: method.isAsync(),
                is_exported: false,
                complexity: estimateComplexity(method),
              })
            );
            qnToId.set(methodQn, methodNodeId);
            addToNameMap(nameToQns, methodName, methodQn);

            // Edge: Class CONTAINS Method
            insertEdge.run(project, nodeId, methodNodeId, 'CONTAINS', '{}');
            nextEdgeId++;
            result.nodes++;
            result.edges++;

            // Extract calls from this method
            extractCalls(db, project, method, methodQn, qnToId, nameToQns, insertEdge, () => nextEdgeId++, (id) => { nextEdgeId = id; }, result);
          }
        }

        // ── Extract functions ──────────────────────────────────────────
        const functions = sourceFile.getFunctions();
        for (const func of functions) {
          const name = func.getName() || 'anonymous';
          const qn = `${fileQn}::${name}`;
          const nodeId = nextNodeId++;
          const start = func.getStartLineNumber();
          const end = func.getEndLineNumber();

          insertNode.run(
            project, 'Function', name, qn, relPath, start, end,
            JSON.stringify({
              is_async: func.isAsync(),
              is_exported: func.isExported(),
              is_default_export: func.isDefaultExport(),
              param_count: func.getParameters().length,
              complexity: estimateComplexity(func),
            })
          );
          qnToId.set(qn, nodeId);
          addToNameMap(nameToQns, name, qn);

          // Edge: File CONTAINS Function
          insertEdge.run(project, fileNodeId, nodeId, 'CONTAINS', '{}');
          nextEdgeId++;
          result.nodes++;
          result.edges++;

          // Extract calls from this function
          extractCalls(db, project, func, qn, qnToId, nameToQns, insertEdge, () => nextEdgeId++, (id) => { nextEdgeId = id; }, result);
        }

        // ── Extract exported variables ────────────────────────────────
        const exportedVars = sourceFile.getVariableDeclarations().filter(v => {
          const parent = v.getParent();
          if (parent && parent.getParent()) {
            const stmt = parent.getParent();
            return stmt.getKind() === SyntaxKind.VariableStatement &&
              (stmt as any).isExported?.();
          }
          return false;
        });

        for (const v of exportedVars) {
          const name = v.getName();
          const qn = `${fileQn}::${name}`;
          const nodeId = nextNodeId++;
          const start = v.getStartLineNumber();
          const end = v.getEndLineNumber();

          insertNode.run(
            project, 'Variable', name, qn, relPath, start, end,
            JSON.stringify({ is_exported: true, is_const: (v as { isConst?: () => boolean }).isConst?.() ?? false })
          );
          qnToId.set(qn, nodeId);
          addToNameMap(nameToQns, name, qn);

          insertEdge.run(project, fileNodeId, nodeId, 'CONTAINS', '{}');
          nextEdgeId++;
          result.nodes++;
          result.edges++;
        }

        result.files++;
      } catch (e: unknown) {
        result.errors.push({
          file: relPath,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // ── Second pass: resolve CALLS edges ──────────────────────────────
    // Now that all nodes are in the DB, we can resolve call targets
    // by looking up qualified names in qnToId / nameToQns.
    // (The extractCalls function already created edges during the first pass
    //  for targets it could resolve. Unresolved targets are skipped.)
  });
  tx();

  return result;
}

// ── Helpers ────────────────────────────────────────────────────────────

function addToNameMap(map: Map<string, string[]>, name: string, qn: string): void {
  const existing = map.get(name);
  if (existing) {
    existing.push(qn);
  } else {
    map.set(name, [qn]);
  }
}

/**
 * Extract CALLS edges from a function/method body.
 * Looks for CallExpression nodes and tries to resolve the callee name
 * to a known node via the name→QN map.
 */
function extractCalls(
  _db: Database.Database,
  project: string,
  funcNode: FunctionDeclaration | MethodDeclaration,
  sourceQn: string,
  qnToId: Map<string, number>,
  nameToQns: Map<string, string[]>,
  insertEdge: Database.Statement,
  getNextEdgeId: () => number,
  setNextEdgeId: (id: number) => void,
  result: ExtractionResult,
): void {
  const sourceId = qnToId.get(sourceQn);
  if (!sourceId) return;

  const callExpressions = funcNode.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of callExpressions) {
    const calleeName = getCalleeName(call);
    if (!calleeName) continue;

    // Try to resolve: exact QN match first, then name match
    const candidates = nameToQns.get(calleeName);
    if (!candidates || candidates.length === 0) continue;

    // Pick the first candidate (ambiguous calls get the first match)
    const targetQn = candidates[0];
    const targetId = qnToId.get(targetQn);
    if (!targetId || targetId === sourceId) continue; // skip self-calls

    insertEdge.run(project, sourceId, targetId, 'CALLS',
      JSON.stringify({ callee: calleeName, inferred: true }));
    const id = getNextEdgeId();
    setNextEdgeId(id);
    result.edges++;
  }
}

/**
 * Extract the callee name from a CallExpression.
 * Handles: directCall(), obj.method(), qualified.namespace.call()
 */
function getCalleeName(call: CallExpression): string | null {
  const expr = call.getExpression();
  const kind = expr.getKind();

  if (kind === SyntaxKind.Identifier) {
    return expr.getText();
  }

  if (kind === SyntaxKind.PropertyAccessExpression) {
    // For obj.method(), return just "method" — V1 also matches on last segment
    const name = expr.getText();
    const lastSegment = name.split('.').pop();
    return lastSegment || name;
  }

  return null;
}

/**
 * Estimate cyclomatic complexity by counting decision points.
 * Not as precise as V1's AST-based calculation, but good enough for ranking.
 */
function estimateComplexity(node: Node): number {
  let complexity = 1; // base
  const decisionKinds = [
    SyntaxKind.IfStatement,
    SyntaxKind.WhileStatement,
    SyntaxKind.DoStatement,
    SyntaxKind.ForStatement,
    SyntaxKind.ForInStatement,
    SyntaxKind.ForOfStatement,
    SyntaxKind.CaseClause,
    SyntaxKind.CatchClause,
    SyntaxKind.ConditionalExpression,
    SyntaxKind.BinaryExpression, // && and || operators
  ];

  for (const kind of decisionKinds) {
    const nodes = node.getDescendantsOfKind(kind);
    complexity += nodes.length;
  }

  // Binary expressions with && or || add complexity
  const binaryExprs = node.getDescendantsOfKind(SyntaxKind.BinaryExpression);
  for (const bin of binaryExprs) {
    const op = bin.getOperatorToken().getKind();
    if (op === SyntaxKind.AmpersandAmpersandToken || op === SyntaxKind.BarBarToken) {
      complexity++;
    }
  }

  return complexity;
}

/**
 * Resolve a module specifier (e.g. './utils', '../lib/helper') to a file path.
 * Tries .ts, .tsx, .js, .jsx, .mjs, .cjs extensions and index files.
 */
function resolveImportPath(specifier: string, fromFile: string, rootPath: string): string | null {
  // Only resolve relative imports (skip node_modules packages)
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return null;
  }

  const fromDir = dirname(fromFile);
  const basePath = specifier.startsWith('/')
    ? join(rootPath, specifier)
    : join(fromDir, specifier);

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

  // Try direct file
  for (const ext of extensions) {
    const candidate = basePath + ext;
    try {
      statSync(candidate);
      return candidate;
    } catch { /* not found */ }
  }

  // Try index file (directory import)
  for (const ext of extensions) {
    const candidate = join(basePath, 'index' + ext);
    try {
      statSync(candidate);
      return candidate;
    } catch { /* not found */ }
  }

  return null;
}
