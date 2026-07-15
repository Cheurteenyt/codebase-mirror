// v2/src/mcp/tools/search_code_and_memory.ts

import { BaseTool } from './base.js';
import { ToolDefinition } from './index.js';

export class SearchCodeAndMemoryTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'search_code_and_memory',
      description: 'Unified search across the code graph AND the human memory graph. Returns matching code nodes (by name, qualified name, or file path) and matching human notes (by title, body, frontmatter, or tags). Results are balanced between the two sources.',
      annotations: {
        title: 'Search code and memory',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          query: { type: 'string', description: 'Search query (substring match on names/titles, BM25 if available)', minLength: 1 },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            default: 30,
            description: 'Maximum total results returned (split evenly between code and human)',
          },
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
      const totalLimit = Math.max(1, Math.min(
        200,
        Math.floor(this.optionalNumber(args, 'limit') ?? 30),
      ));
      const searchCode = args.search_code !== false;
      const searchHuman = args.search_human !== false;
      // Probe both enabled sources independently. Pre-splitting the budget
      // underfilled the response whenever one source had few/no matches (and
      // `limit: 1` assigned zero capacity to human memory).
      const probeLimit = totalLimit + 1;

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
        const nodes = this.codeReader.searchCode(project, query, probeLimit);
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
        // R41 (M5): use FTS5-backed searchHumanNodes (migration V4) instead
        // of the inline 5× LIKE %q% scan. searchHumanNodes falls back to
        // LIKE automatically if the FTS5 table is missing (pre-V4 DB) or if
        // the query syntax trips FTS5's parser. Ranking is now BM25 (most
        // relevant first) instead of updated_at DESC.
        const rows = this.humanStore.searchHumanNodes(project, query, probeLimit);

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

      const codeTruncated = codeResults.length > totalLimit;
      const humanTruncated = humanResults.length > totalLimit;
      const boundedCodeResults = codeResults.slice(0, totalLimit);
      const boundedHumanResults = humanResults.slice(0, totalLimit);

      // Interleave code and human results for balanced presentation, while
      // allowing either source to fill unused capacity.
      const merged: any[] = [];
      const maxLen = Math.max(boundedCodeResults.length, boundedHumanResults.length);
      for (let i = 0; i < maxLen && merged.length < totalLimit; i++) {
        if (i < boundedCodeResults.length && merged.length < totalLimit) {
          merged.push({ ...boundedCodeResults[i], rank: merged.length + 1 });
        }
        if (i < boundedHumanResults.length && merged.length < totalLimit) {
          merged.push({ ...boundedHumanResults[i], rank: merged.length + 1 });
        }
      }
      const codeReturned = merged.filter((result) => result.type === 'code').length;
      const humanReturned = merged.length - codeReturned;
      const matchesTruncated = codeTruncated
        || humanTruncated
        || boundedCodeResults.length + boundedHumanResults.length > merged.length;

      return this.json({
        project,
        query,
        limit_applied: totalLimit,
        returned_matches: merged.length,
        matches_truncated: matchesTruncated,
        total_matches: matchesTruncated ? null : codeResults.length + humanResults.length,
        code_matches: codeTruncated ? null : codeResults.length,
        human_matches: humanTruncated ? null : humanResults.length,
        code_matches_returned: codeReturned,
        human_matches_returned: humanReturned,
        results: merged,
      });
    } catch (e: unknown) {
      return this.error((e instanceof Error ? e.message : String(e)));
    }
  }
}
