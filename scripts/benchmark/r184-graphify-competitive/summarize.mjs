#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  gradeAnswer,
  normalizePath,
  sha256File,
  writeJsonExclusive,
} from './core.mjs';
import { auditCommand } from './command-audit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, 'spec.json'), 'utf8'));
const graphifyTools = new Set([
  'query_graph',
  'get_node',
  'get_neighbors',
  'shortest_path',
  'get_community',
  'god_nodes',
  'graph_stats',
]);
const ariadTools = new Set([
  'get_project_overview',
  'get_module_context',
  'get_undocumented_hotspots',
  'search_code_and_memory',
  'lookup_source_text',
  'prepare_edit_context',
]);
const sourceMcpTools = new Set(['lookup_source_text', 'prepare_edit_context']);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replaceAll('-', '_');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function walk(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function parseJsonl(path) {
  const events = [];
  const malformed = [];
  readFileSync(path, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (!line) return;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformed.push(index + 1);
    }
  });
  return { events, malformed };
}

function parseTrace(path) {
  if (!existsSync(path)) return { events: [], malformed: [] };
  return parseJsonl(path);
}

function taskFor(id) {
  const task = spec.tasks.find((entry) => entry.id === id);
  if (!task) throw new Error(`Unknown task in metadata: ${id}`);
  return task;
}

function allowedMcp(condition) {
  if (condition === 'B' || condition === 'C') return graphifyTools;
  if (condition === 'D') return ariadTools;
  return new Set();
}

function commandText(item) {
  if (typeof item.command === 'string') return item.command;
  if (Array.isArray(item.command)) return item.command.join(' ');
  return JSON.stringify(item.command ?? '');
}

function parseMaybeJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const candidates = [value];
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const firstBrace = value.indexOf('{');
  const lastBrace = value.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(value.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next representation.
    }
  }
  return null;
}

function findMetadata(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) findMetadata(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  const picked = {};
  for (const key of [
    'complete',
    'truncated',
    'stale',
    'fresh',
    'coverage_complete',
    'incomplete_reasons',
    'matches_truncated',
    'alternative_chains_truncated',
  ]) {
    if (Object.hasOwn(value, key)) picked[key] = value[key];
  }
  if (Object.keys(picked).length) found.push(picked);
  for (const child of Object.values(value)) findMetadata(child, found);
  return found;
}

function containsHumanEvidence(value, seenStrings = new Set()) {
  if (typeof value === 'string') {
    if (seenStrings.has(value)) return false;
    seenStrings.add(value);
    const parsed = parseMaybeJson(value);
    return parsed !== null && parsed !== value
      ? containsHumanEvidence(parsed, seenStrings)
      : false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsHumanEvidence(item, seenStrings));
  }
  if (!value || typeof value !== 'object') return false;
  if (
    Number(value.human_matches_returned ?? value.human_matches ?? 0) > 0
    || value.type === 'human'
  ) {
    return true;
  }
  return Object.values(value).some((item) => containsHumanEvidence(item, seenStrings));
}

