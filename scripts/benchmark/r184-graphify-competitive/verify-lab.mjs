#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256File } from './core.mjs';

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
  targets: spec.corpus.filter((entry) => entry.commit).map((entry) => ({
    id: entry.id,
    commit: entry.commit,
  })),
}, null, 2));
