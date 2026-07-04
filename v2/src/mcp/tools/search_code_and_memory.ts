// v2/src/mcp/tools/search_code_and_memory.ts

import { BaseTool } from './base.js';
import { ToolDefinition } from './index.js';

export class SearchCodeAndMemoryTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'search_code_and_memory',
      description: 'Unified search across the code graph AND the human memory graph. Returns matching code nodes (by name, qualified name, or file path) and matching human notes (by title, body, or tags). Results are ranked and merged.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          query: { type: 'string', description: 'Search query (substring match on names/titles, BM25 if available)' },
          limit: { type: 'number', default: 30 },
          search_code: { type: 'boolean', default: true },
          search_human: { type: 'boolean', default: true },
        },
        required: ['query'],
        additionalProperties: false,
      },
      handler: SearchCodeAndMemoryTool,
    };
  }

  async handle(args: Record<string, unknown>) {
    const project = this.optionalString(args, 'project') ?? this.project;
    const query = this.requireString(args, 'query');
    const limit = this.optionalNumber(args, 'limit') ?? 30;
    const searchCode = args.search_code !== false;
    const searchHuman = args.search_human !== false;

    try {
      const codeResults: Array<{
        type: 'code';
        cbm_node_id: number;
        label: string;
        name: string;
        qualified_name: string;
        file_path: string;
      }> = [];

      const humanResults: Array<{
        type: 'human';
        human_node_id: number;
        label: string;
        title: string;
        slug: string;
        status: string;
        obsidian_path: string | null;
        excerpt: string;
      }> = [];

      if (searchCode && this.codeReader) {
        const nodes = this.codeReader.searchCode(project, query, limit);
        for (const n of nodes) {
          codeResults.push({
            type: 'code',
            cbm_node_id: n.id,
            label: n.label,
            name: n.name,
            qualified_name: n.qualified_name,
            file_path: n.file_path,
          });
        }
      }

      if (searchHuman) {
        // Simple LIKE-based search across human_nodes
        const likePattern = `%${query.replace(/[%_]/g, '\\$&')}%`;
        const db = this.humanStore.getRawDb();
        const rows = db
          .prepare(
            `SELECT * FROM human_nodes
             WHERE project = ?
               AND status != 'deprecated'
               AND (title LIKE ? ESCAPE '\\'
                    OR body_markdown LIKE ? ESCAPE '\\'
                    OR tags LIKE ? ESCAPE '\\')
             ORDER BY updated_at DESC
             LIMIT ?`
          )
          .all(project, likePattern, likePattern, likePattern, limit) as any[];

        for (const row of rows) {
          humanResults.push({
            type: 'human',
            human_node_id: row.id,
            label: row.label,
            title: row.title,
            slug: row.slug,
            status: row.status,
            obsidian_path: row.obsidian_path,
            excerpt: row.body_markdown.slice(0, 300),
          });
        }
      }

      // Merge with code first, then human, then truncate
      const merged = [
        ...codeResults.map((r) => ({ ...r, rank: 1 })),
        ...humanResults.map((r) => ({ ...r, rank: 2 })),
      ].slice(0, limit);

      return this.json({
        project,
        query,
        total_matches: merged.length,
        results: merged,
      });
    } catch (e: any) {
      return this.error(e.message);
    }
  }
}
