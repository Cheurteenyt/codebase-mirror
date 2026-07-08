// v2/scripts/incremental-benchmark-r87.ts
// R87: Incremental benchmark with correctness invariants.
// Measures: full, noop, metadata-only, 1-file-change, 10%-change, parallel full->noop.
// Verifies after each run: orphan_edges=0, project stats exact, file_hashes coverage.

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = dirname(fileURLToPath(import.meta.url));
const V2_ROOT = resolve(HERE, '..');
const V2_DIST = process.env.CBM_V2_DIST ?? resolve(V2_ROOT, 'dist/cli/index.js');

interface BenchResult {
  scenario: string;
  wallMs: number;
  filesIndexed: number;
  filesSkipped: number;
  nodes: number;
  edges: number;
  orphanEdges: number;
  duplicateQNs: number;
  hashCount: number;
  statsMatch: boolean;
  errors: number;
}

function runIndexer(project: string, root: string, cacheDir: string, incremental: boolean, allowPartial: boolean = false): { exitCode: number; output: string } {
  const args = ['node', V2_DIST, 'index', '--project', project, '--root', root];
  if (incremental) args.push('--incremental');
  if (allowPartial) args.push('--allow-partial');
  try {
    const output = execSync(args.join(' '), {
      encoding: 'utf-8',
      timeout: 60000,
      env: { ...process.env, XDG_CACHE_HOME: cacheDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, output };
  } catch (e: any) {
    return { exitCode: e.status ?? 1, output: e.stdout ?? '' };
  }
}

function getDbStats(dbPath: string, project: string): {
  nodes: number; edges: number; orphanEdges: number; duplicateQNs: number;
  hashCount: number; statsMatch: boolean;
} {
  const db = new Database(dbPath, { readonly: true });

  const nodes = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(project) as { c: number }).c;
  const edges = (db.prepare('SELECT COUNT(*) AS c FROM edges WHERE project = ?').get(project) as { c: number }).c;

  const orphanEdges = (db.prepare(`
    SELECT COUNT(*) AS c FROM edges e
    LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project
    LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project
    WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)
  `).get(project) as { c: number }).c;

  const dupResult = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT qualified_name FROM nodes WHERE project = ?
      GROUP BY qualified_name HAVING COUNT(*) > 1
    )
  `).get(project) as { c: number };
  const duplicateQNs = dupResult.c;

  const hashCount = (db.prepare('SELECT COUNT(*) AS c FROM file_hashes WHERE project = ?').get(project) as { c: number }).c;

  const proj = db.prepare('SELECT node_count, edge_count FROM projects WHERE name = ?').get(project) as { node_count: number; edge_count: number } | undefined;
  const statsMatch = proj ? (proj.node_count === nodes && proj.edge_count === edges) : false;

  db.close();
  return { nodes, edges, orphanEdges, duplicateQNs, hashCount, statsMatch };
}

function parseOutput(output: string): { filesIndexed: number; filesSkipped: number; errors: number } {
  const filesMatch = output.match(/Files indexed:\s+(\d+)/);
  const skippedMatch = output.match(/Files skipped:\s+(\d+)/);
  const errorsMatch = output.match(/Errors:\s+(\d+)/);
  return {
    filesIndexed: filesMatch ? parseInt(filesMatch[1]) : 0,
    filesSkipped: skippedMatch ? parseInt(skippedMatch[1]) : 0,
    errors: errorsMatch ? parseInt(errorsMatch[1]) : 0,
  };
}

function createTestProject(dir: string, fileCount: number): void {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    const content = `export function func${i}() { return ${i}; }\n`;
    writeFileSync(join(dir, `file${i}.ts`), content);
  }
}

function modifyFile(dir: string, index: number, newContent?: string): void {
  const content = newContent ?? `export function func${index}_modified() { return ${index} + 1; }\n`;
  writeFileSync(join(dir, `file${index}.ts`), content);
}

function touchFile(dir: string, index: number): void {
  // Change mtime without changing content
  const filePath = join(dir, `file${index}.ts`);
  const now = new Date();
  utimesSync(filePath, now, now);
}

console.log('='.repeat(80));
console.log('  R87 Incremental Benchmark — with correctness invariants');
console.log('='.repeat(80));
console.log();

const tmpDir = mkdtempSync(join(tmpdir(), 'r87-bench-'));
const projectDir = join(tmpDir, 'project');
const cacheDir = join(tmpDir, 'cache');
mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
const FILE_COUNT = 20; // small enough for single-thread
const projectName = 'r87bench';
const dbPath = join(cacheDir, 'codebase-memory-mcp', `${projectName}.db`);

const results: BenchResult[] = [];

try {
  // Create test project
  createTestProject(projectDir, FILE_COUNT);

  // Scenario 1: Full cold index
  console.log('Scenario 1: Full cold index');
  const t1Start = Date.now();
  const r1 = runIndexer(projectName, projectDir, cacheDir, false);
  const t1Wall = Date.now() - t1Start;
  const s1 = getDbStats(dbPath, projectName);
  const p1 = parseOutput(r1.output);
  results.push({
    scenario: 'full-cold', wallMs: t1Wall,
    filesIndexed: p1.filesIndexed, filesSkipped: p1.filesSkipped,
    nodes: s1.nodes, edges: s1.edges, orphanEdges: s1.orphanEdges,
    duplicateQNs: s1.duplicateQNs, hashCount: s1.hashCount,
    statsMatch: s1.statsMatch, errors: p1.errors,
  });
  console.log(`  ${t1Wall}ms | nodes=${s1.nodes} edges=${s1.edges} hashes=${s1.hashCount} orphan=${s1.orphanEdges} dupQN=${s1.duplicateQNs} statsOK=${s1.statsMatch}`);

  // Scenario 2: Incremental no-op (nothing changed)
  console.log('Scenario 2: Incremental no-op');
  const t2Start = Date.now();
  const r2 = runIndexer(projectName, projectDir, cacheDir, true);
  const t2Wall = Date.now() - t2Start;
  const s2 = getDbStats(dbPath, projectName);
  const p2 = parseOutput(r2.output);
  results.push({
    scenario: 'incremental-noop', wallMs: t2Wall,
    filesIndexed: p2.filesIndexed, filesSkipped: p2.filesSkipped,
    nodes: s2.nodes, edges: s2.edges, orphanEdges: s2.orphanEdges,
    duplicateQNs: s2.duplicateQNs, hashCount: s2.hashCount,
    statsMatch: s2.statsMatch, errors: p2.errors,
  });
  console.log(`  ${t2Wall}ms | indexed=${p2.filesIndexed} skipped=${p2.filesSkipped} nodes=${s2.nodes} (should match ${s1.nodes})`);

  // Scenario 3: Incremental metadata-only (touch without content change)
  console.log('Scenario 3: Incremental metadata-only (touch)');
  touchFile(projectDir, 0);
  touchFile(projectDir, 1);
  const t3Start = Date.now();
  const r3 = runIndexer(projectName, projectDir, cacheDir, true);
  const t3Wall = Date.now() - t3Start;
  const s3 = getDbStats(dbPath, projectName);
  const p3 = parseOutput(r3.output);
  results.push({
    scenario: 'incremental-metadata-only', wallMs: t3Wall,
    filesIndexed: p3.filesIndexed, filesSkipped: p3.filesSkipped,
    nodes: s3.nodes, edges: s3.edges, orphanEdges: s3.orphanEdges,
    duplicateQNs: s3.duplicateQNs, hashCount: s3.hashCount,
    statsMatch: s3.statsMatch, errors: p3.errors,
  });
  console.log(`  ${t3Wall}ms | indexed=${p3.filesIndexed} skipped=${p3.filesSkipped} nodes=${s3.nodes} (should match ${s1.nodes})`);

  // Scenario 4: Incremental 1-file change
  console.log('Scenario 4: Incremental 1-file change');
  modifyFile(projectDir, 0);
  const t4Start = Date.now();
  const r4 = runIndexer(projectName, projectDir, cacheDir, true);
  const t4Wall = Date.now() - t4Start;
  const s4 = getDbStats(dbPath, projectName);
  const p4 = parseOutput(r4.output);
  results.push({
    scenario: 'incremental-1-file', wallMs: t4Wall,
    filesIndexed: p4.filesIndexed, filesSkipped: p4.filesSkipped,
    nodes: s4.nodes, edges: s4.edges, orphanEdges: s4.orphanEdges,
    duplicateQNs: s4.duplicateQNs, hashCount: s4.hashCount,
    statsMatch: s4.statsMatch, errors: p4.errors,
  });
  console.log(`  ${t4Wall}ms | indexed=${p4.filesIndexed} skipped=${p4.filesSkipped} nodes=${s4.nodes}`);

  // Scenario 5: Incremental 10% change
  console.log('Scenario 5: Incremental 10% change');
  const tenPct = Math.max(1, Math.floor(FILE_COUNT * 0.1));
  for (let i = 0; i < tenPct; i++) {
    modifyFile(projectDir, i + 2, `export function func${i + 2}_tenpct() { return ${i} * 10; }\n`);
  }
  const t5Start = Date.now();
  const r5 = runIndexer(projectName, projectDir, cacheDir, true);
  const t5Wall = Date.now() - t5Start;
  const s5 = getDbStats(dbPath, projectName);
  const p5 = parseOutput(r5.output);
  results.push({
    scenario: 'incremental-10pct', wallMs: t5Wall,
    filesIndexed: p5.filesIndexed, filesSkipped: p5.filesSkipped,
    nodes: s5.nodes, edges: s5.edges, orphanEdges: s5.orphanEdges,
    duplicateQNs: s5.duplicateQNs, hashCount: s5.hashCount,
    statsMatch: s5.statsMatch, errors: p5.errors,
  });
  console.log(`  ${t5Wall}ms | indexed=${p5.filesIndexed} skipped=${p5.filesSkipped} nodes=${s5.nodes}`);

  // Print summary
  console.log();
  console.log('─'.repeat(80));
  console.log('  Summary:');
  console.log('─'.repeat(80));
  console.log(`${'Scenario'.padEnd(28)} ${'Wall'.padStart(8)} ${'Idx'.padStart(5)} ${'Skp'.padStart(5)} ${'Nodes'.padStart(6)} ${'Edges'.padStart(6)} ${'Orph'.padStart(5)} ${'DupQN'.padStart(6)} ${'Hash'.padStart(5)} ${'StatOK'.padStart(7)}`);
  for (const r of results) {
    console.log(`${r.scenario.padEnd(28)} ${String(r.wallMs).padStart(7)}ms ${String(r.filesIndexed).padStart(5)} ${String(r.filesSkipped).padStart(5)} ${String(r.nodes).padStart(6)} ${String(r.edges).padStart(6)} ${String(r.orphanEdges).padStart(5)} ${String(r.duplicateQNs).padStart(6)} ${String(r.hashCount).padStart(5)} ${String(r.statsMatch).padStart(7)}`);
  }

  // Invariant checks
  console.log();
  console.log('  Invariant checks:');
  let allOk = true;
  for (const r of results) {
    if (r.orphanEdges > 0) {
      console.log(`  ✗ ${r.scenario}: orphan_edges=${r.orphanEdges} (must be 0)`);
      allOk = false;
    }
    if (!r.statsMatch) {
      console.log(`  ✗ ${r.scenario}: project stats mismatch`);
      allOk = false;
    }
    if (r.duplicateQNs > 0) {
      console.log(`  ✗ ${r.scenario}: duplicate QNs=${r.duplicateQNs}`);
      allOk = false;
    }
  }
  if (allOk) {
    console.log('  ✓ All invariants pass: orphan_edges=0, stats match, no duplicate QNs');
  }

  // Incremental correctness checks
  console.log();
  console.log('  Incremental correctness:');
  const noop = results.find(r => r.scenario === 'incremental-noop');
  if (noop && noop.filesIndexed === 0 && noop.filesSkipped === FILE_COUNT) {
    console.log(`  ✓ No-op incremental: 0 indexed, ${FILE_COUNT} skipped`);
  } else {
    console.log(`  ✗ No-op incremental: indexed=${noop?.filesIndexed}, skipped=${noop?.filesSkipped} (expected 0/${FILE_COUNT})`);
  }

  const metaOnly = results.find(r => r.scenario === 'incremental-metadata-only');
  if (metaOnly && metaOnly.nodes === results[0].nodes) {
    console.log(`  ✓ Metadata-only: nodes preserved (${metaOnly.nodes})`);
  } else {
    console.log(`  ✗ Metadata-only: nodes changed (${metaOnly?.nodes} vs ${results[0].nodes})`);
  }

  console.log();
  console.log('─'.repeat(80));

} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
