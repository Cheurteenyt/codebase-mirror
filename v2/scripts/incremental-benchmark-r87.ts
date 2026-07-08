// v2/scripts/incremental-benchmark-r87.ts
// R87: Incremental benchmark with correctness invariants.
// Measures: full, noop, metadata-only, 1-file-change, 10%-change, parallel full->noop.
// Verifies after each run: orphan_edges=0, project stats exact, file_hashes coverage.

import { spawnSync } from 'node:child_process';
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
  exitCode: number;
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
  // R92: use spawnSync instead of execSync(args.join(' ')) for portability
  // (handles paths with spaces, no shell injection risk, Windows-compatible)
  const args = [V2_DIST, 'index', '--project', project, '--root', root];
  if (incremental) args.push('--incremental');
  if (allowPartial) args.push('--allow-partial');
  const res = spawnSync(process.execPath, args, {
    encoding: 'utf-8',
    timeout: 60000,
    env: { ...process.env, XDG_CACHE_HOME: cacheDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { exitCode: res.status ?? (res.error || res.signal ? 1 : 0), output: res.stdout ?? '' };
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

const tmpDir = mkdtempSync(join(tmpdir(), 'r90-bench-'));
const projectDir = join(tmpDir, 'project');
const parallelDir = join(tmpDir, 'parallel-project');
const cacheDir = join(tmpDir, 'cache');
mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
// R90: support CBM_BENCH_SMOKE=1 for fast CI runs
const SMOKE = process.env.CBM_BENCH_SMOKE === '1';
const FILE_COUNT = SMOKE ? 8 : 20; // small enough for single-thread
const PARALLEL_FILE_COUNT = SMOKE ? 24 : 64; // >20 to force parallel path
const projectName = 'r90bench';
const parallelProjectName = 'r90parallel';
const dbPath = join(cacheDir, 'codebase-memory-mcp', `${projectName}.db`);
const parallelDbPath = join(cacheDir, 'codebase-memory-mcp', `${parallelProjectName}.db`);

const results: BenchResult[] = [];
// R90: declare allOk early so parallel assertion can use it
let allOk = true;

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
    scenario: 'full-cold', wallMs: t1Wall, exitCode: r1.exitCode,
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
    scenario: 'incremental-noop', wallMs: t2Wall, exitCode: r2.exitCode,
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
    scenario: 'incremental-metadata-only', wallMs: t3Wall, exitCode: r3.exitCode,
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
    scenario: 'incremental-1-file', wallMs: t4Wall, exitCode: r4.exitCode,
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
    scenario: 'incremental-10pct', wallMs: t5Wall, exitCode: r5.exitCode,
    filesIndexed: p5.filesIndexed, filesSkipped: p5.filesSkipped,
    nodes: s5.nodes, edges: s5.edges, orphanEdges: s5.orphanEdges,
    duplicateQNs: s5.duplicateQNs, hashCount: s5.hashCount,
    statsMatch: s5.statsMatch, errors: p5.errors,
  });
  console.log(`  ${t5Wall}ms | indexed=${p5.filesIndexed} skipped=${p5.filesSkipped} nodes=${s5.nodes}`);

  // R88: Parallel scenarios (64 files to force parallel path)
  console.log();
  console.log('--- Parallel scenarios (64 files) ---');
  createTestProject(parallelDir, PARALLEL_FILE_COUNT);

  // Scenario 6: Parallel full cold index
  console.log('Scenario 6: Parallel full cold index');
  const t6Start = Date.now();
  const r6 = runIndexer(parallelProjectName, parallelDir, cacheDir, false);
  const t6Wall = Date.now() - t6Start;
  const s6 = getDbStats(parallelDbPath, parallelProjectName);
  const p6 = parseOutput(r6.output);
  const isParallel6 = r6.output.includes('Parallel') || r6.output.includes('workers');
  results.push({
    scenario: 'parallel-full-cold', wallMs: t6Wall, exitCode: r6.exitCode,
    filesIndexed: p6.filesIndexed, filesSkipped: p6.filesSkipped,
    nodes: s6.nodes, edges: s6.edges, orphanEdges: s6.orphanEdges,
    duplicateQNs: s6.duplicateQNs, hashCount: s6.hashCount,
    statsMatch: s6.statsMatch, errors: p6.errors,
  });
  console.log(`  ${t6Wall}ms | indexed=${p6.filesIndexed} parallel=${isParallel6} nodes=${s6.nodes} hashes=${s6.hashCount}`);
  // R90: assert parallel path was actually used
  if (!isParallel6) {
    console.log(`  ✗ parallel-full-cold did not use parallel path (output missing 'Parallel')`);
    allOk = false;
  }

  // Scenario 7: Parallel incremental no-op
  console.log('Scenario 7: Parallel incremental no-op');
  const t7Start = Date.now();
  const r7 = runIndexer(parallelProjectName, parallelDir, cacheDir, true);
  const t7Wall = Date.now() - t7Start;
  const s7 = getDbStats(parallelDbPath, parallelProjectName);
  const p7 = parseOutput(r7.output);
  results.push({
    scenario: 'parallel-incremental-noop', wallMs: t7Wall, exitCode: r7.exitCode,
    filesIndexed: p7.filesIndexed, filesSkipped: p7.filesSkipped,
    nodes: s7.nodes, edges: s7.edges, orphanEdges: s7.orphanEdges,
    duplicateQNs: s7.duplicateQNs, hashCount: s7.hashCount,
    statsMatch: s7.statsMatch, errors: p7.errors,
  });
  console.log(`  ${t7Wall}ms | indexed=${p7.filesIndexed} skipped=${p7.filesSkipped} (expected 0/${PARALLEL_FILE_COUNT})`);

  // Scenario 8: Parallel metadata-only (touch all files)
  console.log('Scenario 8: Parallel metadata-only (touch all)');
  for (let i = 0; i < PARALLEL_FILE_COUNT; i++) {
    touchFile(parallelDir, i);
  }
  const t8Start = Date.now();
  const r8 = runIndexer(parallelProjectName, parallelDir, cacheDir, true);
  const t8Wall = Date.now() - t8Start;
  const s8 = getDbStats(parallelDbPath, parallelProjectName);
  const p8 = parseOutput(r8.output);
  results.push({
    scenario: 'parallel-metadata-only', wallMs: t8Wall, exitCode: r8.exitCode,
    filesIndexed: p8.filesIndexed, filesSkipped: p8.filesSkipped,
    nodes: s8.nodes, edges: s8.edges, orphanEdges: s8.orphanEdges,
    duplicateQNs: s8.duplicateQNs, hashCount: s8.hashCount,
    statsMatch: s8.statsMatch, errors: p8.errors,
  });
  console.log(`  ${t8Wall}ms | indexed=${p8.filesIndexed} skipped=${p8.filesSkipped} nodes=${s8.nodes}`);

  // Scenario 9: Parallel incremental no-op after metadata-only (should fast-skip)
  console.log('Scenario 9: Parallel no-op after metadata-only (verify fast-skip)');
  const t9Start = Date.now();
  const r9 = runIndexer(parallelProjectName, parallelDir, cacheDir, true);
  const t9Wall = Date.now() - t9Start;
  const s9 = getDbStats(parallelDbPath, parallelProjectName);
  const p9 = parseOutput(r9.output);
  results.push({
    scenario: 'parallel-noop-after-meta', wallMs: t9Wall, exitCode: r9.exitCode,
    filesIndexed: p9.filesIndexed, filesSkipped: p9.filesSkipped,
    nodes: s9.nodes, edges: s9.edges, orphanEdges: s9.orphanEdges,
    duplicateQNs: s9.duplicateQNs, hashCount: s9.hashCount,
    statsMatch: s9.statsMatch, errors: p9.errors,
  });
  console.log(`  ${t9Wall}ms | indexed=${p9.filesIndexed} skipped=${p9.filesSkipped} (should be 0/${PARALLEL_FILE_COUNT})`);

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
  // allOk already declared at top (R90)
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
    // R89: verify errors === 0 for all scenarios
    if (r.errors > 0) {
      console.log(`  ✗ ${r.scenario}: errors=${r.errors} (must be 0)`);
      allOk = false;
    }
    // R91: verify exitCode === 0 for all scenarios
    if (r.exitCode !== 0) {
      console.log(`  ✗ ${r.scenario}: exitCode=${r.exitCode} (must be 0)`);
      allOk = false;
    }
    // R89: verify hashCount for all scenarios
    const expectedHashCount = r.scenario.startsWith('parallel-') ? PARALLEL_FILE_COUNT : FILE_COUNT;
    if (r.hashCount !== expectedHashCount) {
      console.log(`  ✗ ${r.scenario}: hashCount=${r.hashCount}, expected=${expectedHashCount}`);
      allOk = false;
    }
  }
  if (allOk) {
    console.log('  ✓ All invariants pass: orphan_edges=0, stats match, no duplicate QNs, errors=0, hash coverage');
  }

  // Incremental correctness checks
  console.log();
  console.log('  Incremental correctness:');
  const noop = results.find(r => r.scenario === 'incremental-noop');
  if (noop && noop.filesIndexed === 0 && noop.filesSkipped === FILE_COUNT) {
    console.log(`  ✓ No-op incremental: 0 indexed, ${FILE_COUNT} skipped`);
  } else {
    console.log(`  ✗ No-op incremental: indexed=${noop?.filesIndexed}, skipped=${noop?.filesSkipped} (expected 0/${FILE_COUNT})`);
    allOk = false;
  }

  const metaOnly = results.find(r => r.scenario === 'incremental-metadata-only');
  if (metaOnly && metaOnly.nodes === results[0].nodes) {
    console.log(`  ✓ Metadata-only: nodes preserved (${metaOnly.nodes})`);
  } else {
    console.log(`  ✗ Metadata-only: nodes changed (${metaOnly?.nodes} vs ${results[0].nodes})`);
    allOk = false;
  }

  // R88: Parallel correctness checks
  console.log();
  console.log('  Parallel correctness:');
  const parallelNoop = results.find(r => r.scenario === 'parallel-incremental-noop');
  if (parallelNoop && parallelNoop.filesIndexed === 0 && parallelNoop.filesSkipped === PARALLEL_FILE_COUNT) {
    console.log(`  ✓ Parallel no-op: 0 indexed, ${PARALLEL_FILE_COUNT} skipped`);
  } else {
    console.log(`  ✗ Parallel no-op: indexed=${parallelNoop?.filesIndexed}, skipped=${parallelNoop?.filesSkipped} (expected 0/${PARALLEL_FILE_COUNT})`);
    allOk = false;
  }

  const parallelMeta = results.find(r => r.scenario === 'parallel-metadata-only');
  if (parallelMeta && parallelMeta.nodes === results.find(r => r.scenario === 'parallel-full-cold')?.nodes) {
    console.log(`  ✓ Parallel metadata-only: nodes preserved (${parallelMeta.nodes})`);
  } else {
    console.log(`  ✗ Parallel metadata-only: nodes changed`);
    allOk = false;
  }

  const parallelFastSkip = results.find(r => r.scenario === 'parallel-noop-after-meta');
  if (parallelFastSkip && parallelFastSkip.filesIndexed === 0 && parallelFastSkip.filesSkipped === PARALLEL_FILE_COUNT) {
    console.log(`  ✓ Parallel fast-skip after metadata-only: 0 indexed, ${PARALLEL_FILE_COUNT} skipped`);
  } else {
    console.log(`  ✗ Parallel fast-skip after metadata-only: indexed=${parallelFastSkip?.filesIndexed}, skipped=${parallelFastSkip?.filesSkipped} (expected 0/${PARALLEL_FILE_COUNT})`);
    allOk = false;
  }

  // R88: hash coverage check for parallel
  const parallelFull = results.find(r => r.scenario === 'parallel-full-cold');
  if (parallelFull && parallelFull.hashCount === PARALLEL_FILE_COUNT) {
    console.log(`  ✓ Parallel hash coverage: ${parallelFull.hashCount}/${PARALLEL_FILE_COUNT}`);
  } else {
    console.log(`  ✗ Parallel hash coverage: ${parallelFull?.hashCount}/${PARALLEL_FILE_COUNT} (must match)`);
    allOk = false;
  }

  console.log();
  console.log('─'.repeat(80));

  // R88: exit non-zero if any invariant failed
  if (!allOk) {
    console.log('  BENCHMARK FAILED — invariants not met');
    process.exitCode = 1;
  } else {
    console.log('  BENCHMARK PASSED — all invariants met');
  }

} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
