import { describe, expect, it } from 'vitest';
import type { CodeGraphReader } from '../../src/bridge/sqlite-ro.js';
import { HumanMemoryStore } from '../../src/human/store.js';
import { GetProjectOverviewTool } from '../../src/mcp/tools/get_project_overview.js';

describe('get_project_overview count honesty', () => {
  it('separates active work from history and marks a bounded module scan as partial', async () => {
    const project = `overview-honesty-${Date.now()}`;
    const modules = Array.from({ length: 5001 }, (_, index) => ({
      id: index + 1,
      project,
      label: 'Module',
      name: `module-${index}`,
      qualified_name: `${project}.module-${index}`,
      file_path: `src/module-${index}.ts`,
      start_line: 1,
      end_line: 2,
      properties_json: '{}',
    }));
    const codeReader = {
      countNodes: () => modules.length,
      countEdges: () => 0,
      countNodesByLabel: () => ({ Module: modules.length }),
      countEdgesByType: () => ({}),
      listModules: (_project: string, limit: number) => modules.slice(0, limit),
      getBulkNodeDegrees: (ids: number[]) => new Map(
        ids.map((id) => [id, id === 1 ? 30 : 0]),
      ),
      getProjectRoot: () => process.cwd(),
    } as unknown as CodeGraphReader;
    const humanStore = HumanMemoryStore.openMemory();
    try {
      humanStore.createNode({ project, label: 'BugNote', title: 'Open bug' });
      humanStore.createNode({
        project, label: 'BugNote', title: 'Historical bug', status: 'deprecated',
      });
      humanStore.createNode({
        project, label: 'RefactorPlan', title: 'Historical plan', status: 'reviewed',
      });

      const tool = new GetProjectOverviewTool({ project, humanStore, codeReader });
      const response = await tool.handle({});
      expect(response.isError).not.toBe(true);
      const payload = JSON.parse(response.content[0].text);

      expect(payload.human_memory).toMatchObject({
        bugs: 2,
        active_bugs: 1,
        refactors: 1,
        active_refactors: 0,
      });
      expect(payload.recommendations).toContainEqual(expect.stringContaining('1 open bug'));
      expect(payload.recommendations).not.toContainEqual(expect.stringContaining('2 open bug'));
      expect(payload.recommendations).not.toContainEqual(expect.stringContaining('pending refactor'));

      expect(payload.documentation_coverage).toMatchObject({
        critical_modules_total: 1,
        critical_modules_documented: 0,
        scanned_modules: 5000,
        module_scan_limit: 5000,
        scan_truncated: true,
        critical_counts_are_lower_bounds: true,
        coverage_is_partial: true,
      });
      expect(payload.recommendations).toContainEqual(expect.stringContaining('coverage is partial'));
      expect(payload.recommendations).toContainEqual(expect.stringContaining('at least 1 critical'));
    } finally {
      humanStore.close();
    }
  });
});
