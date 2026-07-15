import { describe, expect, it } from 'vitest';
import { BaseTool } from '../../src/mcp/tools/base.js';
import type { McpServerOptions } from '../../src/mcp/server.js';
import type { ToolDefinition } from '../../src/mcp/tools/index.js';

class JsonProbeTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'json_probe',
      description: 'Test-only JSON response probe',
      inputSchema: { type: 'object' },
      handler: JsonProbeTool,
    };
  }

  async handle(args: Record<string, unknown>) {
    return this.json(args);
  }
}

describe('BaseTool JSON response encoding', () => {
  it('uses compact JSON by default while preserving the exact response schema', async () => {
    const payload = {
      project: 'example',
      found: true,
      module: {
        id: 42,
        labels: ['File', 'Function'],
        metadata: { documented: false, risk_score: 0.375 },
      },
      optional: null,
    };
    const tool = new JsonProbeTool({
      project: 'example',
      humanStore: null,
    } as unknown as McpServerOptions);

    const response = await tool.handle(payload);
    const compact = response.content[0].text;
    const pretty = JSON.stringify(payload, null, 2);

    expect(compact).toBe(JSON.stringify(payload));
    expect(JSON.parse(compact)).toStrictEqual(payload);
    expect(compact).not.toContain('\n');
    expect(compact.length).toBeLessThan(pretty.length);
  });
});
