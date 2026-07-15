// Codebase Memory V2 — Performance Benchmark Suite (R66)
//
// Measures real-world performance of the V2 sidecar:
// 1. SQLite query performance (store.ts + sqlite-ro.ts patterns)
// 2. SWR cache hit/miss performance
// 3. Bulk query performance (the R40 optimization)
// 4. JSON serialization (MCP response shape)
// 5. Human memory store operations
//
// Creates synthetic test data (1000 nodes, 5000 edges, 200 human notes)
// to simulate a medium-sized codebase. Runs each benchmark N times and
// reports mean + stddev + min + max + ops/sec.
//
// Usage: npx tsx scripts/benchmark.ts

import { HumanMemoryStore } from '../src/human/store.js';
import { SwrCache } from '../src/intelligence/swr-cache.js';
import { CodeGraphReader } from '../src/bridge/sqlite-ro.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Config ─────────────────────────────────────────────────────────────

const NUM_NODES = 1000;
const NUM_EDGES = 5000;
const NUM_HUMAN_NOTES = 200;
const ITERATIONS_HOT = 10000;  // for sub-ms operations
const ITERATIONS_MED = 1000;   // for 1-10ms operations
const ITERATIONS_BULK = 500;   // for 10-50ms operations

// ── Benchmark helpers ──────────────────────────────────────────────────

interface BenchResult {
  name: string;
  category: string;
  iterations: number;
  mean_ms: number;
  stddev_ms: number;
  min_ms: number;
  max_ms: number;
  ops_per_sec: number;
}

function bench(name: string, category: string, iterations: number, fn: () => void): BenchResult {
  // Warmup (10 iterations or all if fewer)
  const warmup = Math.min(10, iterations);
  for (let i = 0; i < warmup; i++) fn();

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    fn();
    const end = process.hrtime.bigint();
    times.push(Number(end - start) / 1e6);
  }

  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const variance = times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length;
  const stddev = Math.sqrt(variance);

  return {
    name,
    category,
    iterations,
    mean_ms: parseFloat(mean.toFixed(4)),
    stddev_ms: parseFloat(stddev.toFixed(4)),
    min_ms: parseFloat(Math.min(...times).toFixed(4)),
    max_ms: parseFloat(Math.max(...times).toFixed(4)),
    ops_per_sec: parseFloat((1000 / mean).toFixed(1)),
  };
}

// ── Test data generation ───────────────────────────────────────────────

function createCodeGraphDB(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536');

  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      label TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      properties_json TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      properties_json TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project);
    CREATE INDEX IF NOT EXISTS idx_nodes_qn ON nodes(project, qualified_name);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project);
  `);

  const labels = ['Function', 'Method', 'Class', 'Module', 'Route', 'File', 'Variable'];
  const edgeTypes = ['CALLS', 'USES', 'IMPORTS', 'CONTAINS', 'REFERENCES'];

  const insertNode = db.prepare(
    'INSERT INTO nodes (id, project, label, name, qualified_name, file_path, start_line, end_line, properties_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertEdge = db.prepare(
    'INSERT INTO edges (id, project, source_id, target_id, type, properties_json) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const tx = db.transaction(() => {
    for (let i = 1; i <= NUM_NODES; i++) {
      insertNode.run(
        i, 'bench-project', labels[i % labels.length], `func_${i}`,
        `bench-project::module_${i % 50}::func_${i}`,
        `src/module_${i % 50}/file_${i}.ts`,
        i * 10, i * 10 + 5,
        JSON.stringify({ complexity: i % 20, language: 'typescript' })
      );
    }
    for (let i = 1; i <= NUM_EDGES; i++) {
      insertEdge.run(
        i, 'bench-project', (i % NUM_NODES) + 1, ((i * 7) % NUM_NODES) + 1,
        edgeTypes[i % edgeTypes.length], JSON.stringify({ inferred: true })
      );
    }
  });
  tx();
  db.close();
}

function createHumanStore(): HumanMemoryStore {
  const store = new HumanMemoryStore(':memory:');
  for (let i = 1; i <= NUM_HUMAN_NOTES; i++) {
    store.createNode({
      project: 'bench-project',
      label: i % 3 === 0 ? 'ADR' : i % 5 === 0 ? 'BugNote' : 'ArchitectureNote',
      title: `Note ${i}`,
      body_markdown: `# Note ${i}\n\nTest note with [[${(i % 100) + 1}]] wikilink.`,
      source: 'human',
      status: 'active',
      tags: [`tag_${i % 10}`],
      cbm_node_ids: i <= 100 ? [i] : [],
    });
  }
  return store;
}

// ── Benchmark suite ────────────────────────────────────────────────────

