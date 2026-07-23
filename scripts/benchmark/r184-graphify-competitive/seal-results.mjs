#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256File, stable, writeJsonExclusive } from './core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const spec = JSON.parse(readFileSync(join(here, 'spec.json'), 'utf8'));

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2).replaceAll('-', '_');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function assertExternal(path) {
  const rel = relative(repoRoot, path);
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`))) {
    throw new Error(`Sealed evidence must stay outside the checkout: ${path}`);
  }
}

function inventory(root, role, exclusions = new Set()) {
  const files = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const rel = relative(root, child).replaceAll('\\', '/');
      if (exclusions.has(rel)) continue;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        const stat = statSync(child);
        files.push({
          role,
          path: rel,
          bytes: stat.size,
          sha256: sha256File(child),
        });
      }
    }
  }
  walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function findFiles(root, predicate) {
  const matches = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && predicate(child)) matches.push(child);
    }
  }
  walk(root);
  return matches;
}

function gitFileAt(revision, path) {
  return execFileSync(
    'git',
    ['show', `${revision}:${path}`],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true },
  );
}

const options = parseArgs(process.argv.slice(2));
for (const required of ['lab_root', 'phase', 'prereg_sha']) {
  if (!options[required]) throw new Error(`Missing --${required.replaceAll('_', '-')}`);
}
if (!['baseline', 'postfix'].includes(options.phase)) {
  throw new Error('--phase must be baseline or postfix');
}
if (!/^[0-9a-f]{40}$/u.test(options.prereg_sha)) {
  throw new Error('--prereg-sha must be a full 40-character Git SHA');
}
const labRoot = resolve(options.lab_root);
assertExternal(labRoot);
const roots = {
  index_runs: join(labRoot, 'state', 'index-runs', options.phase),
  query_preparation: join(labRoot, 'state', 'query-preparation', options.phase),
  query_results: join(labRoot, 'results', 'query', options.phase),
  phase_results: join(labRoot, 'results', options.phase),
  vaults: join(labRoot, 'vaults', options.phase),
};
for (const [role, path] of Object.entries(roots)) {
  if (!existsSync(path)) throw new Error(`Missing ${role} evidence root: ${path}`);
}

const phaseManifestPath = join(roots.phase_results, 'result-manifest.json');
const sealPath = join(roots.phase_results, `${options.phase}-seal.json`);
if (existsSync(phaseManifestPath) || existsSync(sealPath)) {
  throw new Error(`Refusing to overwrite an existing ${options.phase} seal`);
}

const indexCold = findFiles(roots.index_runs, (path) => path.endsWith(`${sep}cold.json`));
const indexNoChange = findFiles(roots.index_runs, (path) => path.endsWith(`${sep}nochange.json`));
const indexMutation = findFiles(roots.index_runs, (path) => path.endsWith(`${sep}mutation.json`));
const expectedIndexRuns = spec.corpus.length * 2 * 4;
if (indexCold.length !== expectedIndexRuns || indexNoChange.length !== expectedIndexRuns) {
  throw new Error(
    `Incomplete index matrix: cold=${indexCold.length}, nochange=${indexNoChange.length}, `
    + `expected=${expectedIndexRuns} each`,
  );
}
if (indexMutation.length !== 2) {
  throw new Error(`Incomplete registered mutation matrix: ${indexMutation.length}/2`);
}

const queryMetadata = findFiles(
  roots.query_results,
  (path) => path.endsWith('.meta.json'),
);
const expectedQueryCells = Object.keys(spec.arms).length
  * (spec.repetitions.cold_one_shot + spec.repetitions.warm_continuous)
  * spec.tasks.length;
if (queryMetadata.length !== expectedQueryCells) {
  throw new Error(`Incomplete query matrix: ${queryMetadata.length}/${expectedQueryCells}`);
}

const visualSamplesPath = join(roots.phase_results, 'visual', 'unblinded-samples.json');
if (!existsSync(visualSamplesPath)) throw new Error(`Missing visual samples: ${visualSamplesPath}`);
const visualSamples = JSON.parse(readFileSync(visualSamplesPath, 'utf8'));
const visualProtocol = JSON.parse(readFileSync(join(here, 'visual-tasks.json'), 'utf8'));
const visualRuns = visualProtocol.repetitions.cold_fresh_browser_context;
const expectedVisualSamples = tasksSpecCount() * 2 * 2 * visualRuns;
if (!Array.isArray(visualSamples) || visualSamples.length !== expectedVisualSamples) {
  throw new Error(
    `Incomplete visual matrix: ${Array.isArray(visualSamples) ? visualSamples.length : 'invalid'}`
    + `/${expectedVisualSamples}`,
  );
}

const preregFiles = [
  'docs/performance/GRAPHIFY_COMPETITIVE_PROTOCOL.md',
  'scripts/benchmark/r184-graphify-competitive/spec.json',
  'scripts/benchmark/r184-graphify-competitive/visual-tasks.json',
];
const preregistration = preregFiles.map((path) => {
  const committed = gitFileAt(options.prereg_sha, path);
  const working = readFileSync(join(repoRoot, path), 'utf8');
  if (committed !== working) {
    throw new Error(`Frozen preregistration file differs from ${options.prereg_sha}: ${path}`);
  }
  return {
    path,
    content_sha256: sha256File(join(repoRoot, path)),
  };
});

const entries = [
  ...inventory(roots.index_runs, 'index-runs'),
  ...inventory(roots.query_preparation, 'query-preparation'),
  ...inventory(roots.query_results, 'query-results'),
  ...inventory(
    roots.phase_results,
    'phase-results',
    new Set(['result-manifest.json', `${options.phase}-seal.json`]),
  ),
  ...inventory(roots.vaults, 'vaults'),
].sort((left, right) => (
  `${left.role}\0${left.path}`.localeCompare(`${right.role}\0${right.path}`)
));
const manifest = {
  schema_version: 1,
  benchmark_id: spec.benchmark_id,
  phase: options.phase,
  preregistration_git_sha: options.prereg_sha,
  roots: Object.fromEntries(Object.entries(roots).map(([role, path]) => [
    role,
    relative(labRoot, path).replaceAll('\\', '/'),
  ])),
  completeness: {
    index_cold: indexCold.length,
    index_nochange: indexNoChange.length,
    index_mutation: indexMutation.length,
    query_cells: queryMetadata.length,
    visual_samples: visualSamples.length,
  },
  files: entries,
};
writeJsonExclusive(phaseManifestPath, manifest);
const manifestSha = sha256File(phaseManifestPath);
const seal = {
  schema_version: 1,
  benchmark_id: spec.benchmark_id,
  phase: options.phase,
  sealed_at_utc: new Date().toISOString(),
  preregistration_git_sha: options.prereg_sha,
  preregistration,
  result_manifest_role: relative(labRoot, phaseManifestPath).replaceAll('\\', '/'),
  result_manifest_sha256: manifestSha,
  file_count: entries.length,
  total_bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  seal_payload_sha256: null,
};
seal.seal_payload_sha256 = createHash('sha256')
  .update(JSON.stringify(stable(seal)))
  .digest('hex');
writeJsonExclusive(sealPath, seal);
console.log(sealPath);

function tasksSpecCount() {
  const visual = JSON.parse(readFileSync(join(here, 'visual-tasks.json'), 'utf8'));
  return visual.targets.length * visual.viewports.length;
}
