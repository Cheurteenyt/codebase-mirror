#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'));
const conditionNames = { A: 'v1-mcp', B: 'v2-mcp', C: 'grep-read', D: 'hybrid' };
const allowedMcp = {
  A: new Set(['search_graph', 'query_graph', 'trace_call_path', 'get_code_snippet', 'get_graph_schema', 'get_architecture', 'search_code', 'list_projects', 'index_status', 'detect_changes']),
  B: new Set(['get_project_overview', 'get_module_context', 'get_undocumented_hotspots', 'search_code_and_memory', 'prepare_edit_context', 'lookup_source_text']),
  C: new Set(),
  D: new Set(['get_project_overview', 'get_module_context', 'get_undocumented_hotspots', 'search_code_and_memory', 'prepare_edit_context', 'lookup_source_text']),
};

function parseArgs(argv) {
  const result = {};
  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2).replaceAll('-', '_');
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}

function filesUnder(root, suffix) {
  if (!existsSync(root)) return [];
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path, suffix));
    else if (entry.name.endsWith(suffix)) found.push(path);
  }
  return found.sort();
}

function normalizeText(value) {
  let text = String(value ?? '').replaceAll('\r\n', '\n').replaceAll('\\', '/').trim();
  const fenced = text.match(/^```(?:json|text)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) text = fenced[1].trim();
  return text;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function flatten(value, prefix = '') {
  if (Array.isArray(value)) return value.map((item, index) => [`${prefix}[${index}]`, item]);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key));
  }
  return [[prefix, value]];
}

function subsetGrade(actualElements, expectedElements, ordered = false) {
  const required = Math.ceil(expectedElements.length / 2);
  if (actualElements.length < required || actualElements.length > expectedElements.length) return 'FAIL';
  if (ordered) {
    let position = 0;
    for (const actual of actualElements) {
      while (position < expectedElements.length && !equal(actual, expectedElements[position])) position += 1;
      if (position === expectedElements.length) return 'FAIL';
      position += 1;
    }
    return 'PARTIAL';
  }
  const unused = [...expectedElements];
  for (const actual of actualElements) {
    const index = unused.findIndex((expected) => equal(actual, expected));
    if (index < 0) return 'FAIL';
    unused.splice(index, 1);
  }
  return 'PARTIAL';
}

export function gradeAnswer(task, rawAnswer) {
  const normalized = normalizeText(rawAnswer);
  if (!normalized) return { grade: 'FAIL', normalized, reason: 'empty answer' };
  if (task.answer_format === 'text') {
    const expected = normalizeText(task.answer);
    return normalized === expected
      ? { grade: 'PASS', normalized, reason: 'exact scalar' }
      : { grade: 'FAIL', normalized, reason: 'scalar mismatch' };
  }
  if (task.answer_format === 'chain') {
    const actual = normalized.split(/\s*->\s*/).filter(Boolean);
    const expected = task.answer.map(normalizeText);
    if (equal(actual, expected)) return { grade: 'PASS', normalized, reason: 'exact ordered chain' };
    return { grade: subsetGrade(actual, expected, true), normalized, reason: 'ordered-chain comparison' };
  }
  let actual;
  try {
    actual = JSON.parse(normalized);
  } catch {
    return { grade: 'FAIL', normalized, reason: 'malformed JSON' };
  }
  if (equal(actual, task.answer)) return { grade: 'PASS', normalized: JSON.stringify(actual), reason: 'exact JSON' };
  if (Array.isArray(task.answer) && Array.isArray(actual)) {
    return { grade: subsetGrade(actual, task.answer), normalized: JSON.stringify(actual), reason: 'JSON set comparison' };
  }
  if (task.answer && typeof task.answer === 'object' && actual && typeof actual === 'object' && !Array.isArray(actual)) {
    const expectedLeaves = flatten(task.answer).map(([path, value]) => ({ path, value }));
    const actualLeaves = flatten(actual).map(([path, value]) => ({ path, value }));
    return { grade: subsetGrade(actualLeaves, expectedLeaves), normalized: JSON.stringify(actual), reason: 'JSON leaf comparison' };
  }
  return { grade: 'FAIL', normalized: JSON.stringify(actual), reason: 'JSON type mismatch' };
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null));
}

function extractMetadata(value, path = '', output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    value.forEach((item, index) => extractMetadata(item, `${path}[${index}]`, output));
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    if (/(?:truncat|complete|coverage|scanned|returned|total|limit|offset)/i.test(key) && (item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
      output.push({ path: next, value: item });
    }
    extractMetadata(item, next, output);
  }
  return output;
}

function parseJsonl(path) {
  const events = [];
  const malformed = [];
  for (const [index, line] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformed.push(index + 1);
    }
  }
  return { events, malformed };
}

function parseMcpTrace(path) {
  return parseJsonl(path).events.filter((event) => event.event === 'rpc_completed');
}

function taskFor(targetId, taskId) {
  const target = spec.targets.find((item) => item.id === targetId);
  const task = target?.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Unknown task ${targetId}/${taskId}`);
  return task;
}

