import assert from 'node:assert/strict';
import test from 'node:test';

import { perTaskTables, ratioTable } from './checkpoint.mjs';

const aggregates = [
  { mode: 'one-shot', target: 'small', condition: 'B', raw_total_tokens: 200, tool_calls: 4 },
  { mode: 'one-shot', target: 'small', condition: 'C', raw_total_tokens: 100, tool_calls: 2 },
];

const runs = [
  { mode: 'one-shot', target: 'small', task: 'T01', condition: 'B', raw_total_tokens: '200', tool_calls: '4', tool_response_bytes: '80', grade: 'PASS', valid: 'true', attempt: '1' },
  { mode: 'one-shot', target: 'small', task: 'T01', condition: 'C', raw_total_tokens: '100', tool_calls: '2', tool_response_bytes: '40', grade: 'PARTIAL', valid: 'true', attempt: '1' },
];

test('checkpoint tables support a B/C-only structural round', () => {
  const ratios = ratioTable(aggregates);
  assert.match(ratios, /\| one-shot \| small \| n\/a \| n\/a \| 2\.000 \| n\/a \| n\/a \| n\/a \|/);

  const tasks = perTaskTables(runs, 'Structural correctness baseline');
  assert.match(tasks, /\| Task \| B: v2-mcp \| C: grep-read \|/);
  assert.match(tasks, /\| T01 \| 200 \/ 4 \/ 80 \/ PASS \/ valid \| 100 \/ 2 \/ 40 \/ PARTIAL \/ valid \|/);
  assert.doesNotMatch(tasks, /T02|A: V1 MCP|D: hybrid/);
});