function aggregate(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.phase}|${row.mode}|${row.condition}`;
    const current = groups.get(key) ?? {
      phase: row.phase,
      mode: row.mode,
      condition: row.condition,
      condition_name: row.condition_name,
      runs: 0,
      valid_runs: 0,
      pass: 0,
      partial: 0,
      fail: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      tool_calls: 0,
      successful_tool_calls: 0,
      failed_tool_calls: 0,
      source_calls: 0,
      mcp_calls: 0,
      wall_ms: 0,
      graph_used_runs: 0,
      vault_used_runs: 0,
    };
    current.runs += 1;
    current.valid_runs += row.valid ? 1 : 0;
    current[row.grade.toLowerCase()] += 1;
    for (const field of [
      'input_tokens',
      'cached_input_tokens',
      'output_tokens',
      'total_tokens',
      'tool_calls',
      'successful_tool_calls',
      'failed_tool_calls',
      'source_calls',
      'mcp_calls',
      'wall_ms',
    ]) {
      if (Number.isFinite(row[field])) current[field] += row[field];
    }
    current.graph_used_runs += row.graph_used ? 1 : 0;
    current.vault_used_runs += row.vault_used ? 1 : 0;
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) =>
    `${a.phase}|${a.mode}|${a.condition}`.localeCompare(
      `${b.phase}|${b.mode}|${b.condition}`,
    ));
}

function csvCell(value) {
  const text = value == null ? '' : Array.isArray(value) ? value.join('; ') : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseRun(metaPath, resultsRoot) {
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const stem = metaPath.slice(0, -'.meta.json'.length);
  const paths = {
    jsonl: `${stem}.jsonl`,
    stderr: `${stem}.stderr.txt`,
    prompt: `${stem}.prompt.txt`,
    trace: `${stem}.mcp-trace.jsonl`,
  };
  const violations = [];
  for (const [role, path] of Object.entries(paths)) {
    if (!existsSync(path)) violations.push(`missing ${role}: ${path}`);
  }
  if (violations.length) {
    return {
      phase: meta.phase,
      mode: meta.mode,
      repetition: meta.repetition,
      condition: meta.condition,
      condition_name: meta.condition_name,
      task: meta.task,
      target: meta.target,
      valid: false,
      violations,
      grade: 'FAIL',
    };
  }
  for (const [role, field] of [
    ['jsonl', 'jsonl'],
    ['stderr', 'stderr'],
    ['prompt', 'prompt'],
    ['trace', 'mcp_trace'],
  ]) {
    const observed = sha256File(paths[role]);
    if (observed !== meta.sha256[field]) {
      violations.push(`${role} checksum mismatch`);
    }
  }

  const raw = parseJsonl(paths.jsonl);
  const trace = parseTrace(paths.trace);
  if (raw.malformed.length) violations.push(`malformed JSONL lines: ${raw.malformed.join(',')}`);
  if (trace.malformed.length) violations.push(`malformed MCP trace lines: ${trace.malformed.join(',')}`);

  let usage = null;
  let finalAnswer = '';
  const toolSequence = [];
  const toolPayloads = [];
  const completenessMetadata = [];
  for (const event of raw.events) {
    if (event.type === 'turn.completed') usage = event.usage;
    if (event.type !== 'item.completed') continue;
    const item = event.item ?? {};
    if (item.type === 'agent_message') finalAnswer = item.text ?? '';
    if (item.type === 'mcp_tool_call') {
      const tool = item.tool;
      toolSequence.push(`mcp:${tool}`);
      if (!allowedMcp(meta.condition).has(tool)) {
        violations.push(`forbidden MCP tool: ${tool}`);
      }
      const parsedResult = parseMaybeJson(item.result);
      findMetadata(parsedResult, completenessMetadata);
      toolPayloads.push({
        kind: 'mcp',
        tool,
        status: item.status ?? 'unknown',
        human_memory_used: containsHumanEvidence(parsedResult),
        request_bytes: Buffer.byteLength(JSON.stringify(item.arguments ?? '')),
        response_bytes: Buffer.byteLength(JSON.stringify(item.result ?? item.error ?? '')),
      });
    }
    if (item.type === 'command_execution') {
      const command = commandText(item);
      toolSequence.push('command:exec');
      const commandViolation = auditCommand(command);
      if (commandViolation) violations.push(commandViolation);
      toolPayloads.push({
        kind: 'command',
        tool: 'exec',
        status: item.status ?? 'unknown',
        command,
        request_bytes: Buffer.byteLength(command),
        response_bytes: Buffer.byteLength(JSON.stringify(item.aggregated_output ?? item.output ?? '')),
      });
    }
  }
  if (!usage) violations.push('missing native turn.completed usage');
  if (meta.exit_code !== 0) violations.push(`Codex exit ${meta.exit_code}`);
  if (meta.timed_out) violations.push('run timed out');
  if (!finalAnswer) violations.push('missing final answer');

  const completedMcp = toolPayloads.filter((item) => item.kind === 'mcp').length;
  const tracedMcp = trace.events.filter((event) =>
    event.event === 'rpc_completed' && event.method === 'tools/call').length;
  if (completedMcp !== tracedMcp) {
    violations.push(`MCP trace mismatch: ${completedMcp} completed vs ${tracedMcp} traced`);
  }
  const grade = gradeAnswer(taskFor(meta.task), finalAnswer);
  const input = usage?.input_tokens ?? null;
  const cached = usage?.cached_input_tokens ?? null;
  const output = usage?.output_tokens ?? null;
  const normalizedVault = meta.vault_root ? normalizePath(meta.vault_root).toLowerCase() : null;
  const vaultUsed = normalizedVault
    ? toolPayloads.some((item) =>
        item.kind === 'command'
        && normalizePath(item.command).toLowerCase().includes(normalizedVault))
    : false;
  const sourceCalls = toolPayloads.filter((item) => (
    item.kind === 'command' || (item.kind === 'mcp' && sourceMcpTools.has(item.tool))
  )).length;
  const graphUsed = toolPayloads.some((item) => (
    item.kind === 'mcp'
    && item.status === 'completed'
    && !sourceMcpTools.has(item.tool)
  ));
  const humanMemoryUsed = toolPayloads.some((item) => (
    item.kind === 'mcp' && item.status === 'completed' && item.human_memory_used
  ));
  const evidenceCause = [
    graphUsed ? 'graph' : null,
    vaultUsed ? 'vault' : null,
    humanMemoryUsed ? 'human-memory' : null,
    sourceCalls ? 'source' : null,
  ].filter(Boolean).join('+') || 'none';

  return {
    phase: meta.phase,
    mode: meta.mode,
    repetition: meta.repetition,
    condition: meta.condition,
    condition_name: meta.condition_name,
    task: meta.task,
    target: meta.target,
    valid: violations.length === 0,
    violations,
    grade: grade.grade,
    exact: grade.exact,
    correct_atoms: grade.correct_atoms,
    expected_atoms: grade.expected_atoms,
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    total_tokens: input === null || output === null ? null : input + output,
    uncached_input_plus_output:
      input === null || cached === null || output === null ? null : input - cached + output,
    tool_calls: toolPayloads.length,
    successful_tool_calls: toolPayloads.filter((item) => item.status === 'completed').length,
    failed_tool_calls: toolPayloads.filter((item) => item.status !== 'completed').length,
    source_calls: sourceCalls,
    mcp_calls: completedMcp,
    graph_used: graphUsed,
    vault_used: vaultUsed,
    human_memory_used: humanMemoryUsed,
    evidence_cause: evidenceCause,
    first_evidence_ms: meta.first_evidence_ms,
    wall_ms: meta.wall_ms,
    tool_sequence: toolSequence,
    tool_request_bytes: toolPayloads.reduce((sum, item) => sum + item.request_bytes, 0),
    tool_response_bytes: toolPayloads.reduce((sum, item) => sum + item.response_bytes, 0),
    completeness_metadata: completenessMetadata,
    normalized_answer: finalAnswer.replaceAll('\r', '').trim(),
    raw_jsonl: relative(resultsRoot, paths.jsonl).replaceAll('\\', '/'),
    metadata: relative(resultsRoot, metaPath).replaceAll('\\', '/'),
  };
}

const options = parseArgs(process.argv.slice(2));
for (const required of ['results_root', 'phase', 'output']) {
  if (!options[required]) throw new Error(`Missing --${required.replaceAll('_', '-')}`);
}
const resultsRoot = resolve(options.results_root);
const phaseRoot = join(resultsRoot, options.phase);
const metaFiles = walk(phaseRoot).filter((path) => path.endsWith('.meta.json'));
if (!metaFiles.length) throw new Error(`No metadata files under ${phaseRoot}`);
const rows = metaFiles.map((path) => parseRun(path, resultsRoot)).sort((a, b) =>
  [
    a.phase, a.mode, String(a.repetition), a.task, a.condition,
  ].join('|').localeCompare([
    b.phase, b.mode, String(b.repetition), b.task, b.condition,
  ].join('|')),
);
const result = {
  schema_version: 1,
  benchmark_id: spec.benchmark_id,
  generated_at_utc: new Date().toISOString(),
  phase: options.phase,
  raw_root_role: resultsRoot.split(/[\\/]/).at(-1),
  rows,
  aggregates: aggregate(rows),
};
writeJsonExclusive(resolve(options.output), result);

const csvPath = resolve(options.output).replace(/\.json$/i, '.csv');
const fields = [
  'phase', 'mode', 'repetition', 'task', 'target', 'condition', 'condition_name',
  'valid', 'grade', 'input_tokens', 'cached_input_tokens', 'output_tokens',
  'total_tokens', 'tool_calls', 'source_calls', 'mcp_calls', 'graph_used',
  'successful_tool_calls', 'failed_tool_calls', 'vault_used', 'human_memory_used',
  'evidence_cause', 'first_evidence_ms', 'wall_ms', 'violations',
];
const csv = [
  fields.join(','),
  ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(',')),
].join('\n');
writeFileSync(csvPath, `${csv}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({
  output: resolve(options.output),
  csv: csvPath,
  runs: rows.length,
  invalid: rows.filter((row) => !row.valid).length,
}, null, 2));
