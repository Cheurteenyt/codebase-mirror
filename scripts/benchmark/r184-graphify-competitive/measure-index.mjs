#!/usr/bin/env node

import { execFile, execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mutateExistingFixture,
  sha256File,
  writeJsonExclusive,
} from './core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const spec = JSON.parse(readFileSync(join(here, 'spec.json'), 'utf8'));
const requireFromV2 = createRequire(join(repoRoot, 'v2', 'package.json'));
const Database = requireFromV2('better-sqlite3');

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replaceAll('-', '_');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function assertExternal(labRoot) {
  const rel = relative(repoRoot, labRoot);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')) {
    throw new Error(`Lab root must be outside the Ariad checkout: ${labRoot}`);
  }
}

function copySource(source, destination) {
  if (existsSync(destination)) throw new Error(`Refusing to overwrite source copy: ${destination}`);
  cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    filter(path) {
      const rel = relative(source, path).replaceAll('\\', '/');
      if (!rel) return true;
      return !(
        rel === '.git'
        || rel.startsWith('.git/')
        || rel === 'node_modules'
        || rel.startsWith('node_modules/')
        || rel === 'graphify-out'
        || rel.startsWith('graphify-out/')
        || rel === 'dist'
        || rel.startsWith('dist/')
      );
    },
  });
}

function directoryStats(root, excludeGenerated = false) {
  let files = 0;
  let bytes = 0;
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (excludeGenerated && entry.name === 'graphify-out') continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        files += 1;
        bytes += statSync(child).size;
      }
    }
  }
  walk(root);
  return { files, bytes };
}

function graphifyStats(graphPath) {
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  return {
    nodes: Array.isArray(graph.nodes) ? graph.nodes.length : null,
    relationships: Array.isArray(graph.links)
      ? graph.links.length
      : Array.isArray(graph.edges) ? graph.edges.length : null,
    directed: graph.directed ?? null,
    multigraph: graph.multigraph ?? null,
  };
}

function ariadStats(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return {
      nodes: db.prepare('SELECT COUNT(*) AS count FROM nodes').get().count,
      relationships: db.prepare('SELECT COUNT(*) AS count FROM edges').get().count,
      files: db.prepare("SELECT COUNT(*) AS count FROM nodes WHERE label = 'File'").get().count,
    };
  } finally {
    db.close();
  }
}

function graphifyEnvironment(labRoot, runRoot) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(OPENAI|ANTHROPIC|KIMI|DEEPSEEK|GEMINI|GOOGLE)_/.test(name)) delete env[name];
  }
  env.HOME = join(runRoot, 'home');
  env.USERPROFILE = env.HOME;
  env.XDG_CACHE_HOME = join(runRoot, 'cache');
  env.PYTHONNOUSERSITE = '1';
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.XDG_CACHE_HOME, { recursive: true });
  const python = process.platform === 'win32'
    ? join(labRoot, 'tools', 'graphify-0.9.25', '.venv', 'Scripts', 'python.exe')
    : join(labRoot, 'tools', 'graphify-0.9.25', '.venv', 'bin', 'python');
  const basePython = process.platform === 'win32'
    ? execFileSync(
        python,
        ['-c', 'import sys; print(sys._base_executable)'],
        { env, encoding: 'utf8', windowsHide: true },
      ).trim()
    : null;
  return { env, python, basePython };
}

function ariadEnvironment(runRoot) {
  const env = {
    ...process.env,
    XDG_CACHE_HOME: join(runRoot, 'cache'),
  };
  mkdirSync(env.XDG_CACHE_HOME, { recursive: true });
  return env;
}