function invalidKey(item) {
  return [item.phase, item.mode, item.target, item.task, item.condition, item.attempt].join('|');
}

function parseRun(metaPath, invalidReasons) {
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const stem = metaPath.slice(0, -'.meta.json'.length);
  const raw = parseJsonl(`${stem}.jsonl`);
  const mcpTrace = parseMcpTrace(`${stem}.mcp-trace.jsonl`);
  const task = taskFor(meta.target, meta.task);
  let finalAnswer = '';
  let usage;
  const toolSequence = [];
  const toolPayloads = [];
  const completeness = [];
  const violations = [];
  let mcpIndex = 0;

  for (const event of raw.events) {
    if (event.type === 'turn.completed') usage = event.usage;
    if (event.type !== 'item.completed') continue;
    const item = event.item ?? {};
    if (item.type === 'agent_message') finalAnswer = item.text ?? '';
    if (item.type === 'mcp_tool_call') {
      const tool = item.tool;
      toolSequence.push(`mcp:${tool}`);
      if (!allowedMcp[meta.condition].has(tool)) violations.push(`forbidden MCP tool: ${tool}`);
      const trace = mcpTrace.filter((entry) => entry.method === 'tools/call')[mcpIndex++];
      toolPayloads.push({
        kind: 'mcp', tool,
        request_bytes_jsonl: byteLength(item.arguments),
        response_bytes_jsonl: byteLength(item.result ?? item.error),
        request_bytes_wire: trace?.request_json_bytes ?? null,
        response_bytes_wire: trace?.response_json_bytes ?? null,
        latency_ms: trace?.duration_ms ?? null,
      });
      extractMetadata(item.result, tool, completeness);
    }
    if (item.type === 'command_execution') {
      toolSequence.push('command:exec');
      if (meta.condition === 'A' || meta.condition === 'B') violations.push('forbidden command execution in MCP-only condition');
      toolPayloads.push({
        kind: 'command', tool: 'exec',
        command: item.command ?? null,
        request_bytes_jsonl: byteLength(item.command),
        response_bytes_jsonl: byteLength(item.aggregated_output ?? item.output ?? item),
        request_bytes_wire: null,
        response_bytes_wire: null,
        latency_ms: null,
      });
    }
  }
  if (meta.condition === 'C' && toolSequence.some((item) => item.startsWith('mcp:'))) violations.push('MCP call in grep/read condition');
  const completedMcpCalls = toolPayloads.filter((item) => item.kind === 'mcp').length;
  const tracedMcpCalls = mcpTrace.filter((entry) => entry.method === 'tools/call').length;
  if (completedMcpCalls !== tracedMcpCalls) violations.push(`MCP trace mismatch: ${completedMcpCalls} completed JSONL calls, ${tracedMcpCalls} traced calls`);
  if (!usage) violations.push('missing native turn.completed usage');
  if (raw.malformed.length) violations.push(`malformed JSONL lines: ${raw.malformed.join(',')}`);
  const listedInvalid = invalidReasons.get(invalidKey(meta));
  if (listedInvalid) violations.push(`declared invalid: ${listedInvalid}`);
  const grade = gradeAnswer(task, finalAnswer);
  const input = usage?.input_tokens ?? null;
  const cached = usage?.cached_input_tokens ?? null;
  const output = usage?.output_tokens ?? null;
  const toolRequestBytes = toolPayloads.reduce((sum, item) => sum + item.request_bytes_jsonl, 0);
  const toolResponseBytes = toolPayloads.reduce((sum, item) => sum + item.response_bytes_jsonl, 0);
  const exploratoryPayloads = toolPayloads.slice(1);
  const rpcLatencies = toolPayloads.map((item) => item.latency_ms).filter((value) => Number.isFinite(value));
  const toolsList = mcpTrace.find((entry) => entry.method === 'tools/list');
  return {
    phase: meta.phase, mode: meta.mode, target: meta.target, task: meta.task,
    condition: meta.condition, condition_name: conditionNames[meta.condition], attempt: meta.attempt,
    valid: violations.length === 0, violations,
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    raw_total_tokens: input === null || output === null ? null : input + output,
    uncached_input_plus_output: input === null || cached === null || output === null ? null : input - cached + output,
    tool_calls: toolSequence.length,
    exploratory_calls: Math.max(0, toolSequence.length - 1),
    tool_sequence: toolSequence,
    tool_request_bytes: toolRequestBytes,
    tool_response_bytes: toolResponseBytes,
    exploratory_request_bytes: exploratoryPayloads.reduce((sum, item) => sum + item.request_bytes_jsonl, 0),
    exploratory_response_bytes: exploratoryPayloads.reduce((sum, item) => sum + item.response_bytes_jsonl, 0),
    mcp_query_latency_ms: rpcLatencies.reduce((sum, value) => sum + value, 0),
    mcp_schema_response_bytes: toolsList?.response_json_bytes ?? 0,
    prompt_bytes: Buffer.byteLength(meta.prompt ?? ''),
    prior_observed_context_bytes: 0,
    wall_ms: meta.wall_ms,
    grade: grade.grade,
    grade_reason: grade.reason,
    normalized_answer: grade.normalized,
    completeness_metadata: completeness,
    tool_payloads: toolPayloads,
    raw_jsonl: relative(resolve(metaPath, '../../../../..'), `${stem}.jsonl`).replaceAll('\\', '/'),
    source_meta: metaPath,
  };
}

