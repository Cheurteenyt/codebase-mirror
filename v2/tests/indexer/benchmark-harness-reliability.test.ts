import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findExecutableOnPath,
  parseV2ParallelMode,
  resolveBenchmarkResultsPath,
  validateWorkloadCompleteness,
  type BenchmarkObservation,
} from '../../scripts/rigorous-benchmark-r78-helpers.js';

const V2_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TEMP_ROOT = resolve(tmpdir());
const temporaryDirectories: string[] = [];

function observation(overrides: Partial<BenchmarkObservation> = {}): BenchmarkObservation {
  return {
    peakRssKb: 1024,
    nodes: 10,
    edges: 20,
    files: 5,
    parallel: true,
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    const resolvedDirectory = resolve(directory);
    if (!resolvedDirectory.startsWith(`${TEMP_ROOT}${sep}`)) {
      throw new Error(`Refusing to remove non-temporary test directory: ${resolvedDirectory}`);
    }
    rmSync(resolvedDirectory, { recursive: true, force: true });
  }
});

describe('benchmark harness reliability', () => {
  it('parses parallel, single-threaded, and malformed V2 summaries distinctly', () => {
    expect(parseV2ParallelMode('  Files indexed:   42\n  Parallel:        4 workers\n')).toBe(true);
    expect(parseV2ParallelMode('  Files indexed:   12\n  Errors:          0\n')).toBe(false);
    expect(parseV2ParallelMode('index command exited without a result summary')).toBeNull();
  });

  it('accepts only complete, stable observations with the expected execution mode', () => {
    expect(validateWorkloadCompleteness({
      workload: 'SMALL',
      expectedRuns: 2,
      expectParallel: true,
      v1: [observation({ parallel: null }), observation({ parallel: null })],
      v2: [observation(), observation()],
    })).toEqual([]);
  });

  it('fails closed for missing runs, unstable counts, and a parallel-mode mismatch', () => {
    const errors = validateWorkloadCompleteness({
      workload: 'SMALL',
      expectedRuns: 2,
      expectParallel: true,
      v1: [observation({ parallel: null, peakRssKb: 0 })],
      v2: [
        observation({ nodes: 10, parallel: false }),
        observation({ nodes: 11, parallel: false }),
      ],
    });

    expect(errors).toContain('SMALL: expected 2 successful V1 runs, got 1');
    expect(errors).toContain('SMALL: V1 peak RSS is missing or zero');
    expect(errors).toContain('SMALL: V2 nodes count changed between measured runs');
    expect(errors).toContain('SMALL: V2 expectParallel=true was not respected');
  });

  it('refuses comparisons that did not index the same stable file workload', () => {
    const errors = validateWorkloadCompleteness({
      workload: 'LARGE',
      expectedRuns: 2,
      expectParallel: true,
      v1: [
        observation({ parallel: null, files: 4 }),
        observation({ parallel: null, files: 5 }),
      ],
      v2: [observation({ files: 6 }), observation({ files: 6 })],
    });

    expect(errors).toContain('LARGE: V1 indexed-file count changed between measured runs');
    expect(errors).toContain('LARGE: discovery coverage differs (V1=4 files, V2=6 files)');
  });

  it('resolves PATH executables without invoking which or where', () => {
    const directory = mkdtempSync(join(tmpdir(), 'r78-path-'));
    temporaryDirectories.push(directory);
    const platform = process.platform === 'win32' ? 'win32' : 'linux';
    const extension = platform === 'win32' ? '.EXE' : '';
    const executable = join(directory, `benchmark-tool${extension}`);
    writeFileSync(executable, 'fixture');
    if (platform !== 'win32') chmodSync(executable, 0o755);

    expect(findExecutableOnPath('benchmark-tool', {
      platform,
      pathValue: directory,
      pathExtValue: '.EXE',
    })).toBe(executable);
  });

  it('keeps result output repository-relative unless explicitly overridden', () => {
    const scriptsDirectory = join(V2_ROOT, 'scripts');
    expect(resolveBenchmarkResultsPath(scriptsDirectory)).toBe(
      join(scriptsDirectory, 'rigorous-benchmark-r78-results.json'),
    );
    expect(resolveBenchmarkResultsPath(scriptsDirectory, './custom-r78.json')).toBe(
      resolve('./custom-r78.json'),
    );
  });

  it('benchmarks the production bulk reader and preserves fast discovery parity', () => {
    const microbenchmark = readFileSync(join(V2_ROOT, 'scripts', 'benchmark.ts'), 'utf-8');
    const rigorous = readFileSync(join(V2_ROOT, 'scripts', 'rigorous-benchmark-r78.ts'), 'utf-8');
    const runner = readFileSync(join(V2_ROOT, 'scripts', 'r78-runner.py'), 'utf-8');

    expect(microbenchmark).toContain('codeReader.getBulkNodeDegrees(chunk100)');
    expect(microbenchmark).toContain('codeReader.getBulkNodeDegrees(chunk500)');
    expect(microbenchmark).toContain('codeReader.getBulkEdges(chunk100)');
    expect(microbenchmark).not.toContain('stmtBulkDeg100_tgt');
    expect(microbenchmark).not.toContain('stmtBulkEdges100_out');
    expect(rigorous).toMatch(/'--discovery-mode',\s*'fast'/);
    expect(rigorous).not.toContain('/home/z/my-project/work/');
    expect(rigorous).not.toContain('execSync(');
    expect(runner).toContain("if system == 'Windows':");
    expect(runner).toContain('PeakWorkingSetSize');
    expect(runner).toContain("if system == 'Darwin':");
    expect(runner).toContain('resource.RUSAGE_CHILDREN');
    expect(runner).toContain("['ps', '-o', 'rss=', '-p', str(pid)]");
    expect(runner).toContain('CBM_RUN_TIMEOUT_MS');
    expect(runner).toContain('os.killpg');
    expect(runner).toContain("['taskkill', '/PID', str(proc.pid), '/T', '/F']");
  });
});
