import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { reconcileReruns, sha256Text } from './rerun-core.mjs';

const spec = JSON.parse(readFileSync(new URL('./spec.json', import.meta.url), 'utf8'));

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument: ${key ?? ''}`);
    options[key.slice(2).replaceAll('-', '_')] = value;
  }
  return options;
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(' | ') : String(value ?? '');
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const options = parseArgs(process.argv.slice(2));
for (const required of ['primary', 'reruns', 'plan', 'output']) {
  if (!options[required]) throw new Error(`Missing --${required}`);
}
const primaryText = readFileSync(resolve(options.primary), 'utf8');
const rerunText = readFileSync(resolve(options.reruns), 'utf8');
const planText = readFileSync(resolve(options.plan), 'utf8');
const primary = JSON.parse(primaryText);
const reruns = JSON.parse(rerunText);
const plan = JSON.parse(planText);
if (
  primary.benchmark_id !== spec.benchmark_id
  || reruns.benchmark_id !== spec.benchmark_id
  || plan.benchmark_id !== spec.benchmark_id
) {
  throw new Error('Rerun reconciliation inputs do not share the frozen benchmark identity');
}
if (plan.primary_summary_sha256 !== sha256Text(primaryText)) {
  throw new Error('Primary summary hash does not match the frozen rerun plan');
}

const reconciled = reconcileReruns(
  primary.rows,
  reruns.rows,
  plan,
  spec.tasks.map((task) => task.id),
);
const output = {
  schema_version: 1,
  benchmark_id: spec.benchmark_id,
  generated_at_utc: new Date().toISOString(),
  phase: 'baseline',
  primary_summary: resolve(options.primary),
  primary_summary_sha256: sha256Text(primaryText),
  rerun_summary: resolve(options.reruns),
  rerun_summary_sha256: sha256Text(rerunText),
  rerun_plan: resolve(options.plan),
  rerun_plan_sha256: sha256Text(planText),
  primary_runs: primary.rows.length,
  rerun_runs: reruns.rows.length,
  ...reconciled,
};
mkdirSync(dirname(resolve(options.output)), { recursive: true });
writeFileSync(
  resolve(options.output),
  `${JSON.stringify(output, null, 2)}\n`,
  { encoding: 'utf8', flag: 'wx' },
);

const csvFields = [
  'phase', 'mode', 'repetition', 'task', 'target', 'condition', 'condition_name',
  'valid', 'grade', 'result_attempt', 'replacement_status', 'input_tokens',
  'cached_input_tokens', 'output_tokens', 'total_tokens', 'tool_calls',
  'source_calls', 'mcp_calls', 'graph_used', 'vault_used', 'human_memory_used',
  'first_evidence_ms', 'wall_ms', 'violations',
];
const csv = [
  csvFields.join(','),
  ...reconciled.rows.map(
    (row) => csvFields.map((field) => csvCell(row[field])).join(','),
  ),
].join('\n');
const csvPath = resolve(options.output).replace(/\.json$/iu, '.csv');
writeFileSync(csvPath, `${csv}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({
  output: resolve(options.output),
  csv: csvPath,
  primary_runs: primary.rows.length,
  rerun_runs: reruns.rows.length,
  first_attempt_invalid: reconciled.first_attempt_invalid,
  accepted_replacements: reconciled.accepted_replacements,
  unresolved_replacements: reconciled.unresolved_replacements,
}, null, 2));
