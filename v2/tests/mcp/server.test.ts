// v2/tests/mcp/server.test.ts
// Tests for the MCP server protocol compliance and tool dispatch.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '../../src/mcp/server.js';
import { HumanMemoryStore } from '../../src/human/store.js';
import { spawn, ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

interface McpResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

async function runMcpSession(input: string[], project: string): Promise<McpResponse[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI_PATH, 'mcp', '--project', project], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const stdout: string[] = [];
    proc.stdout.on('data', (d) => stdout.push(d.toString()));
    proc.on('error', reject);
    proc.on('close', () => {
      const lines = stdout.join('').split('\n').filter((l) => l.trim().length > 0);
      const responses: McpResponse[] = [];
      for (const line of lines) {
        try {
          responses.push(JSON.parse(line));
        } catch {
          // ignore non-JSON
        }
      }
      resolve(responses);
    });
    for (const line of input) {
      proc.stdin.write(line + '\n');
    }
    proc.stdin.end();
  });
}

describe('MCP server protocol compliance', () => {
  const project = 'mcp-test-project';

  it('responds to initialize with correct shape', async () => {
    const responses = await runMcpSession(
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      ],
      project
    );
    const initResp = responses.find((r) => r.id === 1);
    expect(initResp).toBeDefined();
    expect(initResp!.result.protocolVersion).toBe('2024-11-05');
    expect(initResp!.result.capabilities.tools).toBeDefined();
    expect(initResp!.result.serverInfo.name).toBe('codebase-memory-v2');
  });

  it('responds to ping', async () => {
    const responses = await runMcpSession(
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      ],
      project
    );
    const pingResp = responses.find((r) => r.id === 2);
    expect(pingResp).toBeDefined();
    expect(pingResp!.result).toEqual({});
  });

  it('lists 6 tools', async () => {
    const responses = await runMcpSession(
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      ],
      project
    );
    const listResp = responses.find((r) => r.id === 2);
    expect(listResp).toBeDefined();
    const toolNames = listResp!.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('get_project_overview');
    expect(toolNames).toContain('get_module_context');
    expect(toolNames).toContain('get_undocumented_hotspots');
    expect(toolNames).toContain('create_human_note');
    expect(toolNames).toContain('link_note_to_code_node');
    expect(toolNames).toContain('search_code_and_memory');
    expect(toolNames.length).toBe(6);
  });

  it('returns -32601 Method not found for unknown method', async () => {
    const responses = await runMcpSession(
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'unknown/method', params: {} }),
      ],
      project
    );
    const errResp = responses.find((r) => r.id === 2);
    expect(errResp).toBeDefined();
    expect(errResp!.error).toBeDefined();
    expect(errResp!.error.code).toBe(-32601);
    expect(errResp!.error.message).toContain('Method not found');
  });

  it('returns -32601 with available tools when tool name is unknown', async () => {
    const responses = await runMcpSession(
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nonexistent_tool', arguments: {} } }),
      ],
      project
    );
    const errResp = responses.find((r) => r.id === 2);
    expect(errResp).toBeDefined();
    expect(errResp!.error).toBeDefined();
    expect(errResp!.error.code).toBe(-32601);
    expect(errResp!.error.message).toContain('Tool not found');
    expect(errResp!.error.message).toContain('get_project_overview'); // lists available tools
  });

  it('returns -32600 Invalid Request for non-2.0 jsonrpc', async () => {
    const responses = await runMcpSession(
      [
        JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'initialize', params: {} }),
      ],
      project
    );
    const errResp = responses.find((r) => r.id === 1);
    expect(errResp).toBeDefined();
    expect(errResp!.error).toBeDefined();
    expect(errResp!.error.code).toBe(-32600);
  });

  it('handles batch requests', async () => {
    const responses = await runMcpSession(
      [
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
          { jsonrpc: '2.0', id: 2, method: 'ping' },
        ]),
      ],
      project
    );
    // Both responses should be returned.
    expect(responses.length).toBeGreaterThanOrEqual(2);
    expect(responses.find((r) => r.id === 1)).toBeDefined();
    expect(responses.find((r) => r.id === 2)).toBeDefined();
  });

  it('does not respond to notifications (no id)', async () => {
    const responses = await runMcpSession(
      [
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      ],
      project
    );
    // No response expected for notification.
    expect(responses.length).toBe(0);
  });
});

describe('MCP tool dispatch', () => {
  const project = 'mcp-tool-test-' + Date.now();

  it('create_human_note creates a node and returns its id', async () => {
    const responses = await runMcpSession(
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'create_human_note',
            arguments: {
              project,
              label: 'ADR',
              title: 'Test ADR for MCP',
              body_markdown: 'Some body',
              tags: ['test'],
            },
          },
        }),
      ],
      project
    );
    const toolResp = responses.find((r) => r.id === 2);
    expect(toolResp).toBeDefined();
    expect(toolResp!.error).toBeUndefined();
    const text = toolResp!.result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(true);
    expect(parsed.node.label).toBe('ADR');
    expect(parsed.node.title).toBe('Test ADR for MCP');
    expect(parsed.node.id).toBeGreaterThan(0);
  });

  it('create_human_note rejects invalid label with clear error', async () => {
    const responses = await runMcpSession(
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'create_human_note',
            arguments: {
              project,
              label: 'InvalidLabel',
              title: 'Test',
            },
          },
        }),
      ],
      project
    );
    const toolResp = responses.find((r) => r.id === 2);
    expect(toolResp).toBeDefined();
    // The error is returned as a tool result with isError: true (not as JSON-RPC error).
    const text = toolResp!.result.content[0].text;
    expect(text).toContain('Error');
  });

  it('search_code_and_memory finds previously created notes', async () => {
    const responses = await runMcpSession(
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'create_human_note',
            arguments: {
              project,
              label: 'BugNote',
              title: 'Bug: Search test bug',
              body_markdown: 'something to find via search',
            },
          },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'search_code_and_memory',
            arguments: {
              project,
              query: 'search test',
              search_code: false,
            },
          },
        }),
      ],
      project
    );
    const searchResp = responses.find((r) => r.id === 3);
    expect(searchResp).toBeDefined();
    const text = searchResp!.result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.total_matches).toBeGreaterThan(0);
    expect(parsed.results[0].title).toContain('Search test');
  });
});
