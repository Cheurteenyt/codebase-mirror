// v2/src/mcp/tools/get_module_context.ts

import { BaseTool } from './base.js';
import { safeJsonParse } from '../../constants.js';
import { ToolDefinition } from './index.js';
import { computeRiskScore } from '../../reports/risk.js';
import type { CodeNode } from '../../bridge/sqlite-ro.js';

export class GetModuleContextTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'get_module_context',
      description: 'Get the full context of a module: code structure (functions, dependencies, neighbors) AND human memory (notes, ADRs, bugs, refactors linked to it). The flagship V2 tool for agents — single call returns everything needed to understand a module.',
      annotations: {
        title: 'Get module context',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          module_name: {
            type: 'string',
            description: 'Module, file, class, or interface name (or file path; case-insensitive substring match)',
          },
          include_code: { type: 'boolean', default: true },
          include_human: { type: 'boolean', default: true },
          include_adrs: { type: 'boolean', default: true },
          include_bugs: { type: 'boolean', default: true },
          include_refactors: { type: 'boolean', default: true },
          max_nodes: {
            type: 'integer',
            minimum: 0,
            maximum: 1000,
            default: 200,
            description: 'Maximum code neighbors to return',
          },
        },
        required: ['module_name'],
        additionalProperties: false,
      },
      handler: GetModuleContextTool,
    };
  }

  async handle(args: Record<string, unknown>) {
    try {
      const project = this.optionalString(args, 'project') ?? this.project;
      const moduleName = this.requireString(args, 'module_name');
      const includeCode = args.include_code !== false;
      const includeHuman = args.include_human !== false;
      const includeAdrs = args.include_adrs !== false;
      const includeBugs = args.include_bugs !== false;
      const includeRefactors = args.include_refactors !== false;
      const maxNodes = Math.max(0, Math.min(
        1000,
        Math.floor(this.optionalNumber(args, 'max_nodes') ?? 200),
      ));

      const codeReader = this.codeReader;
      if (!codeReader) {
        return this.error('Code graph reader not configured. Index the project first.');
      }

      // Resolve a context root in an explicit order. Native V2 graphs always
      // contain File nodes but may contain no Module nodes, so stopping after
      // the first Module-only query made this tool unusable on those graphs.
      const resolutionStages = [
        { description: 'Module', labels: ['Module'] },
        { description: 'File', labels: ['File'] },
        { description: 'Class/Interface', labels: ['Class', 'Interface'] },
      ] as const;
      let module: CodeNode | undefined;

      for (const stage of resolutionStages) {
        const matches = codeReader.findNodesByNameOrPath(project, moduleName, stage.labels, 11);
        const normalizedQuery = moduleName.replace(/\\/gu, '/').replace(/^\.\//u, '').toLowerCase();
        const exactMatches = matches.filter((candidate) =>
          [candidate.name, candidate.qualified_name, candidate.file_path]
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.replace(/\\/gu, '/').replace(/^\.\//u, '').toLowerCase())
            .includes(normalizedQuery)
        );
        const preferredMatches = exactMatches.length > 0 ? exactMatches : matches;
        if (preferredMatches.length > 1) {
          const candidates = preferredMatches.slice(0, 10).map((candidate) =>
            `"${candidate.qualified_name || candidate.name}" [${candidate.label}, ${candidate.file_path}]`
          ).join(', ');
          return this.error(
            `Ambiguous ${stage.description} match for "${moduleName}" in project "${project}". ` +
            `Candidates: ${candidates}${preferredMatches.length > 10 ? ', …' : ''}. ` +
            'Use a more specific module_name, qualified name, or file path.'
          );
        }
        if (preferredMatches.length === 1) {
          module = preferredMatches[0];
          break;
        }
      }

      if (!module) {
        const suggestionQuery = moduleName.slice(0, Math.max(3, Math.floor(moduleName.length / 2)));
        const suggestions = codeReader.findNodesByNameOrPath(
          project,
          suggestionQuery,
          ['Module', 'File', 'Class', 'Interface'],
          5,
        );
        return this.error(
          `No Module, File, Class, or Interface found matching "${moduleName}" in project "${project}".` +
          (suggestions.length > 0
            ? ` Did you mean: ${suggestions.map((candidate) => `"${candidate.qualified_name || candidate.name}"`).join(', ')}?`
            : '')
        );
      }

      const degree = codeReader.getNodeDegree(module.id);
      const props = safeJsonParse(module.properties_json, {} as Record<string, any>);

      const result: Record<string, unknown> = {
        module: {
          cbm_node_id: module.id,
          name: module.name,
          qualified_name: module.qualified_name,
          file_path: module.file_path,
          label: module.label,
          degree,
          properties: props,
        },
      };

      if (includeCode) {
        // Fetch maxNodes + 1 to detect truncation accurately.
        const neighbors = codeReader.getNeighbors(module.id, 'both', maxNodes + 1);
        const truncated = neighbors.length > maxNodes;
        result['code_nodes'] = neighbors.slice(0, maxNodes).map(({ edge, node }) => ({
          id: node.id,
          label: node.label,
          name: node.name,
          file_path: node.file_path,
          edge_type: edge.type,
          edge_direction: edge.source_id === module.id ? 'out' : 'in',
        }));
        result['code_stats'] = {
          // `degree` is uncapped; the previous value reported only the
          // maxNodes+1 probe length and looked like an exact total.
          neighbors_count: degree,
          neighbors_returned: Math.min(neighbors.length, maxNodes),
          truncated: degree > maxNodes || truncated,
        };
      }

      // Always fetch notesCount for risk score (independent of include_human flag).
      // R21: uses the junction table (human_node_cbm_links) with an indexed JOIN
      // instead of the old JSON_EACH pattern. See store.ts for details.
      const linkedNotesCount = this.humanStore.getBulkNoteCountsByCbmNodeIds(project, [module.id])
        .get(module.id) ?? 0;
      const notesProbe = this.humanStore.getBulkNotesByCbmNodeIds(project, [module.id], 201)
        .get(module.id) ?? [];
      const notesTruncated = linkedNotesCount > 200 || notesProbe.length > 200;
      const notesForRisk = notesProbe.slice(0, 200);
      let humanNotes: any[] = [];
      if (includeHuman) {
        humanNotes = notesForRisk;
        // Only show 'other' notes in human_notes — ADRs/bugs/refactors have their own arrays.
        const otherNotes = humanNotes.filter((n) =>
          n.label !== 'ADR' && n.label !== 'BugNote' && n.label !== 'RefactorPlan'
        );
        result['human_notes'] = otherNotes.map((n) => ({
          id: n.id,
          label: n.label,
          title: n.title,
          status: n.status,
          tags: n.tags,
          updated_at: n.updated_at,
          obsidian_path: n.obsidian_path,
          body_excerpt: n.body_markdown.slice(0, 500),
        }));
      }

      // ADRs, bugs, refactors are independent of include_human — they use notesForRisk.
      if (includeAdrs) {
        const adrs = notesForRisk.filter((n) => n.label === 'ADR');
        result['adrs'] = adrs.map((n) => ({
          id: n.id,
          title: n.title,
          status: n.status,
          updated_at: n.updated_at,
          body_excerpt: n.body_markdown.slice(0, 500),
        }));
      }

      if (includeBugs) {
        const bugs = notesForRisk.filter((n) => n.label === 'BugNote');
        result['bugs'] = bugs.map((n) => ({
          id: n.id,
          title: n.title,
          status: n.status,
          body_excerpt: n.body_markdown.slice(0, 500),
        }));
      }

      if (includeRefactors) {
        const refactors = notesForRisk.filter((n) => n.label === 'RefactorPlan');
        result['refactors'] = refactors.map((n) => ({
          id: n.id,
          title: n.title,
          status: n.status,
          body_excerpt: n.body_markdown.slice(0, 500),
        }));
      }

      // Compute risk score using the shared formula.
      const notesCount = linkedNotesCount;
      const complexityAvg = props.complexity_avg ?? props.complexity ?? 0;
      const riskScore = computeRiskScore(degree, complexityAvg, notesCount);

      result['stats'] = {
        documentation_coverage: notesCount > 0 ? 1.0 : 0.0,
        risk_score: riskScore,
        risk_level: riskScore >= 0.7 ? 'high' : riskScore >= 0.4 ? 'medium' : 'low',
        linked_notes_count: linkedNotesCount,
        linked_notes_returned: notesForRisk.length,
        linked_notes_truncated: notesTruncated,
      };

      return this.json(result);
    } catch (e: unknown) {
      return this.error((e instanceof Error ? e.message : String(e)));
    }
  }
}