function runBenchmarks(): BenchResult[] {
  const results: BenchResult[] = [];
  const tmpDir = mkdtempSync(join(tmpdir(), 'cbm-bench-'));
  const codeDbPath = join(tmpDir, 'bench.db');
  let humanStore: HumanMemoryStore | undefined;
  let codeDb: Database.Database | undefined;
  let codeReader: CodeGraphReader | undefined;

  try {
    createCodeGraphDB(codeDbPath);
    humanStore = createHumanStore();
    codeDb = new Database(codeDbPath, { readonly: true });
    codeReader = new CodeGraphReader(codeDbPath);
    codeDb.pragma('temp_store = MEMORY');
    codeDb.pragma('cache_size = -65536');

    // Prepared statements (simulating R58-R59 hot-path pattern)
    const stmtGetNodeById = codeDb.prepare('SELECT * FROM nodes WHERE id = ?');
    const stmtFindByQName = codeDb.prepare('SELECT * FROM nodes WHERE project = ? AND qualified_name = ?');
    const stmtCountNodes = codeDb.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?');
    const stmtCountAll = codeDb.prepare('SELECT (SELECT COUNT(*) FROM nodes WHERE project = ?) AS n, (SELECT COUNT(*) FROM edges WHERE project = ?) AS e');

    // ── 1. Human memory store (store.ts patterns) ────────────────────

    results.push(bench(
      'getNodeById (prepared, R58 hot-path)', 'Human Store', ITERATIONS_HOT,
      () => humanStore.getNodeById(Math.floor(Math.random() * NUM_HUMAN_NOTES) + 1)
    ));

    results.push(bench(
      'getNodeBySlug (prepared, R58 hot-path)', 'Human Store', ITERATIONS_HOT,
      () => humanStore.getNodeBySlug('bench-project', `note-${Math.floor(Math.random() * NUM_HUMAN_NOTES) + 1}`)
    ));

    results.push(bench(
      'listNodes (200 results, filter+sort+limit)', 'Human Store', ITERATIONS_MED,
      () => humanStore.listNodes('bench-project', { limit: 200 })
    ));

    results.push(bench(
      'listNodesByCbmNodeId (junction table JOIN)', 'Human Store', ITERATIONS_MED,
      () => humanStore.listNodesByCbmNodeId('bench-project', Math.floor(Math.random() * 100) + 1)
    ));

    results.push(bench(
      'countNodesByLabel (GROUP BY, single query)', 'Human Store', ITERATIONS_MED,
      () => humanStore.countNodesByLabel('bench-project')
    ));

    results.push(bench(
      'getBulkNotesByCbmNodeIds (50 cbm_ids, junction JOIN)', 'Human Store', ITERATIONS_BULK,
      () => {
        const ids = Array.from({ length: 50 }, (_, i) => i + 1);
        humanStore.getBulkNotesByCbmNodeIds('bench-project', ids, 5);
      }
    ));

    // ── 2. Code graph queries (sqlite-ro.ts patterns) ────────────────

    results.push(bench(
      'code: getNodeById (SELECT * WHERE id=?)', 'Code Graph', ITERATIONS_HOT,
      () => stmtGetNodeById.get(Math.floor(Math.random() * NUM_NODES) + 1)
    ));

    results.push(bench(
      'code: findByQualifiedName (2-col index)', 'Code Graph', ITERATIONS_HOT,
      () => stmtFindByQName.get('bench-project', `bench-project::module_${Math.floor(Math.random() * 50)}::func_${Math.floor(Math.random() * NUM_NODES) + 1}`)
    ));

    results.push(bench(
      'code: countNodes (COUNT(*))', 'Code Graph', ITERATIONS_MED,
      () => stmtCountNodes.get('bench-project')
    ));

    results.push(bench(
      'code: countAll (nodes+edges in 1 query)', 'Code Graph', ITERATIONS_MED,
      () => stmtCountAll.get('bench-project', 'bench-project')
    ));

    // ── 3. Bulk queries (R40 optimization) ───────────────────────────

    const chunk100 = Array.from({ length: 100 }, (_, i) => i + 1);
    const chunk500 = Array.from({ length: 500 }, (_, i) => i + 1);

    results.push(bench(
      'getBulkNodeDegrees (100 nodes, production reader)', 'Bulk Queries', ITERATIONS_BULK,
      () => codeReader.getBulkNodeDegrees(chunk100)
    ));

    results.push(bench(
      'getBulkNodeDegrees (500 nodes, production reader)', 'Bulk Queries', 200,
      () => codeReader.getBulkNodeDegrees(chunk500)
    ));

    results.push(bench(
      'getBulkEdges (100 nodes, production dedup)', 'Bulk Queries', ITERATIONS_BULK,
      () => codeReader.getBulkEdges(chunk100)
    ));

    // ── 4. SWR cache (swr-cache.ts) ──────────────────────────────────

    const swrCache = new SwrCache<string, { count: number }>({
      ttlMs: 30000, staleMs: 30000, maxEntries: 100,
    });
    for (let i = 0; i < 50; i++) swrCache.set(`key-${i}`, { count: i });

    results.push(bench(
      'SWR cache: fresh hit (target: 0ms)', 'SWR Cache', 50000,
      () => swrCache.get('key-0')
    ));

    results.push(bench(
      'SWR cache: miss (undefined)', 'SWR Cache', 50000,
      () => swrCache.get('nonexistent-key')
    ));

    results.push(bench(
      'SWR cache: set + evict', 'SWR Cache', ITERATIONS_HOT,
      () => swrCache.set(`new-key-${Math.random()}`, { count: 1 })
    ));

    // ── 5. JSON serialization (MCP response shape) ───────────────────

    const mockNodes = humanStore.listNodes('bench-project', { limit: 100 });
    const mockJson = JSON.stringify(mockNodes);

    results.push(bench(
      'JSON.stringify (100 HumanNode → response)', 'JSON', ITERATIONS_MED,
      () => JSON.stringify(mockNodes)
    ));

    results.push(bench(
      'JSON.parse (100 nodes from string)', 'JSON', ITERATIONS_MED,
      () => JSON.parse(mockJson)
    ));

    // ── 6. createNode (write path) ───────────────────────────────────

    let writeCounter = 0;
    results.push(bench(
      'createNode (INSERT + JSON serialize + sync_state)', 'Human Store', 500,
      () => {
        writeCounter++;
        humanStore.createNode({
          project: 'bench-project',
          label: 'ArchitectureNote',
          title: `Bench Write ${writeCounter}`,
          body_markdown: 'Test',
          source: 'human',
          status: 'active',
          tags: ['bench'],
        });
      }
    ));

  } finally {
    try { codeReader?.close(); } catch {}
    try { codeDb?.close(); } catch {}
    try { humanStore?.close(); } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  }

  return results;
}