function aggregate(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = [run.phase, run.mode, run.target, run.condition].join('|');
    const group = groups.get(key) ?? {
      phase: run.phase, mode: run.mode, target: run.target, condition: run.condition,
      condition_name: run.condition_name, runs: 0, input_tokens: 0, cached_input_tokens: 0,
      output_tokens: 0, raw_total_tokens: 0, uncached_input_plus_output: 0, tool_calls: 0,
      exploratory_calls: 0,
      tool_request_bytes: 0, tool_response_bytes: 0, mcp_query_latency_ms: 0,
      wall_ms: 0, PASS: 0, PARTIAL: 0, FAIL: 0,
    };
    group.runs += 1;
    for (const field of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'raw_total_tokens', 'uncached_input_plus_output', 'tool_calls', 'exploratory_calls', 'tool_request_bytes', 'tool_response_bytes', 'mcp_query_latency_ms', 'wall_ms']) {
      group[field] += run[field] ?? 0;
    }
    group[run.grade] += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => `${a.phase}${a.mode}${a.target}${a.condition}`.localeCompare(`${b.phase}${b.mode}${b.target}${b.condition}`));
}

function csvCell(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(runs) {
  const fields = ['phase', 'mode', 'target', 'task', 'condition', 'attempt', 'valid', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'raw_total_tokens', 'uncached_input_plus_output', 'tool_calls', 'exploratory_calls', 'tool_request_bytes', 'tool_response_bytes', 'exploratory_request_bytes', 'exploratory_response_bytes', 'prior_observed_context_bytes', 'mcp_query_latency_ms', 'mcp_schema_response_bytes', 'wall_ms', 'grade', 'violations', 'tool_sequence', 'normalized_answer'];
  return `${fields.join(',')}\n${runs.map((run) => fields.map((field) => csvCell(run[field])).join(',')).join('\n')}\n`;
}

function toMarkdown(aggregates) {
  const lines = [
    '# Native benchmark summary', '',
    '| Phase | Mode | Target | Condition | Runs | Input | Cached | Output | Raw total | Uncached + output | Calls | PASS | PARTIAL | FAIL |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of aggregates) {
    lines.push(`| ${row.phase} | ${row.mode} | ${row.target} | ${row.condition} ${row.condition_name} | ${row.runs} | ${row.input_tokens} | ${row.cached_input_tokens} | ${row.output_tokens} | ${row.raw_total_tokens} | ${row.uncached_input_plus_output} | ${row.tool_calls} | ${row.PASS} | ${row.PARTIAL} | ${row.FAIL} |`);
  }
  return `${lines.join('\n')}\n`;
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function main() {
  const options = parseArgs(process.argv);
  const resultsRoot = resolve(options.results_root || 'D:/Mycodex/benchmark-results/r173-v1-v2-truth');
  const phase = options.phase || 'baseline';
  const phaseRoot = join(resultsRoot, phase);
  const invalidPath = join(resultsRoot, 'invalid-runs.json');
  const invalid = existsSync(invalidPath) ? JSON.parse(readFileSync(invalidPath, 'utf8')).invalid ?? [] : [];
  const invalidReasons = new Map(invalid.map((item) => [invalidKey(item), item.reason]));
  const allRuns = filesUnder(phaseRoot, '.meta.json').map((path) => parseRun(path, invalidReasons));
  const selected = [];
  const attempts = new Map();
  for (const run of allRuns) {
    const key = [run.phase, run.mode, run.target, run.task, run.condition].join('|');
    const values = attempts.get(key) ?? [];
    values.push(run);
    attempts.set(key, values);
  }
  for (const values of attempts.values()) {
    values.sort((a, b) => a.attempt - b.attempt);
    const first = values[0];
    if (first.valid) selected.push(first);
    else if (values[1]) selected.push(values[1]);
    else selected.push(first);
  }
  selected.sort((a, b) => `${a.mode}${a.target}${a.task}${a.condition}`.localeCompare(`${b.mode}${b.target}${b.task}${b.condition}`));
  const continuousGroups = new Map();
  for (const run of selected.filter((item) => item.mode === 'continuous')) {
    const key = `${run.phase}|${run.target}|${run.condition}`;
    const group = continuousGroups.get(key) ?? [];
    group.push(run);
    continuousGroups.set(key, group);
  }
  for (const group of continuousGroups.values()) {
    group.sort((a, b) => a.task.localeCompare(b.task));
    let historyBytes = 0;
    for (const run of group) {
      run.prior_observed_context_bytes = historyBytes;
      historyBytes += run.prompt_bytes + run.tool_request_bytes + run.tool_response_bytes + Buffer.byteLength(run.normalized_answer ?? '');
    }
  }
  const aggregates = aggregate(selected);
  const outputDir = resolve(options.output_dir || join(resultsRoot, 'derived', phase));
  if (existsSync(outputDir) && readdirSync(outputDir).length > 0 && !options.force) {
    throw new Error(`Refusing to overwrite non-empty derived directory: ${outputDir}; pass --force after preserving the prior output.`);
  }
  mkdirSync(outputDir, { recursive: true });
  const summaryPath = join(outputDir, 'summary.json');
  const csvPath = join(outputDir, 'runs.csv');
  const markdownPath = join(outputDir, 'summary.md');
  writeFileSync(summaryPath, `${JSON.stringify({ schema_version: 1, generated_at: new Date().toISOString(), phase, selected_runs: selected, all_attempts: allRuns, aggregates }, null, 2)}\n`);
  writeFileSync(csvPath, toCsv(selected));
  writeFileSync(markdownPath, toMarkdown(aggregates));
  const manifest = [summaryPath, csvPath, markdownPath].map((path) => ({ path: relative(resultsRoot, path).replaceAll('\\', '/'), bytes: statSync(path).size, sha256: hashFile(path) }));
  writeFileSync(join(outputDir, 'derived-checksums.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ selected_runs: selected.length, invalid_selected: selected.filter((run) => !run.valid).length, outputDir, aggregates }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
