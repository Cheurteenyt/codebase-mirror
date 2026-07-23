#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyRegisteredMutation } from './core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const spec = JSON.parse(readFileSync(join(here, 'spec.json'), 'utf8'));
const visual = JSON.parse(readFileSync(join(here, 'visual-tasks.json'), 'utf8'));
const protocol = readFileSync(
  join(repoRoot, 'docs', 'performance', 'GRAPHIFY_COMPETITIVE_PROTOCOL.md'),
  'utf8',
);
const fixture = join(repoRoot, 'v2', 'tests', 'fixtures', 'r184-competitive-lab');

function line(path, number) {
  const lines = readFileSync(path, 'utf8').replaceAll('\r', '').split('\n');
  assert.ok(number > 0 && number <= lines.length, `${path}:${number} exists`);
  return lines[number - 1];
}

function assertLine(relativePath, number, pattern) {
  const actual = line(join(fixture, relativePath), number);
  assert.match(actual, pattern, `${relativePath}:${number}`);
}

function walk(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

assert.equal(spec.schema_version, 1);
assert.equal(spec.benchmark_id, 'r184-ariad-vs-graphify-2026-07-23');
assert.equal(spec.competitor.version, '0.9.25');
assert.equal(spec.competitor.git_commit, '2fa6cd3d5548577f8c5f591b713f0bf80c1af183');
assert.equal(spec.competitor.wheel_sha256, 'e902205873d129e9c76c11fea4268480042603590290ed600707354e74314c0c');
assert.deepEqual(Object.keys(spec.arms), ['A', 'B', 'C', 'D']);
assert.deepEqual(spec.repetitions.arm_order, [
  ['A', 'B', 'C', 'D'],
  ['B', 'C', 'D', 'A'],
  ['C', 'D', 'A', 'B'],
  ['D', 'A', 'B', 'C'],
]);
assert.equal(spec.tasks.length, 8);
assert.deepEqual(spec.tasks.map((task) => task.id), [
  'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08',
]);
assert.deepEqual(visual.tasks.map((task) => task.id), ['T09', 'T10']);
assert.equal(visual.capture_stage, 'initial-pre-interaction');
assert.equal(visual.repetitions.cold_fresh_browser_context, 5);
assert.equal(visual.repetitions.warm_persistent_browser_context, 5);
assert.equal(visual.repetitions.warm_prime_runs, 1);
assert.deepEqual(visual.tasks.find((task) => task.id === 'T09').mechanical_signals, [
  'largest_areas_visible',
  'commit_delivery_located',
  'run_pipeline_direction_visible',
  'architecture_context_restored',
]);
assert.deepEqual(visual.tasks.find((task) => task.id === 'T10').mechanical_signals, [
  'packages_bench_located',
  'packages_bench_to_zod_direction_visible',
  'zod_next_exact_evidence_located',
  'selection_cleared',
  'overview_restored',
  'narrow_viewport_unclipped',
]);
for (const executable of [
  'measure-index.mjs',
  'prepare-query-state.mjs',
  'run.mjs',
  'summarize.mjs',
  'visual-lab.mjs',
  'seal-results.mjs',
]) {
  assert.ok(walk(here).some((path) => path.endsWith(executable)), `missing ${executable}`);
}

for (const token of [
  spec.benchmark_id,
  spec.competitor.version,
  spec.competitor.git_commit,
  spec.competitor.wheel_sha256,
  ...spec.corpus.filter((entry) => entry.commit).map((entry) => entry.commit),
  ...spec.tasks.map((task) => task.id),
  ...visual.tasks.map((task) => task.id),
]) {
  assert.ok(protocol.includes(token), `protocol contains ${token}`);
}

assertLine('src/contracts/envelope.ts', 1, /interface PipelineEnvelope/);
assertLine('src/contracts/public.ts', 3, /PipelineEnvelope as DeliveryEnvelope/);
assertLine('src/api/routes.ts', 13, /POST \/pipeline\/run/);
assertLine('src/api/routes.ts', 8, /function runPipelineRoute/);
assertLine('src/orchestration/pipeline.ts', 6, /function runPipeline/);
assertLine('src/delivery/publish.ts', 6, /function commitDelivery/);
for (const domain of ['alpha', 'beta', 'delta', 'gamma']) {
  assertLine(`src/domains/${domain}.ts`, 4, /sharedCheckpoint/);
}
assertLine('docs/ADR/ADR-007-durable-delivery.md', 9, /ADR-007/);
assertLine('docs/Risks/RISK-004-retry-boundary.md', 9, /RISK-004/);

const typeTokens = /\b(?:PipelineEnvelope|PipelineEnvelopeAlias|DeliveryEnvelope)\b/;
const observedTypeFiles = walk(join(fixture, 'src'))
  .filter((path) => path.endsWith('.ts'))
  .filter((path) => typeTokens.test(readFileSync(path, 'utf8')))
  .map((path) => relative(fixture, path).replaceAll('\\', '/'))
  .sort();
assert.deepEqual(observedTypeFiles, spec.tasks.find((task) => task.id === 'T02').answer);

const scratch = mkdtempSync(join(tmpdir(), 'ariad-r184-verify-'));
const mutated = join(scratch, 'fixture-mutated');
try {
  applyRegisteredMutation({
    sourceFixture: fixture,
    destination: mutated,
    mutationRoot: join(here, 'mutation'),
  });
  assert.match(line(join(mutated, 'src/delivery/commit.ts'), 6), /function commitDelivery/);
  assert.match(line(join(mutated, 'src/orchestration/pipeline.ts'), 9), /commitDelivery/);
  assert.match(line(join(mutated, 'src/monitoring/audit.ts'), 5), /commitDelivery/);
  assert.throws(() => readFileSync(join(mutated, 'src/delivery/publish.ts'), 'utf8'));
  assert.throws(() => readFileSync(join(mutated, 'src/legacy/obsolete.ts'), 'utf8'));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

for (const manifest of [
  join(repoRoot, 'v2', 'package.json'),
  join(repoRoot, 'graph-ui', 'package.json'),
]) {
  const text = readFileSync(manifest, 'utf8');
  assert.doesNotMatch(text, /graphify/i, `${manifest} must not depend on Graphify`);
}

for (const tracked of walk(here)) {
  const text = readFileSync(tracked, 'utf8');
  assert.doesNotMatch(text, /D:[\\/]|C:[\\/]/i, `${tracked} contains an absolute machine path`);
}

console.log('Verified R184 pins, protocol reachability, 8 agent tasks, 2 visual tasks, fixture evidence, mutation, and dependency isolation.');
