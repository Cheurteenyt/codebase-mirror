// v2/src/indexer/worker.ts
// R71: Worker thread for parallel WASM tree-sitter parsing.
//
// Each worker:
// 1. Receives a batch of files (same language for grammar cache efficiency)
// 2. Loads the WASM grammar (once per worker per language)
// 3. Parses each file and walks the AST
// 4. Returns extracted nodes + edges as a serializable message
//
// The main thread collects results from all workers and writes to SQLite
// in a single transaction (better-sqlite3 is synchronous, main-thread only).
//
// Architecture:
//   Main thread: discover → split by language → dispatch batches → collect → write SQLite
//   Worker thread: receive batch → parse → walk AST → return { nodes, edges }

import { parentPort, workerData } from 'node:worker_threads';
import { Parser, Language, type Node as TSNode } from 'web-tree-sitter';
import { readFileSync } from 'node:fs';
import { basename, relative, join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);

// ── Types (must be serializable — no functions, no class instances) ─────

export interface WorkerNode {
  label: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  properties: string; // JSON string
}

export interface WorkerEdge {
  sourceQn: string;
  targetQn: string;
  type: string;
  properties: string; // JSON string
}

export interface WorkerFileResult {
  filePath: string;
  language: string;
  nodes: WorkerNode[];
  edges: WorkerEdge[];
  error: string | null;
}

export interface WorkerBatchResult {
  results: WorkerFileResult[];
  language: string;
  durationMs: number;
}

export interface WorkerBatch {
  files: string[];
  language: string;
  rootPath: string;
  project: string;
}

// ── AST extraction (same logic as wasm-extractor.ts, but serialized) ────

const FUNCTION_TYPES = new Set([
  'function_declaration', 'function_definition', 'function',
  'arrow_function', 'generator_function_declaration', 'generator_function',
]);

const CLASS_TYPES = new Set([
  'class_declaration', 'class_definition', 'class',
  'interface_declaration', 'struct_specifier',
]);

const METHOD_TYPES = new Set([
  'method_definition', 'method_declaration', 'function_definition',
  'constructor_declaration', 'getter_definition', 'setter_definition',
]);

const CALL_TYPES = new Set([
  'call_expression', 'call',
]);

const DECISION_TYPES = new Set([
  'if_statement', 'if', 'while_statement', 'while', 'for_statement',
  'for', 'for_in_statement', 'for_each', 'case', 'catch_clause',
  'catch', 'conditional_expression', 'ternary',
]);

function getDeclName(node: TSNode): string {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'identifier') return child.text;
  }
  return `anonymous@${node.startPosition.row + 1}`;
}

function estimateComplexity(node: TSNode): number {
  let complexity = 1;
  function walk(n: TSNode): void {
    if (DECISION_TYPES.has(n.type)) complexity++;
    if (n.type === 'binary_expression' || n.type === 'boolean_operator_expression') {
      const op = n.child(1);
      if (op && (op.type === '&&' || op.type === '||' || op.type === 'and' || op.type === 'or')) {
        complexity++;
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child) walk(child);
    }
  }
  walk(node);
  return complexity;
}

/**
 * Walk a tree-sitter AST and collect nodes + edges as serializable objects.
 * Same logic as wasm-extractor.ts's walkAST, but returns arrays instead of
 * writing to SQLite directly (the main thread handles SQLite writes).
 */
