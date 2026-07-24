import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  applyRegisteredMutation,
  gradeAnswer,
  normalizeAnswer,
} from './core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

test('normalizes one outer fence and Windows paths', () => {
  assert.equal(
    normalizeAnswer('```text\r\nsrc\\file.ts:4\r\n```'),
    'src/file.ts:4',
  );
});

test('grades exact, partial without extras, and wrong-extra failures', () => {
  const task = {
    answer_format: 'json',
    answer: { values: ['a', 'b', 'c'] },
  };
  assert.equal(gradeAnswer(task, '{"values":["a","b","c"]}').grade, 'PASS');
  assert.equal(gradeAnswer(task, '{"values":["a","b"]}').grade, 'PARTIAL');
  assert.equal(gradeAnswer(task, '{"values":["a","wrong"]}').grade, 'FAIL');
  assert.equal(gradeAnswer(task, 'not json').grade, 'FAIL');
});

test('applies the registered edit, rename, addition, and deletion to a copy', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ariad-r184-mutation-'));
  const destination = join(scratch, 'fixture-mutated');
  try {
    applyRegisteredMutation({
      sourceFixture: join(repoRoot, 'v2', 'tests', 'fixtures', 'r184-competitive-lab'),
      destination,
      mutationRoot: join(here, 'mutation'),
    });
    assert.match(
      readFileSync(join(destination, 'src', 'delivery', 'commit.ts'), 'utf8'),
      /function commitDelivery/,
    );
    assert.match(
      readFileSync(join(destination, 'src', 'monitoring', 'audit.ts'), 'utf8'),
      /auditDelivery/,
    );
    assert.throws(() =>
      readFileSync(join(destination, 'src', 'delivery', 'publish.ts'), 'utf8'));
    assert.throws(() =>
      readFileSync(join(destination, 'src', 'legacy', 'obsolete.ts'), 'utf8'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