// ── Main ───────────────────────────────────────────────────────────────

console.log('='.repeat(80));
console.log('  Codebase Memory V2 — Performance Benchmark Suite (R66)');
console.log('='.repeat(80));
console.log();
console.log(`  Test data: ${NUM_NODES} code nodes, ${NUM_EDGES} edges, ${NUM_HUMAN_NOTES} human notes`);
console.log(`  Runtime:   Node.js ${process.version}, V8 ${process.versions.v8}`);
console.log(`  Platform:  ${process.platform} ${process.arch}`);
console.log();

const results = runBenchmarks();

// Group by category
const categories = [...new Set(results.map(r => r.category))];

for (const cat of categories) {
  const catResults = results.filter(r => r.category === cat);
  console.log(`┌─ ${cat} ${'─'.repeat(Math.max(0, 76 - cat.length))}`);
  console.log(
    '│ ' +
    'Benchmark'.padEnd(50) +
    'Mean'.padStart(10) +
    '±StdDev'.padStart(10) +
    'Ops/s'.padStart(10)
  );
  console.log('│ ' + '─'.repeat(78));

  for (const r of catResults) {
    console.log(
      '│ ' +
      r.name.padEnd(50) +
      `${r.mean_ms}ms`.padStart(10) +
      `±${r.stddev_ms}`.padStart(10) +
      `${r.ops_per_sec}`.padStart(10)
    );
  }
  console.log('└' + '─'.repeat(79));
  console.log();
}

// Summary
const fastest = results.reduce((a, b) => a.mean_ms < b.mean_ms ? a : b);
const slowest = results.reduce((a, b) => a.mean_ms > b.mean_ms ? a : b);
console.log('─'.repeat(80));
console.log('  Summary:');
console.log(`  Fastest: ${fastest.name} — ${fastest.mean_ms}ms (${fastest.ops_per_sec} ops/sec)`);
console.log(`  Slowest: ${slowest.name} — ${slowest.mean_ms}ms (${slowest.ops_per_sec} ops/sec)`);
console.log(`  Total benchmarks: ${results.length}`);
console.log();

// Performance assessment
console.log('  Performance assessment:');
const swrHit = results.find(r => r.name.includes('fresh hit'));
const getNode = results.find(r => r.name.includes('getNodeById (prepared'));
const bulkEdges = results.find(r => r.name.includes('getBulkEdges'));
const createNode = results.find(r => r.name.includes('createNode'));

if (swrHit) {
  console.log(`  • SWR cache fresh hit: ${swrHit.mean_ms}ms — ${swrHit.mean_ms < 0.01 ? '✓ excellent' : swrHit.mean_ms < 0.1 ? '✓ good' : '⚠ slow'}`);
}
if (getNode) {
  console.log(`  • getNodeById (hot-path): ${getNode.mean_ms}ms — ${getNode.mean_ms < 0.1 ? '✓ excellent' : getNode.mean_ms < 1 ? '✓ good' : '⚠ slow'}`);
}
if (bulkEdges) {
  console.log(`  • getBulkEdges (100 nodes): ${bulkEdges.mean_ms}ms — ${bulkEdges.mean_ms < 5 ? '✓ excellent' : bulkEdges.mean_ms < 20 ? '✓ good' : '⚠ slow'}`);
}
if (createNode) {
  console.log(`  • createNode (write path): ${createNode.mean_ms}ms — ${createNode.mean_ms < 1 ? '✓ excellent' : createNode.mean_ms < 5 ? '✓ good' : '⚠ slow'}`);
}
console.log('─'.repeat(80));
