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
import { Parser, Language } from 'web-tree-sitter';
import { readFileSync } from 'node:fs';
import { relative, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { extractFast } from './fast-walker.js';

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

        // R72: use fast-walker (descendantsOfType) instead of recursive walkAST
        const extracted = extractFast(tree.rootNode, batch.project, relPath, fileQn, source.length);

        results.push({
          filePath: relPath,
          language: batch.language,
          nodes: extracted.nodes,
          edges: extracted.edges,
          error: null,
        });
        tree.delete();
      } catch (e: unknown) {
        results.push({
          filePath: relPath, language: batch.language, nodes: [], edges: [],
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e: unknown) {
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
