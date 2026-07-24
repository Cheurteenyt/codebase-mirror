import { spawn } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRerunPlan, rerunPhase, sha256Text } from './rerun-core.mjs';

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

function runNode(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: dirname(fileURLToPath(import.meta.url)),
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
      } else {
        reject(new Error(`Rerun group exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`));
      }
    });
  });
}

const options = parseArgs(process.argv.slice(2));
for (const required of [
  'lab_root',
  'prereg_sha',
  'summary',
  'results_root',
  'plan_output',
  'completion_output',
]) {
  if (!options[required]) throw new Error(`Missing --${required.replaceAll('_', '-')}`);
}

const summaryText = readFileSync(resolve(options.summary), 'utf8');
const summary = JSON.parse(summaryText);
if (summary.benchmark_id !== spec.benchmark_id) {
  throw new Error('The rerun source must share the frozen R184 benchmark identity');
}
const phase = rerunPhase(summary.phase);
const plan = {
  schema_version: 1,
  benchmark_id: spec.benchmark_id,
  phase,
  preregistration_sha: options.prereg_sha,
  created_at_utc: new Date().toISOString(),
  primary_summary: resolve(options.summary),
  primary_summary_sha256: sha256Text(summaryText),
  rerun_results_root: resolve(options.results_root),
  ...buildRerunPlan(summary.rows, spec),
};
mkdirSync(dirname(resolve(options.plan_output)), { recursive: true });
writeFileSync(
  resolve(options.plan_output),
  `${JSON.stringify(plan, null, 2)}\n`,
  { encoding: 'utf8', flag: 'wx' },
);

const startedAt = new Date().toISOString();
for (const group of plan.groups) {
  const args = [
    fileURLToPath(new URL('./run.mjs', import.meta.url)),
    'run',
    '--lab-root', resolve(options.lab_root),
    '--phase', phase,
    '--mode', group.mode,
    '--repetition', String(group.repetition),
    '--prereg-sha', options.prereg_sha,
    '--condition', group.condition,
    '--results-root', resolve(options.results_root),
  ];
  if (group.mode === 'cold') args.push('--task', group.requested_tasks.join(','));
  console.log(
    `RERUN ${group.mode} r${group.repetition} ${group.condition} `
    + `replacement=${group.replacement_tasks.join(',')} requested=${group.requested_tasks.join(',')}`,
  );
  await runNode(args);
}

writeFileSync(
  resolve(options.completion_output),
  `${JSON.stringify({
    schema_version: 1,
    benchmark_id: spec.benchmark_id,
    started_at_utc: startedAt,
    finished_at_utc: new Date().toISOString(),
    plan: resolve(options.plan_output),
    plan_sha256: sha256Text(readFileSync(resolve(options.plan_output), 'utf8')),
    completed_groups: plan.group_count,
    expected_rerun_metadata_count: plan.expected_rerun_metadata_count,
  }, null, 2)}\n`,
  { encoding: 'utf8', flag: 'wx' },
);
