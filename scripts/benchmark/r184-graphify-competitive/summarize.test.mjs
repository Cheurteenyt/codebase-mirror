import assert from 'node:assert/strict';
import test from 'node:test';

import { gradeAnswer } from './core.mjs';
import { auditCommand, splitPowerShellCommands } from './command-audit.mjs';

test('R184 JSON task grading is key-order independent and value exact', () => {
  const task = {
    answer_format: 'json',
    answer: {
      definition: 'symbol@src/file.ts:1',
      present: false,
    },
  };
  assert.equal(
    gradeAnswer(task, '{"present":false,"definition":"symbol@src/file.ts:1"}').grade,
    'PASS',
  );
  assert.equal(
    gradeAnswer(task, '{"present":true,"definition":"symbol@src/file.ts:1"}').grade,
    'FAIL',
  );
});

test('R184 ordered chain grading rejects reordered evidence', () => {
  const task = {
    answer_format: 'chain',
    answer: ['route@a.ts:1', 'handler@b.ts:2', 'terminal@c.ts:3'],
  };
  assert.equal(
    gradeAnswer(task, 'route@a.ts:1 -> handler@b.ts:2 -> terminal@c.ts:3').grade,
    'PASS',
  );
  assert.equal(
    gradeAnswer(task, 'route@a.ts:1 -> terminal@c.ts:3 -> handler@b.ts:2').grade,
    'FAIL',
  );
});

test('PowerShell audit ignores separators inside quoted rg patterns', () => {
  const command = String.raw`powershell.exe -Command 'rg -n "PipelineEnvelope|PipelineEnvelopeAlias|export).*from" src'`;
  assert.deepEqual(splitPowerShellCommands(command), [
    'rg -n "PipelineEnvelope|PipelineEnvelopeAlias|export).*from" src',
  ]);
  assert.equal(auditCommand(command), null);
});

test('PowerShell audit permits only registered readers across real separators', () => {
  assert.equal(
    auditCommand(String.raw`powershell.exe -Command "Get-Content a.ts; Get-Content b.ts | Select-Object -First 20"`),
    null,
  );
  assert.equal(
    auditCommand(String.raw`powershell.exe -Command "rg thing src | Sort-Object"`),
    'forbidden pipeline command: Sort-Object',
  );
});

test('PowerShell audit judges executed commands rather than words in paths and patterns', () => {
  assert.equal(
    auditCommand(String.raw`powershell.exe -Command "Get-Content fastapi\routing.py | Select-Object -First 20"`),
    null,
  );
  assert.equal(
    auditCommand(String.raw`powershell.exe -Command "rg -n 'node|npm|pnpm|from [\"'']zod' packages/bench"`),
    null,
  );
  assert.equal(
    auditCommand(String.raw`powershell.exe -Command "rg -n \"commitDelivery|obsoleteLegacyPath\" src"`),
    null,
  );
  assert.equal(
    auditCommand(String.raw`powershell.exe -Command "rg -n \"handler|    route_handler|from\" src"`),
    null,
  );
  assert.equal(
    auditCommand(String.raw`powershell.exe -Command "rg -n \"from [^;]+|export |interface |type |node\" src"`),
    null,
  );
});

test('PowerShell audit handles mismatched recorded wrapper quotes without splitting a regex', () => {
  const command = String.raw`powershell.exe -Command 'rg -n "^(import|export).*|from ['\"\\\"]" src"`;
  assert.deepEqual(splitPowerShellCommands(command), [
    String.raw`rg -n "^(import|export).*|from ['\"\\\"]" src`,
  ]);
  assert.equal(auditCommand(command), null);
});

test('PowerShell audit rejects answer-computing scripts and unregistered readers', () => {
  assert.equal(
    auditCommand(String.raw`powershell.exe -Command '$files = rg --files; Get-Content a.ts'`),
    'forbidden pipeline command: $files',
  );
  assert.equal(
    auditCommand(String.raw`powershell.exe -Command "Get-Content a.ts; Test-Path b.ts"`),
    'forbidden pipeline command: Test-Path',
  );
  assert.equal(
    auditCommand(String.raw`powershell.exe -Command "node answer.mjs"`),
    'forbidden pipeline command: node',
  );
  assert.equal(
    auditCommand(String.raw`powershell.exe -Command "rg answer src|node answer.mjs"`),
    'forbidden pipeline command: node',
  );
});
