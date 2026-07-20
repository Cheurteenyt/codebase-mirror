#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

const separator = process.argv.indexOf('--');
if (separator < 0 || separator === process.argv.length - 1) {
  console.error('Usage: audit-mcp-proxy.mjs <permitted-tool>... -- <server-command> [args...]');
  process.exit(2);
}

const permitted = new Set(process.argv.slice(2, separator));
const exposeAll = process.env.CBM_MCP_EXPOSE_ALL === '1';
const traceFile = process.env.CBM_MCP_TRACE_FILE;
const [command, ...args] = process.argv.slice(separator + 1);
const pending = new Map();

if (!traceFile) {
  console.error('CBM_MCP_TRACE_FILE is required.');
  process.exit(2);
}
mkdirSync(dirname(traceFile), { recursive: true });

function trace(event) {
  appendFileSync(traceFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8');
}

trace({
  event: 'proxy_started',
  expose_all: exposeAll,
  permitted_tools: [...permitted],
  server_command: command,
  server_args: args,
});

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: process.env.CBM_V1_HOME ?? process.env.HOME,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let clientBuffer = '';
let serverBuffer = '';

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function serialized(message) {
  return JSON.stringify(message);
}

function writeMessage(stream, message) {
  const value = serialized(message);
  stream.write(`${value}\n`);
  return value;
}

function rememberRequest(message, wireLine) {
  if (message.id === undefined) return;
  pending.set(String(message.id), {
    started_ns: process.hrtime.bigint(),
    method: message.method,
    tool: message.method === 'tools/call' ? message.params?.name : undefined,
    request_json_bytes: Buffer.byteLength(serialized(message)),
    request_wire_bytes: Buffer.byteLength(`${wireLine}\n`),
  });
}

function recordResponse(message, wireLine) {
  if (message.id === undefined) return;
  const request = pending.get(String(message.id));
  if (!request) return;
  pending.delete(String(message.id));
  trace({
    event: 'rpc_completed',
    id: message.id,
    method: request.method,
    tool: request.tool,
    request_json_bytes: request.request_json_bytes,
    request_wire_bytes: request.request_wire_bytes,
    response_json_bytes: Buffer.byteLength(serialized(message)),
    response_wire_bytes: Buffer.byteLength(`${wireLine}\n`),
    duration_ms: Number(process.hrtime.bigint() - request.started_ns) / 1e6,
    is_error: Boolean(message.error),
  });
}

function rejectForbidden(message, wireLine) {
  rememberRequest(message, wireLine);
  const response = {
    jsonrpc: '2.0',
    id: message.id,
    error: {
      code: -32601,
      message: `Tool is not permitted by the read-only benchmark proxy: ${String(message.params?.name)}`,
    },
  };
  const value = writeMessage(process.stdout, response);
  recordResponse(response, value);
}

function forwardClientLine(line) {
  const message = parseLine(line);
  if (!message) {
    child.stdin.write(`${line}\n`);
    return;
  }

  if (message.method === 'tools/call' && !permitted.has(message.params?.name)) {
    if (message.id !== undefined) rejectForbidden(message, line);
    return;
  }

  rememberRequest(message, line);
  child.stdin.write(`${line}\n`);
}

function forwardServerLine(line) {
  const message = parseLine(line);
  if (!message) {
    process.stdout.write(`${line}\n`);
    return;
  }
  if (!exposeAll && message.result?.tools && Array.isArray(message.result.tools)) {
    message.result.tools = message.result.tools
      .filter((tool) => permitted.has(tool.name))
      .map((tool) => ({
        ...tool,
        annotations: {
          title: tool.name,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      }));
  }
  const value = writeMessage(process.stdout, message);
  recordResponse(message, value);
}

function consume(chunk, side) {
  const isClient = side === 'client';
  let buffer = (isClient ? clientBuffer : serverBuffer) + chunk.toString('utf8');
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line) continue;
    if (isClient) forwardClientLine(line);
    else forwardServerLine(line);
  }
  if (isClient) clientBuffer = buffer;
  else serverBuffer = buffer;
}

process.stdin.on('data', (chunk) => consume(chunk, 'client'));
child.stdout.on('data', (chunk) => consume(chunk, 'server'));
child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  trace({ event: 'server_stderr', source_bytes: chunk.byteLength, text });
  process.stderr.write(text);
});
process.stdin.on('end', () => child.stdin.end());

child.on('error', (error) => {
  trace({ event: 'server_start_error', message: error.message });
  console.error(`Failed to start MCP server: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (serverBuffer) process.stdout.write(`${serverBuffer}\n`);
  trace({ event: 'proxy_stopped', code, signal, pending_request_count: pending.size });
  if (signal) console.error(`MCP server exited from signal ${signal}`);
  process.exitCode = code ?? 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
