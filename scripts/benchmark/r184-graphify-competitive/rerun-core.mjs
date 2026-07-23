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
