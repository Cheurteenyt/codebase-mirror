#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256File, writeJsonExclusive } from './core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const spec = JSON.parse(readFileSync(join(here, 'spec.json'), 'utf8'));

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

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: options.env,
  }).trim();
}

function git(cwd, args) {
  return command('git', args, { cwd });
}

function commandVersion(commandName, moduleParts) {
  if (process.platform !== 'win32') return command(commandName, ['--version']);
  const located = command('where.exe', [`${commandName}.cmd`])
    .split(/\r?\n/)
    .find(Boolean);
  if (!located) throw new Error(`Unable to locate ${commandName}.cmd`);
  return command(process.execPath, [
    join(dirname(located), 'node_modules', ...moduleParts),
    '--version',
  ]);
}

function treeState(cwd, expectedSha) {
  const sha = git(cwd, ['rev-parse', 'HEAD']);
  const status = git(cwd, ['status', '--short']);
  if (sha !== expectedSha) {
    throw new Error(`${cwd} is ${sha}, expected ${expectedSha}`);
  }
  if (status) throw new Error(`${cwd} is dirty:\n${status}`);
  return { path_role: cwd.split(/[\\/]/).at(-1), head_sha: sha, status_short: status };
}

function directoryDigest(root) {
  const entries = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        entries.push({
          path: child.slice(root.length + 1).replaceAll('\\', '/'),
          sha256: sha256File(child),
        });
      }
    }
  }
  walk(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash('sha256');
  for (const entry of entries) hash.update(`${entry.path}\0${entry.sha256}\n`);
  return { files: entries.length, sha256: hash.digest('hex') };
}

const options = parseArgs(process.argv.slice(2));
for (const required of ['lab_root', 'output', 'phase', 'repetition', 'prereg_sha']) {
  if (!options[required]) throw new Error(`Missing --${required.replaceAll('_', '-')}`);
}
const labRoot = resolve(options.lab_root);
const graphifyPython = process.platform === 'win32'
  ? join(labRoot, 'tools', 'graphify-0.9.25', '.venv', 'Scripts', 'python.exe')
  : join(labRoot, 'tools', 'graphify-0.9.25', '.venv', 'bin', 'python');
const wheel = join(labRoot, 'downloads', spec.competitor.wheel);
if (!existsSync(graphifyPython)) throw new Error(`Missing Graphify Python: ${graphifyPython}`);
if (!existsSync(wheel)) throw new Error(`Missing pinned Graphify wheel: ${wheel}`);
const observedWheelHash = sha256File(wheel);
if (observedWheelHash !== spec.competitor.wheel_sha256) {
  throw new Error(`Graphify wheel hash ${observedWheelHash} does not match the frozen spec`);
}

const targets = Object.fromEntries(
  spec.corpus
    .filter((target) => target.commit)
    .map((target) => [
      target.id,
      treeState(join(labRoot, 'targets', target.id), target.commit),
    ]),
);
const committedFixture = join(repoRoot, 'v2', 'tests', 'fixtures', 'r184-competitive-lab');
const externalFixture = join(labRoot, 'targets', 'fixture');
const mutatedFixture = join(labRoot, 'targets', 'fixture-mutated');
for (const path of [committedFixture, externalFixture, mutatedFixture]) {
  if (!existsSync(path)) throw new Error(`Missing controlled corpus path: ${path}`);
}
const committedFixtureDigest = directoryDigest(committedFixture);
const externalFixtureDigest = directoryDigest(externalFixture);
if (committedFixtureDigest.sha256 !== externalFixtureDigest.sha256) {
  throw new Error('External controlled fixture differs from the preregistered repository fixture');
}
const repetition = Number.parseInt(options.repetition, 10);
if (!Number.isInteger(repetition) || repetition < 1) {
  throw new Error('--repetition must be a positive integer');
}

const repositoryStatus = git(repoRoot, ['status', '--short']);
const diffProbe = spawnSync('git', ['diff', '--quiet', '--'], {
  cwd: repoRoot,
  windowsHide: true,
});
if (![0, 1].includes(diffProbe.status)) {
  throw new Error(`Unable to inspect Ariad diff, git exited ${diffProbe.status}`);
}

const cpus = os.cpus();
const record = {
  schema_version: 1,
  benchmark_id: spec.benchmark_id,
  captured_at_utc: new Date().toISOString(),
  phase: options.phase,
  repetition,
  preregistration_sha: options.prereg_sha,
  repository: {
    head_sha: git(repoRoot, ['rev-parse', 'HEAD']),
    branch: git(repoRoot, ['branch', '--show-current']),
    origin_main_sha: git(repoRoot, ['rev-parse', 'origin/main']),
    status_short: repositoryStatus,
    content_diff_present: diffProbe.status === 1,
  },
  competitor: {
    version: spec.competitor.version,
    release_commit: spec.competitor.git_commit,
    wheel: spec.competitor.wheel,
    wheel_sha256: observedWheelHash,
    python_version: command(graphifyPython, ['--version']),
    graphify_version: command(graphifyPython, ['-m', 'graphify', '--version']),
    installed_packages: command(graphifyPython, ['-m', 'pip', 'freeze', '--all'])
      .split(/\r?\n/)
      .filter(Boolean),
  },
  corpus: targets,
  controlled_corpus: {
    fixture: externalFixtureDigest,
    fixture_mutated: directoryDigest(mutatedFixture),
  },
  operating_system: {
    platform: os.platform(),
    type: os.type(),
    release: os.release(),
    version: os.version(),
    architecture: os.arch(),
  },
  cpu: {
    model: cpus[0]?.model ?? 'unknown',
    logical_processors: cpus.length,
  },
  memory: {
    total_bytes: os.totalmem(),
  },
  runtime: {
    node: process.version,
    npm: commandVersion('npm', ['npm', 'bin', 'npm-cli.js']),
    codex: commandVersion('codex', ['@openai', 'codex', 'bin', 'codex.js']),
  },
  model: spec.query_model,
  external_backend_environment_presence: Object.fromEntries(
    Object.entries(process.env)
      .filter(([name]) => /^(OPENAI|ANTHROPIC|KIMI|DEEPSEEK|GEMINI|GOOGLE|OLLAMA)/.test(name))
      .map(([name, value]) => [name, Boolean(value)]),
  ),
};

writeJsonExclusive(resolve(options.output), record);
console.log(resolve(options.output));
