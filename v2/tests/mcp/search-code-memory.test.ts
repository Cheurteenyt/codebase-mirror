import { describe, expect, it } from 'vitest';
import type { HumanMemoryStore } from '../../src/human/store.js';
import { SearchCodeAndMemoryTool } from '../../src/mcp/tools/search_code_and_memory.js';

describe('search_code_and_memory result budgeting', () => {
  it('returns a human-only match when both sources are enabled with limit 1', async () => {
    const humanStore = {
      searchHumanNodes: (_project: string, _query: string, limit: number) => {
        expect(limit).toBe(2);
        return [{
          id: 7,
          label: 'ADR',
          title: 'Authentication decision',
          slug: 'authentication-decision',
          status: 'active',
          obsidian_path: null,
          body_markdown: 'Use signed sessions.',
        }];
      },
    } as unknown as HumanMemoryStore;
    const tool = new SearchCodeAndMemoryTool({ project: 'test', humanStore });

    const response = await tool.handle({ query: 'authentication', limit: 1 });
    expect(response.isError).not.toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload).toMatchObject({
      returned_matches: 1,
      total_matches: 1,
      matches_truncated: false,
      code_matches_returned: 0,
      human_matches_returned: 1,
    });
    expect(payload.results[0]).toMatchObject({ type: 'human', human_node_id: 7 });
  });
});
