// v2/scripts/rigorous-benchmark-r78.ts
// R78: Truly rigorous benchmark that fixes every flaw found in R77.
//
// Flaws in R77 that this script fixes:
//  1.  5 iterations → 30 measured + 5 warmup (discarded)
//  2.  No warmup → 5 warmup runs per engine, discarded
//  3.  Date.now() (~1ms precision) → process.hrtime.bigint() (ns precision)
//  4.  No confidence intervals → bootstrap 95% CI for the median
//  5.  No significance test → Mann-Whitney U (two-sided) reported with p-value
//  6.  No effect size → Cliff's delta (non-parametric)
//  7.  No memory measurement → peak RSS captured for both engines by the portable runner
//  8.  No baseline → measures `V1 --version` and `node -e ''` spawn noise floors
//  9.  No verification of binaries → verifies V1 binary exists + V2 dist is fresh
// 10.  Strict alternation → randomized order (seeded PRNG) to break cache coupling
// 11.  Fragile regex parsing of V2 stdout → reads SQLite DB directly for V2
// 12.  DB files accumulate in ~/.cache → cleaned after each iteration
// 13.  Shell-dependent process launch → argument arrays on Windows and POSIX
// 14.  Single-thread vs parallel path confusion → expected V2 mode is explicit
//      and every measured run is rejected when the observed mode differs
//
// Usage:
//   npx tsx scripts/rigorous-benchmark-r78.ts
//
// Output:
//   - Console summary
//   - JSON results file: scripts/rigorous-benchmark-r78-results.json

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  findExecutableOnPath,
  parseV2ParallelMode,
  resolveBenchmarkResultsPath,
  validateWorkloadCompleteness,
} from './rigorous-benchmark-r78-helpers.js';

// ── Configuration (R83: portable paths via import.meta.url + env vars) ─

const HERE = dirname(fileURLToPath(import.meta.url));   // v2/scripts/
const V2_ROOT = resolve(HERE, '..');                       // v2/
const REPO_ROOT = resolve(V2_ROOT, '..');                  // cbm-r19/

// Auto-detect V1 without invoking a platform shell: env > repo-relative > PATH.
function detectV1Binary(): string {
  if (process.env.CBM_V1_BINARY) return resolve(process.env.CBM_V1_BINARY);

  const binaryName = process.platform === 'win32'
    ? 'codebase-memory-mcp.exe'
    : 'codebase-memory-mcp';
  const repoCandidates = [
    resolve(REPO_ROOT, 'v1-reference', 'build', 'c', binaryName),
    resolve(REPO_ROOT, '..', 'codebase-memory-mcp', 'build', 'c', binaryName),
  ];
  for (const candidate of repoCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  for (const command of ['codebase-memory-mcp', 'cbm']) {
    const candidate = findExecutableOnPath(command);
    if (candidate) return candidate;
  }

  // Deterministic repository-relative fallback for the preflight error.
  return repoCandidates[0];
}

const V1_BINARY = detectV1Binary();
const V2_DIST = process.env.CBM_V2_DIST ?? resolve(V2_ROOT, 'dist/cli/index.js');
const V2_SRC = process.env.CBM_V2_SRC ?? resolve(V2_ROOT, 'src');
const SMALL_TARGET = process.env.CBM_BENCH_SMALL ?? resolve(V2_ROOT, 'src');
const LARGE_TARGET = process.env.CBM_BENCH_LARGE ?? resolve(REPO_ROOT, 'v1-reference/src');
const RUNNER_PY = process.env.CBM_BENCH_RUNNER ?? resolve(V2_ROOT, 'scripts/r78-runner.py');
const RESULTS_PATH = resolveBenchmarkResultsPath(HERE, process.env.CBM_BENCH_RESULTS);

const WARMUP = process.env.R78_SMOKE ? 1 : 5;
const ITERATIONS = process.env.R78_SMOKE ? 2 : 30;
const RANDOM_SEED = 0xC0DE_BEEF; // deterministic seed (valid hex)

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  throw new Error(`${name} must be true/false or 1/0, got: ${value}`);
}