function walkASTCollect(
  node: TSNode,
  project: string,
  relPath: string,
  fileQn: string,
  parentNodeId: string | null,
  parentQn: string,
  nodes: WorkerNode[],
  edges: WorkerEdge[],
  nameToQns: Map<string, string[]>,
): void {
  const nodeType = node.type;

  if (FUNCTION_TYPES.has(nodeType)) {
    const name = getDeclName(node);
    const qn = `${parentQn}::${name}`;
    nodes.push({
      label: 'Function', name, qualifiedName: qn, filePath: relPath,
      startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
      properties: JSON.stringify({ language: 'tree-sitter', complexity: estimateComplexity(node) }),
    });
    addToNameMap(nameToQns, name, qn);
    if (parentNodeId !== null) {
      edges.push({ sourceQn: parentNodeId, targetQn: qn, type: 'CONTAINS', properties: '{}' });
    } else {
      edges.push({ sourceQn: fileQn, targetQn: qn, type: 'CONTAINS', properties: '{}' });
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walkASTCollect(child, project, relPath, fileQn, qn, qn, nodes, edges, nameToQns);
    }
    return;
  }

  if (CLASS_TYPES.has(nodeType)) {
    const name = getDeclName(node);
    const qn = `${parentQn}::${name}`;
    nodes.push({
      label: 'Class', name, qualifiedName: qn, filePath: relPath,
      startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
      properties: JSON.stringify({ language: 'tree-sitter' }),
    });
    addToNameMap(nameToQns, name, qn);
    if (parentNodeId !== null) {
      edges.push({ sourceQn: parentNodeId, targetQn: qn, type: 'CONTAINS', properties: '{}' });
    } else {
      edges.push({ sourceQn: fileQn, targetQn: qn, type: 'CONTAINS', properties: '{}' });
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walkASTCollect(child, project, relPath, fileQn, qn, qn, nodes, edges, nameToQns);
    }
    return;
  }

  if (METHOD_TYPES.has(nodeType)) {
    const name = getDeclName(node);
    const qn = `${parentQn}::${name}`;
    nodes.push({
      label: 'Method', name, qualifiedName: qn, filePath: relPath,
      startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
      properties: JSON.stringify({ language: 'tree-sitter', complexity: estimateComplexity(node) }),
    });
    addToNameMap(nameToQns, name, qn);
    if (parentNodeId !== null) {
      edges.push({ sourceQn: parentNodeId, targetQn: qn, type: 'CONTAINS', properties: '{}' });
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walkASTCollect(child, project, relPath, fileQn, qn, qn, nodes, edges, nameToQns);
    }
    return;
  }

  if (CALL_TYPES.has(nodeType)) {
    const funcNode = node.childForFieldName('function');
    if (funcNode) {
      const calleeName = funcNode.text;
      const lastSegment = calleeName.split('.').pop() || '';
      const candidates = nameToQns.get(calleeName) || nameToQns.get(lastSegment);
      if (candidates && candidates.length > 0 && parentNodeId !== null) {
        edges.push({
          sourceQn: parentNodeId, targetQn: candidates[0],
          type: 'CALLS', properties: JSON.stringify({ callee: calleeName, inferred: true }),
        });
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkASTCollect(child, project, relPath, fileQn, parentNodeId, parentQn, nodes, edges, nameToQns);
  }
}

function addToNameMap(map: Map<string, string[]>, name: string, qn: string): void {
  const existing = map.get(name);
  if (existing) existing.push(qn);
  else map.set(name, [qn]);
}

// ── WASM grammar loading (per-worker) ──────────────────────────────────

let parser: Parser | null = null;
const languageCache = new Map<string, Language>();

function getWasmPath(lang: string): string {
  const pkgPath = require2.resolve('tree-sitter-wasm/manifest.json');
  const pkgDir = dirname(pkgPath);
  return join(pkgDir, 'out', lang, `tree-sitter-${lang}.wasm`);
}

async function getParserForLanguage(lang: string): Promise<Parser> {
  if (!parser) {
    await Parser.init();
    parser = new Parser();
  }
  if (!languageCache.has(lang)) {
    const wasmPath = getWasmPath(lang);
    const language = await Language.load(wasmPath);
    languageCache.set(lang, language);
  }
  parser.setLanguage(languageCache.get(lang)!);
  return parser;
}

// ── Worker entry point ─────────────────────────────────────────────────

async function processBatch(batch: WorkerBatch): Promise<WorkerBatchResult> {
  const start = Date.now();
  const results: WorkerFileResult[] = [];

  try {
    const p = await getParserForLanguage(batch.language);

    for (const filePath of batch.files) {
      const relPath = relative(batch.rootPath, filePath);
      try {
        const source = readFileSync(filePath, 'utf-8');
        const tree = p.parse(source);
        if (!tree) {
          results.push({ filePath: relPath, language: batch.language, nodes: [], edges: [], error: 'parse returned null' });
          continue;
        }

        const fileQn = `${batch.project}::${relPath}`;
        const nodes: WorkerNode[] = [];
        const edges: WorkerEdge[] = [];
        const nameToQns = new Map<string, string[]>();

        // File node
        nodes.push({
          label: 'File', name: basename(relPath), qualifiedName: fileQn, filePath: relPath,
          startLine: 1, endLine: source.split('\n').length,
          properties: JSON.stringify({ language: batch.language, size: source.length }),
        });
        addToNameMap(nameToQns, basename(relPath), fileQn);

        // Walk AST
        walkASTCollect(tree.rootNode, batch.project, relPath, fileQn, null, fileQn, nodes, edges, nameToQns);

        results.push({ filePath: relPath, language: batch.language, nodes, edges, error: null });
        tree.delete();
      } catch (e: unknown) {
        results.push({
          filePath: relPath, language: batch.language, nodes: [], edges: [],
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e: unknown) {
    // Grammar load failure — mark all files as errored
    const errMsg = e instanceof Error ? e.message : String(e);
    for (const filePath of batch.files) {
      results.push({
        filePath: relative(batch.rootPath, filePath), language: batch.language,
        nodes: [], edges: [], error: errMsg,
      });
    }
  }

  return { results, language: batch.language, durationMs: Date.now() - start };
}

// ── Worker message handling ────────────────────────────────────────────

if (parentPort && workerData) {
  const batch = workerData as WorkerBatch;
  processBatch(batch)
    .then((result) => {
      parentPort!.postMessage(result);
    })
    .catch((e: unknown) => {
      parentPort!.postMessage({
        results: [],
        language: batch.language,
        durationMs: 0,
        error: e instanceof Error ? e.message : String(e),
      } as WorkerBatchResult & { error: string });
    });
}
