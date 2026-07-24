#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256File, writeJsonExclusive } from './core.mjs';

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

function graphifyPython(labRoot) {
  return process.platform === 'win32'
    ? join(labRoot, 'tools', 'graphify-0.9.25', '.venv', 'Scripts', 'python.exe')
    : join(labRoot, 'tools', 'graphify-0.9.25', '.venv', 'bin', 'python');
}

function graphifyEnv(labRoot, phase) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(OPENAI|ANTHROPIC|KIMI|DEEPSEEK|GEMINI|GOOGLE)_/.test(name)) delete env[name];
  }
  env.HOME = join(labRoot, 'state', 'query-preparation', phase, 'graphify-home');
  env.USERPROFILE = env.HOME;
  env.XDG_CACHE_HOME = join(labRoot, 'state', 'query-preparation', phase, 'graphify-cache');
  env.PYTHONNOUSERSITE = '1';
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.XDG_CACHE_HOME, { recursive: true });
  return env;
}

function runtime(labRoot, phase, target) {
  const mutated = target === 'fixture-mutated';
  const targetId = mutated ? 'fixture' : target;
  const repetition = mutated ? 1 : 4;
  const graphifyRun = join(
    labRoot, 'state', 'index-runs', phase, 'graphify', targetId, `r${repetition}`,
  );
  const ariadRun = join(
    labRoot, 'state', 'index-runs', phase, 'ariad', targetId, `r${repetition}`,
  );
  return {
    graphifyGraph: join(graphifyRun, 'source', 'graphify-out', 'graph.json'),
    graphifyHtml: join(graphifyRun, 'source', 'graphify-out', 'graph.html'),
    ariadCache: join(ariadRun, 'cache'),
    ariadProject: `r184-${phase}-${targetId}-r${repetition}`,
  };
}

function command(executable, args, options) {
  return execFileSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function copyHumanNotes(sourceRoot, destinationRoot) {
  const copied = [];
  for (const entry of [
    ['docs', 'ADR', 'ADR-007-durable-delivery.md'],
    ['docs', 'Risks', 'RISK-004-retry-boundary.md'],
  ]) {
    const source = join(sourceRoot, ...entry);
    const destination = join(destinationRoot, 'Human', ...entry.slice(1));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { errorOnExist: true });
    copied.push(destination);
  }
  return copied;
}

function codeNodeIds(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const lookup = db.prepare(`
      SELECT id, name, file_path
      FROM nodes
      WHERE name = ?
      ORDER BY file_path, start_line, id
    `);
    const commit = lookup.all('commitDelivery')
      .find((row) => row.file_path.replaceAll('\\', '/').endsWith('src/delivery/publish.ts'));
    const run = lookup.all('runPipeline')
      .find((row) => row.file_path.replaceAll('\\', '/').endsWith('src/orchestration/pipeline.ts'));
    if (!commit || !run) throw new Error('Unable to resolve fixture code-node IDs');
    return { commit: commit.id, run: run.id };
  } finally {
    db.close();
  }
}

function writeLinkedAriadVault(sourceRoot, vaultRoot, ids) {
  const notes = [
    {
      source: join(sourceRoot, 'docs', 'ADR', 'ADR-007-durable-delivery.md'),
      destination: join(vaultRoot, 'ADR', 'ADR-007-durable-delivery.md'),
      ids: [ids.commit, ids.run],
    },
    {
      source: join(sourceRoot, 'docs', 'Risks', 'RISK-004-retry-boundary.md'),
      destination: join(vaultRoot, 'Architecture', 'RISK-004-retry-boundary.md'),
      ids: [ids.commit],
    },
  ];
  for (const note of notes) {
    const content = readFileSync(note.source, 'utf8');
    const linked = content.replace(
      'status: active\n',
      `status: active\ncbm_node_ids: [${note.ids.join(', ')}]\n`,
    );
    if (linked === content) throw new Error(`Unable to inject code links into ${note.source}`);
    mkdirSync(dirname(note.destination), { recursive: true });
    writeFileSync(note.destination, linked, { encoding: 'utf8', flag: 'wx' });
  }
  return notes.map((note) => note.destination);
}

