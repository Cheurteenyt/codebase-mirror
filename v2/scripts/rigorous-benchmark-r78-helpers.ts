import { accessSync, constants, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';

export interface BenchmarkObservation {
  peakRssKb: number;
  nodes: number;
  edges: number;
  files: number;
  parallel: boolean | null;
}

export interface WorkloadCompletenessInput {
  workload: string;
  expectedRuns: number;
  expectParallel: boolean;
  v1: BenchmarkObservation[];
  v2: BenchmarkObservation[];
}

/**
 * Parse the V2 CLI's explicit parallel marker. Absence is only accepted as
 * single-threaded when the normal result summary is present; otherwise the
 * execution mode is unknown and the benchmark must fail closed.
 */
export function parseV2ParallelMode(output: string): boolean | null {
  if (/^\s*Parallel:\s+\d+\s+workers\s*$/m.test(output)) return true;
  if (/^\s*Files indexed:\s+\d+\s*$/m.test(output)) return false;
  return null;
}

function unstableMetric(
  observations: BenchmarkObservation[],
  field: 'nodes' | 'edges' | 'files',
): boolean {
  return new Set(observations.map(observation => observation[field])).size !== 1;
}

/** Return every reason why a workload is unsafe to analyse. */
export function validateWorkloadCompleteness(input: WorkloadCompletenessInput): string[] {
  const errors: string[] = [];
  const prefix = input.workload;

  if (input.v1.length !== input.expectedRuns) {
    errors.push(`${prefix}: expected ${input.expectedRuns} successful V1 runs, got ${input.v1.length}`);
  }
  if (input.v2.length !== input.expectedRuns) {
    errors.push(`${prefix}: expected ${input.expectedRuns} successful V2 runs, got ${input.v2.length}`);
  }

  if (input.v1.some(run => run.nodes <= 0)) {
    errors.push(`${prefix}: V1 node count is missing or zero`);
  }
  if (input.v2.some(run => run.nodes <= 0)) {
    errors.push(`${prefix}: V2 node count is missing or zero`);
  }
  if (input.v2.some(run => run.files <= 0)) {
    errors.push(`${prefix}: V2 indexed-file count is missing or zero`);
  }
  if (input.v1.some(run => run.files <= 0)) {
    errors.push(`${prefix}: V1 indexed-file count is missing or zero`);
  }
  if (input.v1.some(run => run.peakRssKb <= 0)) {
    errors.push(`${prefix}: V1 peak RSS is missing or zero`);
  }
  if (input.v2.some(run => run.peakRssKb <= 0)) {
    errors.push(`${prefix}: V2 peak RSS is missing or zero`);
  }

  for (const field of ['nodes', 'edges'] as const) {
    if (input.v1.length > 0 && unstableMetric(input.v1, field)) {
      errors.push(`${prefix}: V1 ${field} count changed between measured runs`);
    }
    if (input.v2.length > 0 && unstableMetric(input.v2, field)) {
      errors.push(`${prefix}: V2 ${field} count changed between measured runs`);
    }
  }
  if (input.v2.length > 0 && unstableMetric(input.v2, 'files')) {
    errors.push(`${prefix}: V2 indexed-file count changed between measured runs`);
  }
  if (input.v1.length > 0 && unstableMetric(input.v1, 'files')) {
    errors.push(`${prefix}: V1 indexed-file count changed between measured runs`);
  }
  if (
    input.v1.length > 0
    && input.v2.length > 0
    && input.v1[0].files !== input.v2[0].files
  ) {
    errors.push(
      `${prefix}: discovery coverage differs (V1=${input.v1[0].files} files, V2=${input.v2[0].files} files)`,
    );
  }

  if (input.v2.some(run => run.parallel === null)) {
    errors.push(`${prefix}: V2 execution mode could not be parsed`);
  } else if (input.v2.some(run => run.parallel !== input.expectParallel)) {
    errors.push(`${prefix}: V2 expectParallel=${input.expectParallel} was not respected`);
  }

  return errors;
}

/** Resolve a command without invoking a platform shell (`which`/`where`). */
export function findExecutableOnPath(
  command: string,
  options: {
    pathValue?: string;
    pathExtValue?: string;
    platform?: NodeJS.Platform;
    cwd?: string;
  } = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const hasPathSeparator = command.includes('/') || command.includes('\\');
  if (hasPathSeparator || isAbsolute(command)) {
    const candidate = resolve(cwd, command);
    return isExecutableFile(candidate, platform) ? candidate : null;
  }

  const pathValue = options.pathValue ?? process.env.PATH ?? '';
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const directories = pathValue
    .split(pathDelimiter)
    .map(entry => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  const extensions = platform === 'win32' && extname(command) === ''
    ? (options.pathExtValue ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .filter(Boolean)
    : [''];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveBenchmarkResultsPath(scriptDirectory: string, override?: string): string {
  return override
    ? resolve(override)
    : resolve(scriptDirectory, 'rigorous-benchmark-r78-results.json');
}
