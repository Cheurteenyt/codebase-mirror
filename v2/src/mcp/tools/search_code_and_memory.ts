// v2/src/mcp/tools/search_code_and_memory.ts

import { BaseTool } from './base.js';
import { ToolDefinition } from './index.js';

export class SearchCodeAndMemoryTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'search_code_and_memory',
      description: 'Unified search across the code graph AND the human memory graph. Returns matching code nodes (by name, qualified name, or file path) and matching human notes (by title, body, frontmatter, or tags). Results are balanced between the two sources.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          query: { type: 'string', description: 'Search query (substring match on names/titles, BM25 if available)', minLength: 1 },
          limit: { type: 'number', default: 30, description: 'Maximum total results returned (split evenly between code and human)' },
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
    try {
      const project = this.optionalString(args, 'project') ?? this.project;
      const query = this.requireString(args, 'query');
      const totalLimit = this.optionalNumber(args, 'limit') ?? 30;
      const searchCode = args.search_code !== false;
      const searchHuman = args.search_human !== false;
      // Split the limit evenly between code and human results so neither dominates.
      // If only one source is enabled, it gets the full limit.
      let codeLimit = totalLimit;
      let humanLimit = totalLimit;
      if (searchCode && searchHuman) {
        codeLimit = Math.ceil(totalLimit / 2);
        humanLimit = totalLimit - codeLimit;
      } else if (!searchCode) {
        codeLimit = 0;
      } else if (!searchHuman) {
        humanLimit = 0;
      }

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

      if (searchCode && this.codeReader && codeLimit > 0) {
        const nodes = this.codeReader.searchCode(project, query, codeLimit);
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

      if (searchHuman && humanLimit > 0) {
        // LIKE-based search across human_nodes. Searches title, body, tags, and frontmatter.
        const escaped = query.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
        const likePattern = `%${escaped}%`;
        const db = this.humanStore.getRawDb();
        const rows = db
          .prepare(
            `SELECT * FROM human_nodes
             WHERE project = ?
               AND status != 'deprecated'
               AND (title LIKE ? ESCAPE '\\'
                    OR body_markdown LIKE ? ESCAPE '\\'
                    OR tags LIKE ? ESCAPE '\\'
                    OR frontmatter_json LIKE ? ESCAPE '\\'
                    OR author LIKE ? ESCAPE '\\')
             ORDER BY updated_at DESC
             LIMIT ?`
          )
          .all(project, likePattern, likePattern, likePattern, likePattern, likePattern, humanLimit) as any[];

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

      // Interleave code and human results for balanced presentation.
      const merged: any[] = [];
      const maxLen = Math.max(codeResults.length, humanResults.length);
      for (let i = 0; i < maxLen && merged.length < totalLimit; i++) {
        if (i < codeResults.length && merged.length < totalLimit) {
          merged.push({ ...codeResults[i], rank: merged.length + 1 });
        }
        if (i < humanResults.length && merged.length < totalLimit) {
          merged.push({ ...humanResults[i], rank: merged.length + 1 });
        }
      }

      return this.json({
        project,
        query,
        total_matches: merged.length,
        code_matches: codeResults.length,
        human_matches: humanResults.length,
        results: merged,
      });
    } catch (e: any) {
      return this.error(e.message);
    }
  }
}
