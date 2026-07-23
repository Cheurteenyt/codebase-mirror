#!/usr/bin/env node

import { cpSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyRegisteredMutation } from './core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const labRoot = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node prepare-targets.mjs <external-lab-root>');
const rel = relative(repoRoot, labRoot);
if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')) {
  throw new Error(`Lab root must be outside the Ariad checkout: ${labRoot}`);
}

const fixtureSource = join(repoRoot, 'v2', 'tests', 'fixtures', 'r184-competitive-lab');
const fixtureTarget = join(labRoot, 'targets', 'fixture');
const mutatedTarget = join(labRoot, 'targets', 'fixture-mutated');
if (existsSync(fixtureTarget) || existsSync(mutatedTarget)) {
  throw new Error('Refusing to overwrite existing fixture targets');
}
cpSync(fixtureSource, fixtureTarget, { recursive: true, errorOnExist: true });
applyRegisteredMutation({
  sourceFixture: fixtureSource,
  destination: mutatedTarget,
  mutationRoot: join(here, 'mutation'),
});

console.log(JSON.stringify({
  prepared: ['fixture', 'fixture-mutated'],
  fixture_role: 'controlled-preregistration-copy',
  mutated_role: 'registered-T08-answer-target',
}, null, 2));
