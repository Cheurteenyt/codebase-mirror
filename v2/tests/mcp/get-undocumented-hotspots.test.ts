import { describe, expect, it } from 'vitest';
import type { CodeGraphReader } from '../../src/bridge/sqlite-ro.js';
import type { HumanMemoryStore } from '../../src/human/store.js';
import { GetUndocumentedHotspotsTool } from '../../src/mcp/tools/get_undocumented_hotspots.js';

describe('get_undocumented_hotspots totals', () => {
  it('reports more than 50 hotspots and deduplicates critical modules', async () => {
    const functions = Array.from({ length: 60 }, (_, index) => ({
      id: index + 1,
      project: 'test',
      label: 'Function',
      name: `fn-${index}`,
      qualified_name: `test.fn-${index}`,
      file_path: `src/fn-${index}.ts`,
      start_line: 1,
      end_line: 2,
      properties_json: '{}',
    }));
    const moduleNode = {
      ...functions[0], id: 1000, label: 'Module', name: 'critical-module',
      qualified_name: 'test.critical-module', file_path: 'src/module.ts',
    };
    const codeReader = {
      listNodes: (_project: string, options: { label: string }) =>
        options.label === 'Function' ? functions : options.label === 'Module' ? [moduleNode] : [],
      getBulkNodeDegrees: (ids: number[]) => new Map(ids.map((id) => [id, 40])),
    } as unknown as CodeGraphReader;
    const humanStore = {
      getBulkNotesByCbmNodeIds: (_project: string, ids: number[]) =>
        new Map(ids.map((id) => [id, []])),
    } as unknown as HumanMemoryStore;
    const tool = new GetUndocumentedHotspotsTool({ project: 'test', humanStore, codeReader });

    const response = await tool.handle({ limit: 200 });
    expect(response.isError).not.toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.total_hotspots).toBe(61);
    expect(payload.returned_hotspots).toBe(61);
    expect(payload.truncated).toBe(false);
    expect(new Set(payload.undocumented_hotspots.map((item: { cbm_node_id: number }) => item.cbm_node_id)).size).toBe(61);
  });

  it('marks totals as lower bounds when a label exceeds the bounded scan', async () => {
    const modules = Array.from({ length: 5001 }, (_, index) => ({
      id: index + 1,
      project: 'test',
      label: 'Module',
      name: `module-${index}`,
      qualified_name: `test.module-${index}`,
      file_path: `src/module-${index}.ts`,
      start_line: 1,
      end_line: 2,
      properties_json: '{}',
    }));
    const codeReader = {
      listNodes: (_project: string, options: { label: string; limit: number }) => {
        expect(options.limit).toBe(5001);
        return options.label === 'Module' ? modules.slice(0, options.limit) : [];
      },
      getBulkNodeDegrees: (ids: number[]) => new Map(ids.map((id) => [id, 40])),
    } as unknown as CodeGraphReader;
    const humanStore = {
      getBulkNotesByCbmNodeIds: (_project: string, ids: number[]) =>
        new Map(ids.map((id) => [id, []])),
    } as unknown as HumanMemoryStore;
    const tool = new GetUndocumentedHotspotsTool({ project: 'test', humanStore, codeReader });

    const response = await tool.handle({ label: 'Module', limit: 1 });
    expect(response.isError).not.toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.summary).toMatchObject({
      total_nodes: 5000,
      undocumented: 5000,
      scan_truncated: true,
      counts_are_lower_bounds: true,
      coverage_is_partial: true,
      scan_limit_per_label: 5000,
      truncated_labels: ['Module'],
    });
    expect(payload.by_label.Module).toMatchObject({
      total: 5000,
      undocumented: 5000,
      scan_truncated: true,
      counts_are_lower_bounds: true,
    });
    expect(payload.total_hotspots).toBe(5000);
    expect(payload.total_hotspots_is_lower_bound).toBe(true);
    expect(payload.returned_hotspots).toBe(1);
    expect(payload.truncated).toBe(true);
  });
});
