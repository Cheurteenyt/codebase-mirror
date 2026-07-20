#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const protocol = readFileSync(join(repoRoot, 'docs', 'BENCHMARK_PROTOCOL.md'), 'utf8');
const spec = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'));

function normalizeProse(value) {
  return value.replaceAll('\r', '').replace(/\s+/g, ' ').trim();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function section(start, end) {
  const from = protocol.indexOf(start);
  const to = protocol.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `Missing section start: ${start}`);
  assert.notEqual(to, -1, `Missing section end: ${end}`);
  return protocol.slice(from, to);
}

function extractTasks(markdown) {
  markdown = markdown.replaceAll('\r', '');
  const chunks = markdown.split(/\n#{3,4}\s+T(?=\d{2}\b)/).slice(1);
  return chunks.map((chunk) => {
    const id = `T${chunk.slice(0, 2)}`;
    const question = chunk.match(/\*\*Question\.\*\*\s*([\s\S]*?)\n\n\*\*Reference answer\.\*\*/);
    const answer = chunk.match(/\*\*Reference answer\.\*\*[\s\S]*?```(?:json|text)?\s*\n([\s\S]*?)\n```/);
    assert.ok(question, `Missing question for ${id}`);
    assert.ok(answer, `Missing answer for ${id}`);
    return { id, question: normalizeProse(question[1]), answer: answer[1].trim() };
  });
}

const sourceSets = [
  extractTasks(section('## 4. Fixed questions and reference answers', '## 5. Mechanical grading')),
  extractTasks(section('### 12.2 Pre-registered task mapping', '### 12.3 Pre-registered execution and grading')),
];

for (let targetIndex = 0; targetIndex < spec.targets.length; targetIndex += 1) {
  const target = spec.targets[targetIndex];
  const source = sourceSets[targetIndex];
  assert.equal(source.length, 12, `${target.id}: source task count`);
  assert.equal(target.tasks.length, 12, `${target.id}: spec task count`);
  for (let taskIndex = 0; taskIndex < 12; taskIndex += 1) {
    const expected = source[taskIndex];
    const task = target.tasks[taskIndex];
    assert.equal(task.id, expected.id, `${target.id}/${task.id}: id`);
    assert.equal(normalizeProse(task.question), expected.question, `${target.id}/${task.id}: question drift`);
    if (task.answer_format === 'json') {
      assert.deepEqual(stable(task.answer), stable(JSON.parse(expected.answer)), `${target.id}/${task.id}: JSON answer drift`);
    } else if (task.answer_format === 'chain') {
      assert.equal(task.answer.join(' -> '), expected.answer, `${target.id}/${task.id}: chain answer drift`);
    } else {
      assert.equal(task.answer, expected.answer, `${target.id}/${task.id}: text answer drift`);
    }
  }
}

console.log('Verified: 24 questions and reference answers match docs/BENCHMARK_PROTOCOL.md.');