function startMemorySampler(pid, aggregateExecutables = []) {
  if (process.platform === 'win32') {
    const executableClause = aggregateExecutables.length > 0
      ? [
          `$aggregatePaths = @(${aggregateExecutables
            .map((path) => `'${path.replaceAll("'", "''")}'`)
            .join(',')})`,
          '$current = [int64](Get-Process -Name python -ErrorAction SilentlyContinue | Where-Object { $aggregatePaths -contains $_.Path } | Measure-Object WorkingSet64 -Sum).Sum',
        ]
      : ['$current = [int64]$process.WorkingSet64'];
    const script = [
      '$peak = 0',
      '$samples = 0',
      `while ($process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue) {`,
      ...executableClause.map((line) => `  ${line}`),
      '  $peak = [Math]::Max($peak, [int64]$current)',
      '  $samples += 1',
      '  Start-Sleep -Milliseconds 100',
      '}',
      'Write-Output "$peak,$samples"',
    ].join('; ');
    return new Promise((resolveSample) => {
      const sampler = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let output = '';
      sampler.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
      sampler.on('error', () => resolveSample({ peak: null, samples: 0 }));
      sampler.on('exit', () => {
        const match = output.trim().match(/(\d+),(\d+)$/);
        resolveSample(match
          ? { peak: Number.parseInt(match[1], 10), samples: Number.parseInt(match[2], 10) }
          : { peak: null, samples: 0 });
      });
    });
  }
  return (async () => {
    let peak = 0;
    let samples = 0;
    while (true) {
      try {
        const status = readFileSync(`/proc/${pid}/status`, 'utf8');
        const kib = status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1];
        if (kib) {
          peak = Math.max(peak, Number.parseInt(kib, 10) * 1024);
          samples += 1;
        }
      } catch {
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    return { peak: samples ? peak : null, samples };
  })();
}

function assertNoCompetingProcesses(executablePaths) {
  if (process.platform !== 'win32' || executablePaths.length === 0) return;
  const quoted = executablePaths
    .map((path) => `'${path.replaceAll("'", "''")}'`)
    .join(',');
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$paths = @(${quoted}); Get-Process -Name python -ErrorAction SilentlyContinue `
        + `| Where-Object { $paths -contains $_.Path } | ForEach-Object { $_.Id }; exit 0`,
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
  if (output) {
    throw new Error(
      `Refusing an ambiguous Graphify memory sample; matching Python PID(s) already run: ${output}`,
    );
  }
}

async function runMeasured(command, args, {
  cwd,
  env,
  stdoutPath,
  stderrPath,
  aggregateExecutables = [],
}) {
  assertNoCompetingProcesses(aggregateExecutables);
  const stdout = createWriteStream(stdoutPath, { flags: 'wx' });
  const stderr = createWriteStream(stderrPath, { flags: 'wx' });
  const closed = Promise.all([
    new Promise((resolveClose, reject) => {
      stdout.on('close', resolveClose);
      stdout.on('error', reject);
    }),
    new Promise((resolveClose, reject) => {
      stderr.on('close', resolveClose);
      stderr.on('error', reject);
    }),
  ]);
  const startedAt = new Date();
  const start = process.hrtime.bigint();
  const child = execFile(command, args, {
    cwd,
    env,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);

  const sampler = startMemorySampler(child.pid, aggregateExecutables);
  const exit = await new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolveExit({ code: code ?? 1, signal }));
  });
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
  const [memory] = await Promise.all([sampler, closed]);
  return {
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    wall_ms: wallMs,
    exit_code: exit.code,
    signal: exit.signal,
    peak_working_set_bytes: memory.peak,
    memory_samples: memory.samples,
    memory_sample_interval_ms: 100,
    memory_scope: aggregateExecutables.length > 0
      ? 'sum of isolated virtualenv redirector and base-interpreter processes by exact executable path'
      : 'root process working set',
  };
}

const options = parseArgs(process.argv.slice(2));
for (const required of ['lab_root', 'phase', 'product', 'target', 'operation', 'repetition']) {
  if (!options[required]) throw new Error(`Missing --${required.replaceAll('_', '-')}`);
}
const labRoot = resolve(options.lab_root);
assertExternal(labRoot);
if (!['baseline', 'postfix', 'preflight'].includes(options.phase)) {
  throw new Error('--phase must be baseline, postfix, or preflight');
}
if (!['graphify', 'ariad'].includes(options.product)) {
  throw new Error('--product must be graphify or ariad');
}
if (!['fixture', 'p-limit', 'zod', 'fastapi'].includes(options.target)) {
  throw new Error('--target must be fixture, p-limit, zod, or fastapi');
}
if (!['cold', 'nochange', 'mutation'].includes(options.operation)) {
  throw new Error('--operation must be cold, nochange, or mutation');
}
const repetition = Number.parseInt(options.repetition, 10);
if (!Number.isInteger(repetition) || repetition < 1 || repetition > 4) {
  throw new Error('--repetition must be 1..4');
}
if (options.operation === 'mutation' && (options.target !== 'fixture' || repetition !== 1)) {
  throw new Error('The registered mutation is only valid for fixture repetition 1');
}

const runRoot = join(
  labRoot,
  'state',
  'index-runs',
  options.phase,
  options.product,
  options.target,
  `r${repetition}`,
);
const source = join(runRoot, 'source');
const sourceOrigin = join(labRoot, 'targets', options.target);
const rawDir = join(runRoot, 'raw');
mkdirSync(rawDir, { recursive: true });
if (options.operation === 'cold') {
  copySource(sourceOrigin, source);
} else if (!existsSync(source)) {
  throw new Error(`Run cold first; source copy is missing: ${source}`);
}
if (options.operation === 'mutation') {
  mutateExistingFixture({
    destination: source,
    mutationRoot: join(here, 'mutation'),
  });
}

const project = `r184-${options.phase}-${options.target}-r${repetition}`;
let command;
let args;
let env;
let artifactPath;
let aggregateExecutables = [];
if (options.product === 'graphify') {
  const runtime = graphifyEnvironment(labRoot, runRoot);
  command = runtime.python;
  env = runtime.env;
  aggregateExecutables = [runtime.python, runtime.basePython].filter(Boolean);
  if (options.operation === 'cold') {
    args = ['-m', 'graphify', 'extract', source, '--code-only'];
  } else if (options.operation === 'nochange') {
    args = ['-m', 'graphify', 'update', source];
  } else {
    args = ['-m', 'graphify', 'update', source, '--force'];
  }
  artifactPath = join(source, 'graphify-out', 'graph.json');
} else {
  command = process.execPath;
  env = ariadEnvironment(runRoot);
  args = [
    join(repoRoot, 'v2', 'dist', 'cli', 'index.js'),
    'index',
    '--project', project,
    '--root', source,
  ];
  if (options.operation !== 'cold') args.push('--incremental');
  artifactPath = join(runRoot, 'cache', 'codebase-memory-mcp', `${project}.db`);
}

const stem = join(rawDir, options.operation);
const stdoutPath = `${stem}.stdout.txt`;
const stderrPath = `${stem}.stderr.txt`;
const measured = await runMeasured(command, args, {
  cwd: source,
  env,
  stdoutPath,
  stderrPath,
  aggregateExecutables,
});

const metadataPath = resolve(
  options.output ?? join(runRoot, `${options.operation}.json`),
);
const artifactExists = existsSync(artifactPath);
const result = {
  schema_version: 1,
  benchmark_id: spec.benchmark_id,
  phase: options.phase,
  product: options.product,
  target: options.target,
  operation: options.operation,
  repetition,
  project: options.product === 'ariad' ? project : null,
  source_role: `${options.target}-${options.operation}-copy`,
  source_inventory: directoryStats(source, true),
  command,
  arguments: args,
  environment: {
    XDG_CACHE_HOME_role: relative(labRoot, env.XDG_CACHE_HOME ?? '').replaceAll('\\', '/'),
    HOME_role: env.HOME ? relative(labRoot, env.HOME).replaceAll('\\', '/') : null,
    external_model_variables_removed: options.product === 'graphify',
  },
  ...measured,
  artifact: {
    role: options.product === 'graphify' ? 'graphify-graph-json' : 'ariad-sqlite',
    exists: artifactExists,
    bytes: artifactExists ? statSync(artifactPath).size : null,
    sha256: artifactExists ? sha256File(artifactPath) : null,
    stats: artifactExists
      ? options.product === 'graphify'
        ? graphifyStats(artifactPath)
        : ariadStats(artifactPath)
      : null,
  },
  raw: {
    stdout: relative(labRoot, stdoutPath).replaceAll('\\', '/'),
    stderr: relative(labRoot, stderrPath).replaceAll('\\', '/'),
    stdout_sha256: sha256File(stdoutPath),
    stderr_sha256: sha256File(stderrPath),
  },
};
writeJsonExclusive(metadataPath, result);
console.log(metadataPath);
if (measured.exit_code !== 0) {
  throw new Error(`${options.product} ${options.operation} exited ${measured.exit_code}; artifacts retained`);
}
if (!artifactExists) throw new Error(`Expected artifact is missing: ${artifactPath}`);
