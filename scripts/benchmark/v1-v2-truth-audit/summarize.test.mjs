import assert from 'node:assert/strict';
import test from 'node:test';

import { gradeAnswer } from './summarize.mjs';

test('grades exact JSON after removing a Markdown fence', () => {
  const task = { answer_format: 'json', answer: ['a', 'b'] };
  assert.equal(gradeAnswer(task, '```json\n["a","b"]\n```').grade, 'PASS');
});

test('grades a strict majority subset as partial', () => {
  const task = { answer_format: 'json', answer: ['a', 'b', 'c'] };
  assert.equal(gradeAnswer(task, '["a","c"]').grade, 'PARTIAL');
});

test('grades a wrong extra element as fail', () => {
  const task = { answer_format: 'json', answer: ['a', 'b'] };
  assert.equal(gradeAnswer(task, '["a","wrong"]').grade, 'FAIL');
});

test('requires retained chain steps to stay ordered', () => {
  const task = { answer_format: 'chain', answer: ['a', 'b', 'c', 'd'] };
  assert.equal(gradeAnswer(task, 'a -> c').grade, 'PARTIAL');
  assert.equal(gradeAnswer(task, 'c -> a').grade, 'FAIL');
});

test('normalizes Windows separators in scalar answers', () => {
  const task = { answer_format: 'text', answer: 'a/b.ts:1' };
  assert.equal(gradeAnswer(task, 'a\\b.ts:1').grade, 'PASS');
});