// ── Verification ───────────────────────────────────────────────────────

function fail(msg: string): never {
  throw new Error(msg);
}

interface PythonCommand {
  executable: string;
  prefixArgs: string[];
}

let pythonCommand: PythonCommand | null = null;

function detectPythonCommand(): PythonCommand | null {
  const configured = process.env.CBM_BENCH_PYTHON;
  const candidates: Array<{ command: string; prefixArgs: string[] }> = configured
    ? [{ command: configured, prefixArgs: [] }]
    : [
        { command: 'python3', prefixArgs: [] },
        { command: 'python', prefixArgs: [] },
        { command: 'py', prefixArgs: ['-3'] },
      ];

  for (const candidate of candidates) {
    const executable = findExecutableOnPath(candidate.command)
      ?? (existsSync(candidate.command) ? resolve(candidate.command) : null);
    if (!executable) continue;
    const probe = spawnSync(executable, [...candidate.prefixArgs, '--version'], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 10_000,
    });
    if (!probe.error && probe.status === 0) {
      return { executable, prefixArgs: candidate.prefixArgs };
    }
  }
  return null;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function verifyEnvironment(): void {
  if (!existsSync(V1_BINARY)) fail(`V1 binary not found at ${V1_BINARY}`);
  if (!existsSync(V2_DIST)) fail(`V2 dist not found at ${V2_DIST} — run "npm run build" first`);
  const distMtime = statSync(V2_DIST).mtimeMs;
  const srcFiles = walkTs(V2_SRC);
  const stale = srcFiles.filter(f => statSync(f).mtimeMs > distMtime);
  if (stale.length > 0) {
    fail(`V2 dist is STALE — ${stale.length} source file(s) newer than dist. Run "npm run build". First stale: ${stale[0]}`);
  }
  if (!existsSync(SMALL_TARGET)) fail(`Small target not found: ${SMALL_TARGET}`);
  if (!existsSync(LARGE_TARGET)) fail(`Large target not found: ${LARGE_TARGET}`);
  if (!existsSync(RUNNER_PY)) fail(`Runner script not found: ${RUNNER_PY}`);
  pythonCommand = detectPythonCommand();
  if (!pythonCommand) {
    fail('Python 3 required (set CBM_BENCH_PYTHON to an explicit executable)');
  }
}

// ── Seeded PRNG (Mulberry32) for deterministic randomization ───────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Statistics ─────────────────────────────────────────────────────────

