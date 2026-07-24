import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRerunPlan, reconcileReruns, rerunPhase } from './rerun-core.mjs';

const spec = {
  tasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }],
  repetitions: {
    arm_order: [
      ['A', 'B'],
      ['B', 'A'],
    ],
  },
};

test('rerun phase accepts baseline and postfix but rejects drift', () => {
  assert.equal(rerunPhase('baseline'), 'baseline');
  assert.equal(rerunPhase('postfix', 'postfix', 'postfix'), 'postfix');
  assert.throws(() => rerunPhase('preflight'), /Unsupported rerun phase/u);
  assert.throws(
    () => rerunPhase('baseline', 'postfix'),
    /do not share phase baseline/u,
  );
});

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

test('rerun reconciliation accepts clean replacements and rejects contaminated warm prefixes', () => {
  const primary = [
    {
      mode: 'cold', repetition: 1, condition: 'A', task: 'T01',
      valid: false, violations: ['first invalid'], grade: 'FAIL',
    },
    {
      mode: 'warm', repetition: 2, condition: 'B', task: 'T01',
      valid: true, violations: [], grade: 'PASS',
    },
    {
      mode: 'warm', repetition: 2, condition: 'B', task: 'T02',
      valid: false, violations: ['first invalid'], grade: 'PASS',
    },
    {
      mode: 'warm', repetition: 2, condition: 'B', task: 'T03',
      valid: true, violations: [], grade: 'PASS',
    },
  ];
  const plan = {
    invalid_cells: [primary[0], primary[2]],
    expected_rerun_metadata_count: 4,
    groups: [
      {
        mode: 'cold', repetition: 1, condition: 'A',
        replacement_tasks: ['T01'], requested_tasks: ['T01'],
      },
      {
        mode: 'warm', repetition: 2, condition: 'B',
        replacement_tasks: ['T02'], requested_tasks: ['T01', 'T02', 'T03'],
      },
    ],
  };
  const reruns = [
    {
      mode: 'cold', repetition: 1, condition: 'A', task: 'T01',
      valid: true, violations: [], grade: 'PASS',
    },
    {
      mode: 'warm', repetition: 2, condition: 'B', task: 'T01',
      valid: false, violations: ['support invalid'], grade: 'PASS',
    },
    {
      mode: 'warm', repetition: 2, condition: 'B', task: 'T02',
      valid: true, violations: [], grade: 'PASS',
    },
    {
      mode: 'warm', repetition: 2, condition: 'B', task: 'T03',
      valid: true, violations: [], grade: 'PASS',
    },
  ];

  const reconciled = reconcileReruns(primary, reruns, plan, ['T01', 'T02', 'T03']);
  assert.equal(reconciled.accepted_replacements, 1);
  assert.equal(reconciled.unresolved_replacements, 1);
  assert.equal(reconciled.rows[0].replacement_status, 'accepted');
  assert.equal(reconciled.rows[0].valid, true);
  assert.equal(reconciled.rows[2].replacement_status, 'warm-prefix-contaminated');
  assert.equal(reconciled.rows[2].valid, false);
  assert.match(reconciled.rows[2].violations.at(-1), /prefix invalid at T01/u);
});
