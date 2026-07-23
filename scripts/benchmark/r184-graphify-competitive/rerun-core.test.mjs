import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRerunPlan } from './rerun-core.mjs';

const spec = {
  tasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }],
  repetitions: {
    arm_order: [
      ['A', 'B'],
      ['B', 'A'],
    ],
  },
};

test('rerun plan limits cold work and rebuilds complete warm sessions', () => {
  const plan = buildRerunPlan([
    {
      mode: 'cold', repetition: 1, condition: 'A', task: 'T01', valid: true,
    },
    {
      mode: 'cold', repetition: 1, condition: 'A', task: 'T02', valid: false,
      violations: ['forbidden'],
    },
    {
      mode: 'warm', repetition: 2, condition: 'B', task: 'T01', valid: true,
    },
    {
      mode: 'warm', repetition: 2, condition: 'B', task: 'T02', valid: false,
      violations: ['forbidden'],
    },
  ], spec);

  assert.equal(plan.invalid_cell_count, 2);
  assert.equal(plan.group_count, 2);
  assert.equal(plan.expected_rerun_metadata_count, 4);
  assert.deepEqual(plan.groups[0], {
    mode: 'cold',
    repetition: 1,
    condition: 'A',
    replacement_tasks: ['T02'],
    requested_tasks: ['T02'],
    support_tasks: [],
    expected_metadata_count: 1,
  });
  assert.deepEqual(plan.groups[1], {
    mode: 'warm',
    repetition: 2,
    condition: 'B',
    replacement_tasks: ['T02'],
    requested_tasks: ['T01', 'T02', 'T03'],
    support_tasks: ['T01', 'T03'],
    expected_metadata_count: 3,
  });
});

test('rerun plan rejects duplicate primary cells', () => {
  const duplicate = {
    mode: 'cold', repetition: 1, condition: 'A', task: 'T01', valid: false,
    violations: ['forbidden'],
  };
  assert.throws(
    () => buildRerunPlan([duplicate, duplicate], spec),
    /Duplicate primary result cell/u,
  );
});
