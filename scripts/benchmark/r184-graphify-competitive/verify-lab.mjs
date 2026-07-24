#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyRegisteredMutation, sha256File } from './core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const spec = JSON.parse(readFileSync(join(here, 'spec.json'), 'utf8'));
const labRoot = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node verify-lab.mjs <external-lab-root>');

const relativeToRepo = relative(repoRoot, labRoot);
if (
  relativeToRepo === ''
  || (!relativeToRepo.startsWith(`..${sep}`) && relativeToRepo !== '..' && !isAbsolute(relativeToRepo))
) {
  throw new Error(`Lab root must be outside the Ariad checkout: ${labRoot}`);
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function directoryDigest(root) {
  const entries = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        entries.push({
          path: relative(root, child).replaceAll('\\', '/'),
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

for (const target of spec.corpus.filter((entry) => entry.commit)) {
  const checkout = join(labRoot, 'targets', target.id);
  if (!existsSync(checkout)) throw new Error(`Missing target checkout: ${target.id}`);
  const sha = git(checkout, ['rev-parse', 'HEAD']);
  if (sha !== target.commit) {
    throw new Error(`${target.id} is ${sha}, expected ${target.commit}`);
  }
  const status = git(checkout, ['status', '--short']);
  if (status) throw new Error(`${target.id} target is dirty:\n${status}`);
}

const fixtureSource = join(repoRoot, 'v2', 'tests', 'fixtures', 'r184-competitive-lab');
const fixtureTarget = join(labRoot, 'targets', 'fixture');
const mutatedTarget = join(labRoot, 'targets', 'fixture-mutated');
for (const [role, path] of [
  ['committed controlled fixture', fixtureSource],
  ['external controlled fixture', fixtureTarget],
  ['external mutated fixture', mutatedTarget],
]) {
  if (!existsSync(path)) throw new Error(`Missing ${role}: ${path}`);
}
const fixtureSourceDigest = directoryDigest(fixtureSource);
const fixtureTargetDigest = directoryDigest(fixtureTarget);
if (fixtureSourceDigest.sha256 !== fixtureTargetDigest.sha256) {
  throw new Error(
    `Controlled fixture drift: repository=${fixtureSourceDigest.sha256}, `
    + `external=${fixtureTargetDigest.sha256}`,
  );
}
const scratch = mkdtempSync(join(tmpdir(), 'ariad-r184-lab-verify-'));
let expectedMutationDigest;
try {
  const expectedMutation = join(scratch, 'fixture-mutated');
  applyRegisteredMutation({
    sourceFixture: fixtureSource,
    destination: expectedMutation,
    mutationRoot: join(here, 'mutation'),
  });
  expectedMutationDigest = directoryDigest(expectedMutation);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const observedMutationDigest = directoryDigest(mutatedTarget);
if (expectedMutationDigest.sha256 !== observedMutationDigest.sha256) {
  throw new Error(
    `Registered mutation drift: expected=${expectedMutationDigest.sha256}, `
    + `external=${observedMutationDigest.sha256}`,
  );
}

const graphifyPython = process.platform === 'win32'
  ? join(labRoot, 'tools', 'graphify-0.9.25', '.venv', 'Scripts', 'python.exe')
  : join(labRoot, 'tools', 'graphify-0.9.25', '.venv', 'bin', 'python');
const wheel = join(labRoot, 'downloads', spec.competitor.wheel);
if (!existsSync(graphifyPython)) throw new Error('Missing isolated Graphify virtual environment');
if (!existsSync(wheel)) throw new Error('Missing pinned Graphify wheel');
if (sha256File(wheel) !== spec.competitor.wheel_sha256) {
  throw new Error('Pinned Graphify wheel hash mismatch');
}

for (const forbidden of [
  join(repoRoot, 'graphify-out'),
  join(repoRoot, '.venv'),
  join(repoRoot, 'obsidian'),
]) {
  if (existsSync(forbidden)) throw new Error(`Competitor artifact leaked into Ariad: ${forbidden}`);
}

console.log(JSON.stringify({
  benchmark_id: spec.benchmark_id,
  lab_root_role: labRoot.split(/[\\/]/).at(-1),
  graphify_wheel_sha256: spec.competitor.wheel_sha256,
  controlled_fixture: fixtureTargetDigest,
  registered_mutation: observedMutationDigest,
  targets: spec.corpus.filter((entry) => entry.commit).map((entry) => ({
    id: entry.id,
    commit: entry.commit,
  })),
}, null, 2));
