import { createHash } from 'node:crypto';

function cellKey(row) {
  return [row.mode, row.repetition, row.condition, row.task].join('|');
}

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function buildRerunPlan(rows, spec) {
  const taskOrder = spec.tasks.map((task) => task.id);
  const taskRank = new Map(taskOrder.map((task, index) => [task, index]));
  const seen = new Set();
  for (const row of rows) {
    const key = cellKey(row);
    if (seen.has(key)) throw new Error(`Duplicate primary result cell: ${key}`);
    seen.add(key);
  }

  const invalid = rows.filter((row) => !row.valid);
  if (!invalid.length) throw new Error('The primary summary has no invalid cells to rerun');
  const grouped = new Map();
  for (const row of invalid) {
    if (!['cold', 'warm'].includes(row.mode)) {
      throw new Error(`Unsupported rerun mode: ${row.mode}`);
    }
    if (!taskRank.has(row.task)) throw new Error(`Unknown rerun task: ${row.task}`);
    const key = [row.mode, row.repetition, row.condition].join('|');
    const group = grouped.get(key) ?? {
      mode: row.mode,
      repetition: row.repetition,
      condition: row.condition,
      replacement_tasks: [],
    };
    group.replacement_tasks.push(row.task);
    grouped.set(key, group);
  }

  const modeRank = new Map([['cold', 0], ['warm', 1]]);
  const groups = [...grouped.values()].map((group) => {
    const replacements = [...new Set(group.replacement_tasks)]
      .sort((left, right) => taskRank.get(left) - taskRank.get(right));
    const requested = group.mode === 'warm' ? taskOrder : replacements;
    return {
      ...group,
      replacement_tasks: replacements,
      requested_tasks: requested,
      support_tasks: requested.filter((task) => !replacements.includes(task)),
      expected_metadata_count: requested.length,
    };
  }).sort((left, right) => {
    const modeDifference = modeRank.get(left.mode) - modeRank.get(right.mode);
    if (modeDifference) return modeDifference;
    if (left.repetition !== right.repetition) return left.repetition - right.repetition;
    const order = spec.repetitions.arm_order[left.repetition - 1];
    return order.indexOf(left.condition) - order.indexOf(right.condition);
  });

  return {
    invalid_cell_count: invalid.length,
    group_count: groups.length,
    expected_rerun_metadata_count: groups.reduce(
      (sum, group) => sum + group.expected_metadata_count,
      0,
    ),
    invalid_cells: invalid.map((row) => ({
      mode: row.mode,
      repetition: row.repetition,
      condition: row.condition,
      task: row.task,
      violations: row.violations,
    })),
    groups,
  };
}

export function reconcileReruns(primaryRows, rerunRows, plan, taskOrder) {
  const taskRank = new Map(taskOrder.map((task, index) => [task, index]));
  const primaryByKey = new Map(primaryRows.map((row) => [cellKey(row), row]));
  const rerunByKey = new Map(rerunRows.map((row) => [cellKey(row), row]));
  if (primaryByKey.size !== primaryRows.length) {
    throw new Error('Primary summary contains duplicate cells');
  }
  if (rerunByKey.size !== rerunRows.length) {
    throw new Error('Rerun summary contains duplicate cells');
  }
  if (rerunRows.length !== plan.expected_rerun_metadata_count) {
    throw new Error(
      `Expected ${plan.expected_rerun_metadata_count} rerun rows, found ${rerunRows.length}`,
    );
  }

  const plannedInvalid = new Set(plan.invalid_cells.map(cellKey));
  const actualInvalid = new Set(primaryRows.filter((row) => !row.valid).map(cellKey));
  if (
    plannedInvalid.size !== actualInvalid.size
    || [...plannedInvalid].some((key) => !actualInvalid.has(key))
  ) {
    throw new Error('Rerun plan does not match the primary invalid-cell set');
  }

  const groupByCell = new Map();
  const expectedRerun = new Set();
  for (const group of plan.groups) {
    for (const task of group.requested_tasks) {
      const key = cellKey({ ...group, task });
      if (expectedRerun.has(key)) throw new Error(`Duplicate planned rerun cell: ${key}`);
      expectedRerun.add(key);
      groupByCell.set(key, group);
    }
  }
  if (
    expectedRerun.size !== rerunByKey.size
    || [...expectedRerun].some((key) => !rerunByKey.has(key))
  ) {
    throw new Error('Rerun summary does not match the planned requested cells');
  }

  const attempts = [];
  const rows = primaryRows.map((primary) => {
    const key = cellKey(primary);
    if (primary.valid) {
      attempts.push({
        cell: key,
        replacement_status: 'not-required',
        first_attempt: primary,
        rerun_attempt: null,
        invalid_warm_prefix: [],
      });
      return {
        ...primary,
        result_attempt: 'first',
        replacement_status: 'not-required',
        first_attempt_valid: true,
        rerun_attempt_valid: null,
        rerun_prefix_valid: null,
      };
    }

    const rerun = rerunByKey.get(key);
    if (!rerun) throw new Error(`Missing rerun for invalid primary cell: ${key}`);
    const group = groupByCell.get(key);
    if (!group?.replacement_tasks.includes(primary.task)) {
      throw new Error(`Rerun cell was not registered as a replacement: ${key}`);
    }

    const invalidWarmPrefix = group.mode === 'warm'
      ? group.requested_tasks
        .filter((task) => taskRank.get(task) <= taskRank.get(primary.task))
        .map((task) => rerunByKey.get(cellKey({ ...group, task })))
        .filter((row) => !row?.valid)
        .map((row) => ({ task: row.task, violations: row.violations }))
      : [];
    const prefixValid = invalidWarmPrefix.length === 0;
    const accepted = rerun.valid && prefixValid;
    const replacementStatus = accepted
      ? 'accepted'
      : prefixValid
        ? 'second-attempt-invalid'
        : 'warm-prefix-contaminated';
    const effectiveViolations = prefixValid
      ? rerun.violations
      : [
        ...rerun.violations,
        ...invalidWarmPrefix.map(
          (entry) => `warm rerun prefix invalid at ${entry.task}: ${entry.violations.join('; ')}`,
        ),
      ];
    attempts.push({
      cell: key,
      replacement_status: replacementStatus,
      first_attempt: primary,
      rerun_attempt: rerun,
      invalid_warm_prefix: invalidWarmPrefix,
    });
    return {
      ...rerun,
      valid: accepted,
      violations: effectiveViolations,
      result_attempt: 'rerun',
      replacement_status: replacementStatus,
      first_attempt_valid: false,
      rerun_attempt_valid: rerun.valid,
      rerun_prefix_valid: prefixValid,
    };
  });

  return {
    rows,
    attempts,
    first_attempt_invalid: actualInvalid.size,
    accepted_replacements: attempts.filter(
      (entry) => entry.replacement_status === 'accepted',
    ).length,
    unresolved_replacements: attempts.filter(
      (entry) => ['second-attempt-invalid', 'warm-prefix-contaminated']
        .includes(entry.replacement_status),
    ).length,
    warm_support_rows: rerunRows.length - actualInvalid.size,
  };
}