function directoryInventory(root) {
  let files = 0;
  let bytes = 0;
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
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

const options = parseArgs(process.argv.slice(2));
for (const required of ['lab_root', 'phase', 'output']) {
  if (!options[required]) throw new Error(`Missing --${required.replaceAll('_', '-')}`);
}
if (!['baseline', 'postfix', 'preflight'].includes(options.phase)) {
  throw new Error('--phase must be baseline, postfix, or preflight');
}
const labRoot = resolve(options.lab_root);
const python = graphifyPython(labRoot);
const env = graphifyEnv(labRoot, options.phase);
const sourceFixture = join(labRoot, 'targets', 'fixture');
const prepared = [];

for (const target of ['fixture', 'p-limit', 'zod', 'fastapi', 'fixture-mutated']) {
  const state = runtime(labRoot, options.phase, target);
  if (!existsSync(state.graphifyGraph)) {
    throw new Error(`Missing Graphify graph for ${target}: ${state.graphifyGraph}`);
  }
  command(
    python,
    ['-m', 'graphify', 'export', 'html', '--graph', state.graphifyGraph],
    { cwd: dirname(state.graphifyGraph), env },
  );
  if (!existsSync(state.graphifyHtml)) {
    throw new Error(`Graphify HTML export missing for ${target}`);
  }
  const vault = join(labRoot, 'vaults', options.phase, target);
  if (existsSync(vault)) throw new Error(`Refusing to overwrite vault: ${vault}`);
  command(
    python,
    ['-m', 'graphify', 'export', 'obsidian', '--graph', state.graphifyGraph, '--dir', vault],
    { cwd: dirname(state.graphifyGraph), env },
  );
  const humanNotes = target.startsWith('fixture')
    ? copyHumanNotes(sourceFixture, vault)
    : [];
  prepared.push({
    target,
    graph_sha256: sha256File(state.graphifyGraph),
    html_sha256: sha256File(state.graphifyHtml),
    vault_inventory: directoryInventory(vault),
    human_note_sha256: humanNotes.map((path) => ({
      role: relative(vault, path).replaceAll('\\', '/'),
      sha256: sha256File(path),
    })),
  });
}

const fixtureState = runtime(labRoot, options.phase, 'fixture');
const ariadDb = join(
  fixtureState.ariadCache,
  'codebase-memory-mcp',
  `${fixtureState.ariadProject}.db`,
);
if (!existsSync(ariadDb)) throw new Error(`Missing Ariad fixture database: ${ariadDb}`);
const ids = codeNodeIds(ariadDb);
const ariadVault = join(labRoot, 'vaults', options.phase, 'ariad-linked-fixture');
if (existsSync(ariadVault)) throw new Error(`Refusing to overwrite Ariad vault: ${ariadVault}`);
const linkedNotes = writeLinkedAriadVault(sourceFixture, ariadVault, ids);
const importOutput = command(
  process.execPath,
  [
    join(repoRoot, 'v2', 'dist', 'cli', 'index.js'),
    'obsidian',
    'import',
    '--project', fixtureState.ariadProject,
    '--vault', ariadVault,
  ],
  {
    cwd: sourceFixture,
    env: { ...process.env, XDG_CACHE_HOME: fixtureState.ariadCache },
  },
);
const humanDb = join(
  fixtureState.ariadCache,
  'codebase-memory-mcp',
  `${fixtureState.ariadProject}.human.db`,
);
if (!existsSync(humanDb)) throw new Error('Ariad human-memory import did not create its database');

const result = {
  schema_version: 1,
  benchmark_id: spec.benchmark_id,
  phase: options.phase,
  generated_at_utc: new Date().toISOString(),
  graphify: prepared,
  ariad: {
    project: fixtureState.ariadProject,
    linked_code_node_roles: ['commitDelivery', 'runPipeline'],
    vault_inventory: directoryInventory(ariadVault),
    linked_note_sha256: linkedNotes.map((path) => ({
      role: relative(ariadVault, path).replaceAll('\\', '/'),
      sha256: sha256File(path),
    })),
    human_db_bytes: statSync(humanDb).size,
    human_db_sha256: sha256File(humanDb),
    import_output: importOutput.trim(),
  },
};
writeJsonExclusive(resolve(options.output), result);
console.log(resolve(options.output));
