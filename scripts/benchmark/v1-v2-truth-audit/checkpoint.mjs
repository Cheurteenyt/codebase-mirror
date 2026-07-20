#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const values = {};
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--force') {
      values.force = true;
      continue;
    }
    const key = argument?.replace(/^--/, '').replaceAll('-', '_');
    const value = argv[index + 1];
    if (!key || value === undefined) throw new Error(`Missing value after ${argument}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  const [header, ...records] = rows;
  return records.filter((record) => record.length === header.length).map((record) => Object.fromEntries(
    header.map((name, index) => [name, record[index]]),
  ));
}

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function comma(value) {
  return Number(value).toLocaleString('en-US');
}

function fixed(value, digits = 3) {
  return Number(value).toFixed(digits);
}

function aggregateTable(aggregates) {
  const lines = [
    '| Usage | Target | Arm | Raw tokens | Uncached + output | Calls | Response bytes | Query ms | PASS/PARTIAL/FAIL |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of aggregates) {
    lines.push(`| ${row.mode} | ${row.target} | ${row.condition} (${row.condition_name}) | ${comma(row.raw_total_tokens)} | ${comma(row.uncached_input_plus_output)} | ${comma(row.tool_calls)} | ${comma(row.tool_response_bytes)} | ${fixed(row.mcp_query_latency_ms, 1)} | ${row.PASS}/${row.PARTIAL}/${row.FAIL} |`);
  }
  return lines.join('\n');
}

function ratioTable(aggregates) {
  const lines = [
    '| Usage | Target | V2/V1 tokens | V1/grep tokens | V2/grep tokens | Hybrid/grep tokens | V2/V1 calls | Hybrid/grep calls |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  ];
  const groups = new Map();
  for (const row of aggregates) {
    const key = `${row.mode}\0${row.target}`;
    const group = groups.get(key) ?? {};
    group[row.condition] = row;
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const [mode, target] = key.split('\0');
    lines.push(`| ${mode} | ${target} | ${fixed(group.B.raw_total_tokens / group.A.raw_total_tokens)} | ${fixed(group.A.raw_total_tokens / group.C.raw_total_tokens)} | ${fixed(group.B.raw_total_tokens / group.C.raw_total_tokens)} | ${fixed(group.D.raw_total_tokens / group.C.raw_total_tokens)} | ${fixed(group.B.tool_calls / group.A.tool_calls)} | ${fixed(group.D.tool_calls / group.C.tool_calls)} |`);
  }
  return lines.join('\n');
}

function perTaskTables(runs, phase) {
  const lines = [
    `# V1/V2 token-truth ${phase}: complete selected per-task tables`,
    '',
    'Each arm cell is `raw native tokens / completed calls / response bytes / grade / validity`.',
    'The committed CSV beside this file is the canonical machine-readable table and retains every registered attribution field.',
  ];
  for (const mode of ['one-shot', 'continuous']) {
    for (const target of ['small', 'large']) {
      lines.push('', `## ${mode} — ${target}`, '', '| Task | A: V1 MCP | B: V2 MCP | C: grep/read | D: hybrid |', '|---|---:|---:|---:|---:|');
      for (let taskNumber = 1; taskNumber <= 12; taskNumber += 1) {
        const task = `T${String(taskNumber).padStart(2, '0')}`;
        const cells = ['A', 'B', 'C', 'D'].map((condition) => {
          const run = runs.find((item) => item.mode === mode && item.target === target && item.task === task && item.condition === condition);
          if (!run) return 'missing';
          return `${comma(run.raw_total_tokens)} / ${run.tool_calls} / ${comma(run.tool_response_bytes)} / ${run.grade} / ${run.valid === 'true' ? 'valid' : `INVALID a${run.attempt}`}`;
        });
        lines.push(`| ${task} | ${cells.join(' | ')} |`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

async function rawManifest(resultsRoot, phase) {
  const roots = [resolve(resultsRoot, phase)];
  const preflight = resolve(resultsRoot, 'preflight');
  if (phase === 'baseline' && existsSync(preflight)) roots.push(preflight);
  const standalone = [resolve(resultsRoot, 'invalid-runs.json')].filter(existsSync);
  const files = [...roots.flatMap(walkFiles), ...standalone]
    .sort((left, right) => left.localeCompare(right));
  const artifacts = [];
  const tree = createHash('sha256');
  for (const path of files) {
    const relativePath = relative(resultsRoot, path).replaceAll('\\', '/');
    const size = statSync(path).size;
    const digest = await sha256(path);
    artifacts.push({ path: relativePath, bytes: size, sha256: digest });
    tree.update(`${relativePath}\0${size}\0${digest}\n`);
  }
  return {
    schema_version: 1,
    results_identity: basename(resultsRoot),
    phase,
    excludes: ['derived/**'],
    artifact_count: artifacts.length,
    total_bytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    tree_sha256: tree.digest('hex'),
    artifacts,
  };
}

function writeNew(path, text, force) {
  if (existsSync(path) && !force) throw new Error(`Refusing to overwrite ${path}; pass --force.`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

async function main() {
  const options = parseArgs(process.argv);
  const phase = options.phase ?? 'baseline';
  const resultsRoot = resolve(options.results_root ?? 'D:/Mycodex/benchmark-results/r173-v1-v2-truth');
  const outputDir = resolve(options.output_dir ?? `docs/benchmarks/v1-v2-token-truth-${phase}-2026-07-20`);
  const derivedDir = resolve(resultsRoot, 'derived', phase);
  const csvPath = resolve(derivedDir, 'runs.csv');
  const summaryPath = resolve(derivedDir, 'summary.json');
  if (!existsSync(csvPath) || !existsSync(summaryPath)) throw new Error(`Run summarize.mjs for ${phase} first.`);

  const csv = readFileSync(csvPath, 'utf8');
  const runs = parseCsv(csv);
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const manifest = await rawManifest(resultsRoot, phase);
  const markdown = [
    `# V1/V2 token-truth ${phase} checkpoint`,
    '',
    `Selected cells: **${summary.selected_runs.length}**. Selected invalid cells: **${runs.filter((run) => run.valid !== 'true').length}**.`,
    '',
    '## Aggregates',
    '',
    aggregateTable(summary.aggregates),
    '',
    '## Pre-registered ratios',
    '',
    ratioTable(summary.aggregates),
  ].join('\n');

  writeNew(resolve(outputDir, 'aggregate-and-ratios.md'), `${markdown}\n`, options.force);
  writeNew(resolve(outputDir, 'per-task.md'), perTaskTables(runs, phase), options.force);
  writeNew(resolve(outputDir, 'selected-runs.csv'), csv, options.force);
  writeNew(resolve(outputDir, 'raw-artifact-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, options.force);
  console.log(JSON.stringify({
    outputDir,
    selected_runs: summary.selected_runs.length,
    manifest_artifacts: manifest.artifact_count,
    manifest_bytes: manifest.total_bytes,
    tree_sha256: manifest.tree_sha256,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