interface Stats {
  n: number; min: number; p25: number; p50: number; p75: number;
  p90: number; p99: number; max: number;
  mean: number; stddev: number; cvPct: number;
  ci95Low: number; ci95High: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function describe(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = samples.length;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  // Bootstrap 95% CI for median
  const rng = mulberry32(42);
  const medians: number[] = [];
  for (let i = 0; i < 5000; i++) {
    const resample: number[] = [];
    for (let j = 0; j < n; j++) resample.push(samples[Math.floor(rng() * n)]);
    resample.sort((a, b) => a - b);
    medians.push(resample[Math.floor(n / 2)]);
  }
  medians.sort((a, b) => a - b);
  return {
    n, min: sorted[0], p25: percentile(sorted, 0.25), p50: percentile(sorted, 0.50),
    p75: percentile(sorted, 0.75), p90: percentile(sorted, 0.90), p99: percentile(sorted, 0.99),
    max: sorted[n - 1], mean, stddev, cvPct: (stddev / mean) * 100,
    ci95Low: medians[Math.floor(5000 * 0.025)], ci95High: medians[Math.floor(5000 * 0.975)],
  };
}

function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

function mannWhitneyU(a: number[], b: number[]): { U1: number; U2: number; pValue: number; z: number } {
  const n1 = a.length, n2 = b.length;
  type Pair = { value: number; group: 0 | 1 };
  const combined: Pair[] = [
    ...a.map(v => ({ value: v, group: 0 as const })),
    ...b.map(v => ({ value: v, group: 1 as const })),
  ];
  combined.sort((x, y) => x.value - y.value);
  const ranks: number[] = new Array(combined.length).fill(0);
  let i = 0;
  const tieCounts: number[] = [];
  while (i < combined.length) {
    let j = i;
    while (j < combined.length - 1 && combined[j + 1].value === combined[i].value) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    if (j > i) tieCounts.push(j - i + 1);
    i = j + 1;
  }
  let R1 = 0;
  for (let k = 0; k < combined.length; k++) {
    if (combined[k].group === 0) R1 += ranks[k];
  }
  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const U2 = n1 * n2 - U1;
  const mu = (n1 * n2) / 2;
  let tieSum = 0;
  for (const t of tieCounts) tieSum += t ** 3 - t;
  const N = n1 + n2;
  const sigma = Math.sqrt((n1 * n2 / 12) * ((N + 1) - tieSum / (N * (N - 1))));
  const z = sigma > 0 ? (Math.abs(U1 - mu) - 0.5) / sigma : 0;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { U1, U2, pValue: p, z };
}

function cliffsDelta(a: number[], b: number[]): number {
  let dominant = 0;
  for (const x of a) for (const y of b) {
    if (x > y) dominant++;
    else if (x < y) dominant--;
  }
  return dominant / (a.length * b.length);
}

// ── Runners ────────────────────────────────────────────────────────────

interface RunResult {
  wallMs: number;
  peakRssKb: number;
  nodes: number;
  edges: number;
  files: number;
  parallel: boolean | null;
  errors: string[];
}

interface RunnerResult {
  wall_ms: number;
  peak_rss_kb: number;
  exit_code: number;
  error?: string;
}

const TMP = mkdtempSync(join(tmpdir(), 'cbm-r78-'));
const CACHE_DIR = join(TMP, 'cache');

function ensureDirs(): void {
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
  // V2 requires $XDG_CACHE_HOME/codebase-memory-mcp/ to exist before opening DB
  try { mkdirSync(join(CACHE_DIR, 'codebase-memory-mcp'), { recursive: true }); } catch {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invokeRunner(
  stdoutFile: string,
  stderrFile: string,
  command: string[],
  timeout = 60_000,
): RunnerResult {
  if (!pythonCommand) throw new Error('Python runner was not initialized');
  const invocation = spawnSync(
    pythonCommand.executable,
    [
      ...pythonCommand.prefixArgs,
      RUNNER_PY,
      stdoutFile,
      stderrFile,
      `XDG_CACHE_HOME=${CACHE_DIR}`,
      `CBM_RUN_TIMEOUT_MS=${timeout}`,
      '--',
      ...command,
    ],
    {
      encoding: 'utf-8',
      // The runner owns the workload process group and gets time to terminate
      // descendants before this outer guard stops the Python wrapper.
      timeout: timeout + 10_000,
      windowsHide: true,
      env: { ...process.env, XDG_CACHE_HOME: CACHE_DIR },
      maxBuffer: 1024 * 1024,
    },
  );
  if (invocation.error) throw invocation.error;
  if (invocation.status !== 0) {
    throw new Error(
      `runner exited ${invocation.status}: ${(invocation.stderr || '').trim() || 'no stderr'}`,
    );
  }
  let parsed: RunnerResult;
  try {
    parsed = JSON.parse((invocation.stdout || '').trim()) as RunnerResult;
  } catch {
    throw new Error(`runner returned invalid JSON: ${(invocation.stdout || '').trim()}`);
  }
  if (![parsed.wall_ms, parsed.peak_rss_kb, parsed.exit_code].every(Number.isFinite)) {
    throw new Error(`runner returned incomplete metrics: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function readGraphCounts(projectName: string): { nodes: number; edges: number; files: number } {
  const dbPath = join(CACHE_DIR, 'codebase-memory-mcp', `${projectName}.db`);
  if (!existsSync(dbPath)) throw new Error(`db not found: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const nodes = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?')
      .get(projectName) as { c: number }).c;
    const edges = (db.prepare('SELECT COUNT(*) AS c FROM edges WHERE project = ?')
      .get(projectName) as { c: number }).c;
    const files = (db.prepare('SELECT COUNT(*) AS c FROM file_hashes WHERE project = ?')
      .get(projectName) as { c: number }).c;
    return { nodes, edges, files };
  } finally {
    db.close();
  }
}

function runV1(target: string, projectName: string): RunResult {
  const stdoutFile = join(TMP, `v1-${projectName}.stdout`);
  const stderrFile = join(TMP, `v1-${projectName}.stderr`);
  let r: RunnerResult;
  try {
    r = invokeRunner(stdoutFile, stderrFile, [
      V1_BINARY,
      'cli',
      'index_repository',
      '--repo-path',
      target,
      '--name',
      projectName,
      '--mode',
      'fast',
    ]);
  } catch (error: unknown) {
    return { wallMs: NaN, peakRssKb: 0, nodes: 0, edges: 0, files: 0, parallel: null, errors: [errorMessage(error)] };
  }
  const wallMs = r.wall_ms as number;
  const peakRssKb = r.peak_rss_kb as number;
  if (r.exit_code !== 0) {
    return { wallMs, peakRssKb, nodes: 0, edges: 0, files: 0, parallel: null, errors: [`exit_code=${r.exit_code}${r.error ? ` (${r.error})` : ''}`] };
  }

  let nodes = 0, edges = 0, files = 0;
  try {
    ({ nodes, edges, files } = readGraphCounts(projectName));
  } catch (error: unknown) {
    return {
      wallMs, peakRssKb, nodes: 0, edges: 0, files: 0, parallel: null,
      errors: [`db read failed: ${errorMessage(error)}`],
    };
  }

  return { wallMs, peakRssKb, nodes, edges, files, parallel: null, errors: [] };
}

function runV2(target: string, projectName: string): RunResult {
  const stdoutFile = join(TMP, `v2-${projectName}.stdout`);
  const stderrFile = join(TMP, `v2-${projectName}.stderr`);
  let r: RunnerResult;
  try {
    r = invokeRunner(stdoutFile, stderrFile, [
      process.execPath,
      V2_DIST,
      'index',
      '--project',
      projectName,
      '--root',
      target,
      '--discovery-mode',
      'fast',
    ]);
  } catch (error: unknown) {
    return { wallMs: NaN, peakRssKb: 0, nodes: 0, edges: 0, files: 0, parallel: null, errors: [errorMessage(error)] };
  }
  const wallMs = r.wall_ms as number;
  const peakRssKb = r.peak_rss_kb as number;
  if (r.exit_code !== 0) {
    return { wallMs, peakRssKb, nodes: 0, edges: 0, files: 0, parallel: null, errors: [`exit_code=${r.exit_code}${r.error ? ` (${r.error})` : ''}`] };
  }

  // Authoritative counts from SQLite
  let nodes = 0, edges = 0, files = 0;
  try {
    ({ nodes, edges, files } = readGraphCounts(projectName));
  } catch (error: unknown) {
    return {
      wallMs, peakRssKb, nodes: 0, edges: 0, files: 0, parallel: null,
      errors: [`db read failed: ${errorMessage(error)}`],
    };
  }

  let parallel: boolean | null = null;
  try {
    const out = readFileSync(stdoutFile, 'utf-8');
    parallel = parseV2ParallelMode(out);
  } catch {}

  return { wallMs, peakRssKb, nodes, edges, files, parallel, errors: [] };
}

function runV1StartupBaseline(): number {
  const tmpOut = join(TMP, 'baseline-v1.stdout');
  const tmpErr = join(TMP, 'baseline-v1.stderr');
  const result = invokeRunner(tmpOut, tmpErr, [V1_BINARY, '--version']);
  if (result.exit_code !== 0) throw new Error(`V1 --version exited ${result.exit_code}`);
  return result.wall_ms;
}

function runNodeStartupBaseline(): number {
  const tmpOut = join(TMP, 'baseline-node.stdout');
  const tmpErr = join(TMP, 'baseline-node.stderr');
  const result = invokeRunner(tmpOut, tmpErr, [process.execPath, '-e', '']);
  if (result.exit_code !== 0) throw new Error(`node -e exited ${result.exit_code}`);
  return result.wall_ms;
}

function cleanupProjectDb(projectName: string): void {
  const base = join(CACHE_DIR, 'codebase-memory-mcp');
  for (const p of [
    join(base, `${projectName}.db`),
    join(base, `${projectName}.db-journal`),
    join(base, `${projectName}.db-wal`),
    join(base, `${projectName}.db-shm`),
  ]) {
    try { rmSync(p, { force: true }); } catch {}
  }
}

function fmt(n: number, dp = 1): string {
  if (Number.isNaN(n)) return 'NaN';
  return n.toFixed(dp);
}

function fmtStats(s: Stats): string {
  return `min=${fmt(s.min, 0)}ms  p25=${fmt(s.p25, 0)}ms  p50=${fmt(s.p50, 0)}ms  p75=${fmt(s.p75, 0)}ms  p90=${fmt(s.p90, 0)}ms  p99=${fmt(s.p99, 0)}ms  max=${fmt(s.max, 0)}ms
         mean=${fmt(s.mean, 0)}ms  ±${fmt(s.stddev, 0)}ms  CV=${fmt(s.cvPct, 1)}%  95%CI=[${fmt(s.ci95Low, 0)}, ${fmt(s.ci95High, 0)}]`;
}

// ── Main ───────────────────────────────────────────────────────────────

function main() {
  console.log('='.repeat(80));
  console.log('  Rigorous Benchmark R78 — V1 (C) vs V2 (WASM)');
  console.log('  Fixes every flaw found in R77 (see script header)');
  console.log('='.repeat(80));
  console.log();

  verifyEnvironment();
  ensureDirs();
  const smallExpectParallel = envBoolean('CBM_BENCH_SMALL_EXPECT_PARALLEL', true);
  const largeExpectParallel = envBoolean('CBM_BENCH_LARGE_EXPECT_PARALLEL', true);
  console.log(`  Work directory: ${TMP}`);
  console.log(`  V1 binary:      ${V1_BINARY}`);
  console.log(`  V2 dist:        ${V2_DIST}`);
  console.log(`  Iterations:     ${ITERATIONS} measured + ${WARMUP} warmup (discarded) per engine per workload`);
  console.log(`  Randomization:  Mulberry32 seed=0xC0DEBEEF (deterministic)`);
  console.log();

  // ── Baselines ───────────────────────────────────────────────────────
  console.log('─'.repeat(80));
  console.log('  Step 1 — Spawn baselines (noise floor)');
  console.log('─'.repeat(80));
  const baselinesV1: number[] = [];
  const baselinesNode: number[] = [];
  for (let i = 0; i < 20; i++) baselinesV1.push(runV1StartupBaseline());
  for (let i = 0; i < 20; i++) baselinesNode.push(runNodeStartupBaseline());
  const baselineV1 = describe(baselinesV1);
  const baselineNode = describe(baselinesNode);
  console.log(`  spawn 'V1 --version' : p50=${fmt(baselineV1.p50, 2)}ms  mean=${fmt(baselineV1.mean, 2)}ms  CV=${fmt(baselineV1.cvPct, 1)}%`);
  console.log(`  spawn 'node -e ""'   : p50=${fmt(baselineNode.p50, 2)}ms  mean=${fmt(baselineNode.mean, 2)}ms  CV=${fmt(baselineNode.cvPct, 1)}%`);
  console.log(`  → Baselines execute each runtime's own minimal version/no-op path.`);
  console.log();

  // ── Run benchmark on each workload ──────────────────────────────────
  const workloads = [
    { name: 'SMALL', desc: 'V2 source workload', target: SMALL_TARGET, expectParallel: smallExpectParallel },
    { name: 'LARGE', desc: 'V1 reference source workload', target: LARGE_TARGET, expectParallel: largeExpectParallel },
  ];

  const benchmarkErrors: string[] = [];

  const allResults: any = {
    timestamp: new Date().toISOString(),
    config: {
      WARMUP,
      ITERATIONS,
      RANDOM_SEED,
      V1_BINARY,
      V2_DIST,
      SMALL_TARGET,
      LARGE_TARGET,
      SMALL_EXPECT_PARALLEL: smallExpectParallel,
      LARGE_EXPECT_PARALLEL: largeExpectParallel,
      discoveryMode: 'fast',
    },
    baselines: { spawnV1Version: baselineV1, spawnNodeEmpty: baselineNode },
    workloads: [] as any[],
    errors: benchmarkErrors,
  };

  for (const wl of workloads) {
    console.log('─'.repeat(80));
    console.log(`  Workload: ${wl.name} — ${wl.desc}`);
    console.log(`  Target:   ${wl.target}`);
    console.log('─'.repeat(80));

    type Run = { engine: 'V1' | 'V2'; idx: number; isWarmup: boolean };
    const runs: Run[] = [];
    for (let i = 0; i < WARMUP; i++) {
      runs.push({ engine: 'V1', idx: i, isWarmup: true });
      runs.push({ engine: 'V2', idx: i, isWarmup: true });
    }
    for (let i = 0; i < ITERATIONS; i++) {
      runs.push({ engine: 'V1', idx: i, isWarmup: false });
      runs.push({ engine: 'V2', idx: i, isWarmup: false });
    }
    const rng = mulberry32(RANDOM_SEED + wl.name.length);
    for (let i = runs.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [runs[i], runs[j]] = [runs[j], runs[i]];
    }

    const v1Measured: RunResult[] = [];
    const v2Measured: RunResult[] = [];
    let progressIdx = 0;
    const total = runs.length;

    for (const run of runs) {
      progressIdx++;
      const projectName = `r78-${wl.name.toLowerCase()}-${run.engine.toLowerCase()}-${run.idx}-${run.isWarmup ? 'w' : 'm'}`;
      process.stdout.write(`  [${progressIdx.toString().padStart(3)}/${total}] ${run.engine} ${run.isWarmup ? '(warmup)' : '(measured)'} ... `);
      const result = run.engine === 'V1' ? runV1(wl.target, projectName) : runV2(wl.target, projectName);
      if (
        run.engine === 'V2'
        && result.errors.length === 0
        && result.parallel !== wl.expectParallel
      ) {
        result.errors.push(
          result.parallel === null
            ? `execution mode could not be parsed (expected parallel=${wl.expectParallel})`
            : `parallel=${result.parallel}, expected ${wl.expectParallel}`,
        );
      }
      if (result.errors.length > 0) {
        console.log(`ERROR: ${result.errors[0]}`);
        benchmarkErrors.push(
          `${wl.name}/${run.engine}/${run.isWarmup ? 'warmup' : 'measured'}-${run.idx}: ${result.errors[0]}`,
        );
      } else {
        const mode = run.engine === 'V2' ? `  parallel=${result.parallel}` : '';
        console.log(`${fmt(result.wallMs, 0)}ms  nodes=${result.nodes}  edges=${result.edges}  RSS=${(result.peakRssKb / 1024).toFixed(0)}MB${mode}`);
      }
      if (!run.isWarmup && result.errors.length === 0) {
        if (run.engine === 'V1') v1Measured.push(result);
        else v2Measured.push(result);
      }
      cleanupProjectDb(projectName);
    }

    const completenessErrors = validateWorkloadCompleteness({
      workload: wl.name,
      expectedRuns: ITERATIONS,
      expectParallel: wl.expectParallel,
      v1: v1Measured,
      v2: v2Measured,
    });
    if (completenessErrors.length > 0) {
      for (const error of completenessErrors) {
        console.error(`  ✗ ${error}`);
        benchmarkErrors.push(error);
      }
      console.error('  Analysis refused: workload evidence is incomplete or unstable.');
      continue;
    }

    const v1Times = v1Measured.map(r => r.wallMs);
    const v2Times = v2Measured.map(r => r.wallMs);
    const v1Rss = v1Measured.map(r => r.peakRssKb);
    const v2Rss = v2Measured.map(r => r.peakRssKb);

    const v1TimeStats = describe(v1Times);
    const v2TimeStats = describe(v2Times);
    const v1RssStats = describe(v1Rss);
    const v2RssStats = describe(v2Rss);

    const mwu = mannWhitneyU(v1Times, v2Times);
    const delta = cliffsDelta(v1Times, v2Times);

    const v1NodeCounts = [...new Set(v1Measured.map(r => r.nodes))];
    const v2NodeCounts = [...new Set(v2Measured.map(r => r.nodes))];
    const v1EdgeCounts = [...new Set(v1Measured.map(r => r.edges))];
    const v2EdgeCounts = [...new Set(v2Measured.map(r => r.edges))];

    console.log();
    console.log('  ┌─ V1 (C, tree-sitter native) ──────────────────────────────');
    console.log('  │ Duration: ' + fmtStats(v1TimeStats));
    console.log(`  │ Peak RSS: p50=${(v1RssStats.p50 / 1024).toFixed(0)}MB  mean=${(v1RssStats.mean / 1024).toFixed(0)}MB  CV=${fmt(v1RssStats.cvPct, 1)}%`);
    console.log(`  │ Nodes:    ${v1NodeCounts.join(',')}  (unique counts: ${v1NodeCounts.length})`);
    console.log(`  │ Edges:    ${v1EdgeCounts.join(',')}  (unique counts: ${v1EdgeCounts.length})`);
    console.log('  └' + '─'.repeat(60));
    console.log();
    console.log('  ┌─ V2 (WASM, web-tree-sitter) ─────────────────────────────');
    console.log('  │ Duration: ' + fmtStats(v2TimeStats));
    console.log(`  │ Peak RSS: p50=${(v2RssStats.p50 / 1024).toFixed(0)}MB  mean=${(v2RssStats.mean / 1024).toFixed(0)}MB  CV=${fmt(v2RssStats.cvPct, 1)}%`);
    console.log(`  │ Nodes:    ${v2NodeCounts.join(',')}  (unique counts: ${v2NodeCounts.length})`);
    console.log(`  │ Edges:    ${v2EdgeCounts.join(',')}  (unique counts: ${v2EdgeCounts.length})`);
    console.log('  └' + '─'.repeat(60));
    console.log();

    console.log('  Statistical comparison (medians, two-sided):');
    console.log(`    V1 median: ${fmt(v1TimeStats.p50, 1)}ms  (95% CI: [${fmt(v1TimeStats.ci95Low, 1)}, ${fmt(v1TimeStats.ci95High, 1)}])`);
    console.log(`    V2 median: ${fmt(v2TimeStats.p50, 1)}ms  (95% CI: [${fmt(v2TimeStats.ci95Low, 1)}, ${fmt(v2TimeStats.ci95High, 1)}])`);
    const diff = v2TimeStats.p50 - v1TimeStats.p50;
    const pct = (diff / v1TimeStats.p50) * 100;
    const direction = diff > 0 ? 'SLOWER' : (diff < 0 ? 'FASTER' : 'EQUAL');
    console.log(`    Difference: ${fmt(Math.abs(diff), 1)}ms  V2 is ${fmt(Math.abs(pct), 1)}% ${direction} than V1`);
    console.log();
    console.log(`    Mann-Whitney U:  U1=${mwu.U1.toFixed(0)}  z=${fmt(mwu.z, 3)}  p=${fmt(mwu.pValue, 5)}`);
    console.log(`    Significance:    ${mwu.pValue < 0.05 ? '✓ STATISTICALLY SIGNIFICANT (p<0.05)' : '✗ NOT statistically significant (p≥0.05) — difference may be noise'}`);
    const absDelta = Math.abs(delta);
    const deltaMag = absDelta < 0.147 ? 'negligible' : absDelta < 0.33 ? 'small' : absDelta < 0.474 ? 'medium' : 'large';
    console.log(`    Effect size:     Cliff's δ=${fmt(delta, 3)}  (${deltaMag})`);
    console.log();

    const v1Extracted = v1Times.map(t => t - baselineV1.p50);
    const v2Extracted = v2Times.map(t => t - baselineNode.p50);
    const v1ExStats = describe(v1Extracted);
    const v2ExStats = describe(v2Extracted);
    console.log('  Extraction-only estimate (wall - baseline spawn):');
    console.log(`    V1: p50=${fmt(v1ExStats.p50, 1)}ms  (95% CI: [${fmt(v1ExStats.ci95Low, 1)}, ${fmt(v1ExStats.ci95High, 1)}])`);
    console.log(`    V2: p50=${fmt(v2ExStats.p50, 1)}ms  (95% CI: [${fmt(v2ExStats.ci95Low, 1)}, ${fmt(v2ExStats.ci95High, 1)}])`);
    console.log(`    Note: V1 baseline is 'spawn V1 --version' (${fmt(baselineV1.p50, 1)}ms).`);
    console.log(`          V2 baseline is 'spawn node -e \"\"' (${fmt(baselineNode.p50, 1)}ms) — UNDERESTIMATES`);
    console.log(`          V2's startup cost because WASM init + grammar load only happen when indexer runs.`);
    console.log();

    allResults.workloads.push({
      name: wl.name, desc: wl.desc, target: wl.target, expectParallel: wl.expectParallel,
      v1: { time: v1TimeStats, rss: v1RssStats, nodes: v1NodeCounts, edges: v1EdgeCounts, rawTimes: v1Times },
      v2: {
        time: v2TimeStats,
        rss: v2RssStats,
        nodes: v2NodeCounts,
        edges: v2EdgeCounts,
        files: [...new Set(v2Measured.map(r => r.files))],
        parallel: [...new Set(v2Measured.map(r => r.parallel))],
        rawTimes: v2Times,
      },
      mannWhitney: mwu, cliffsDelta: delta,
      extractionOnly: { v1: v1ExStats, v2: v2ExStats },
    });
  }

  writeFileSync(RESULTS_PATH, JSON.stringify(allResults, null, 2));
  console.log('─'.repeat(80));
  console.log(`  Full JSON results: ${RESULTS_PATH}`);
  console.log('─'.repeat(80));

  if (benchmarkErrors.length > 0 || allResults.workloads.length !== workloads.length) {
    throw new Error(
      `benchmark incomplete: ${benchmarkErrors.length} error(s), `
      + `${allResults.workloads.length}/${workloads.length} workloads analysed`,
    );
  }

  console.log('  BENCHMARK PASSED — every workload produced complete, stable evidence');
}

try {
  main();
} catch (error: unknown) {
  console.error(`FATAL: ${errorMessage(error)}`);
  process.exitCode = 1;
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}
