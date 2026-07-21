import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { buildAnalysis, derive, isProductionPath } from './derive-structural-references.mjs';

function write(root, path, contents) {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, contents, 'utf8');
}

test('keeps production src/test paths and follows canonical calls plus star re-exports', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'cbm-structural-reference-'));
  try {
    write(checkout, 'src/core.ts', [
      'export function leaf(): void {}',
      'export class Runner { run(): void { leaf(); } }',
      '',
    ].join('\n'));
    write(checkout, 'src/mcp/test/product.ts', [
      "import { Runner } from '../../core';",
      'export function wrapper(): void { new Runner().run(); }',
      '',
    ].join('\n'));
    write(checkout, 'tests/ignored.ts', [
      "import { leaf } from '../src/core';",
      'export function ignored(): void { leaf(); }',
      '',
    ].join('\n'));
    write(checkout, 'types/base.d.ts', 'export type Root = { value: string };\n');
    write(checkout, 'types/index.d.ts', "export * from './base';\n");
    write(checkout, 'types/shim.d.ts', "export * from './index';\n");
    execFileSync('git', ['init', '--quiet'], { cwd: checkout, stdio: 'ignore' });
    execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '--', '.'], { cwd: checkout, stdio: 'ignore' });

    assert.equal(isProductionPath('src/mcp/test/product.ts'), true);
    assert.equal(isProductionPath('tests/ignored.ts'), false);

    const analysis = buildAnalysis({ id: 'fixture', checkout });
    assert.deepEqual(derive(analysis, {
      kind: 'transitive_callers',
      declaration: 'src/core.ts',
      symbol: 'leaf',
      declaration_kind: 'function',
      include_prefixes: ['src'],
      max_depth: 5,
    }), [
      '1|run@src/core.ts:2',
      '2|wrapper@src/mcp/test/product.ts:2',
    ]);
    assert.deepEqual(derive(analysis, {
      kind: 'transitive_type_reference_files',
      declaration: 'types/base.d.ts',
      symbol: 'Root',
      declaration_kind: 'type',
      include_prefixes: ['types/'],
    }), [
      'types/base.d.ts',
      'types/index.d.ts',
      'types/shim.d.ts',
    ]);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});
