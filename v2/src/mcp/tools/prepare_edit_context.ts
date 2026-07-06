// v2/src/mcp/tools/prepare_edit_context.ts
// The flagship "intelligent" MCP tool.
// Given a file path (or symbol name), returns EVERYTHING the agent needs to know
// before editing: code structure, human notes, bugs, ADRs, refactors, blast radius,
// risk assessment, conventions, and stale data warnings.

import { BaseTool } from './base.js';
import { ToolDefinition } from './index.js';
import { safeJsonParse } from '../../constants.js';
import { computeRiskScore } from '../../reports/risk.js';
import { getGraphStatus, getFreshnessScore, freshnessLabel } from '../../intelligence/graph-status.js';
import { CodeGraphReader } from '../../bridge/sqlite-ro.js';

export class PrepareEditContextTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'prepare_edit_context',
      description: 'The flagship V2 tool. Call this BEFORE editing any source file. Returns: code nodes in the file, their dependencies (callers/callees), linked human notes (ADRs, bugs, refactors, conventions), blast radius (how many routes/modules/functions depend on this file), risk score, stale data warnings, and recommendations. This is the single call that makes the agent "smart" about what it is about to modify.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          file_path: {
            type: 'string',
            description: 'File path to analyze (e.g. "src/auth/login.ts"). Matches against the code graph file_path field (substring match).',
          },
          symbol_name: {
            type: 'string',
            description: 'Alternative: search by symbol name (function/class/module name) instead of file path.',
          },
        },
        anyOf: [
          { required: ['file_path'] },
          { required: ['symbol_name'] },
        ],
        additionalProperties: false,
      },
      handler: PrepareEditContextTool,
    };
  }

  async handle(args: Record<string, unknown>) {
    try {
      const project = this.optionalString(args, 'project') ?? this.project;
      const filePath = this.optionalString(args, 'file_path');
      const symbolName = this.optionalString(args, 'symbol_name');

      if (!filePath && !symbolName) {
        return this.error('Either file_path or symbol_name is required.');
      }

      const codeReader = this.codeReader;
      if (!codeReader) {
        return this.error('Code graph not available. Run "cbm index_repository" first.');
      }

      // Step 1: Find code nodes matching the file_path or symbol_name.
      let matchingNodes: any[] = [];
      if (filePath) {
        // Search by file_path substring using SQL LIKE (not loading all 5000 nodes).
        matchingNodes = codeReader.findNodesByFilePath(project, filePath, 50);
      } else if (symbolName) {
        matchingNodes = codeReader.searchCode(project, symbolName, 50);
      }

      if (matchingNodes.length === 0) {
        return this.json({
          project,
          file_path: filePath,
          symbol_name: symbolName,
          found: false,
          warning: 'No code nodes found matching the query. The file/symbol may not be indexed, or the code graph is stale.',
          graph_freshness: this.getGraphFreshness(project, codeReader),
          recommendation: 'Verify the file path or run "cbm index_repository" to refresh the code graph.',
        });
      }

      // Step 2: For each matching node, gather context.
      const nodesWithContext = [];
      const allBlastRadiusNodes = new Set<number>();
      const seenBugIds = new Set<number>();
      const seenAdrIds = new Set<number>();
      const seenRefactorIds = new Set<number>();
      const seenConventionIds = new Set<number>();
      let maxRiskScore = 0;
      let highestRiskNode: any = null;
      const allBugs: any[] = [];
      const allAdrs: any[] = [];
      const allRefactors: any[] = [];
      const allConventions: any[] = [];

      // Bulk-fetch degrees (split in/out) and notes for all matching nodes (eliminates N+1).
      const nodeIds = matchingNodes.slice(0, 20).map(n => n.id);
      const degreeSplitMap = codeReader.getBulkNodeDegreesSplit(nodeIds);
      const notesByNode = this.humanStore.getBulkNotesByCbmNodeIds(project, nodeIds);
      // R40 (M3): bulk-fetch neighbors for ALL matching nodes in 3 queries
      // (2 for edges + 1 for neighbor nodes) instead of N×2 = 40 queries.
      // The returned Map<nodeId, {edge, node}[]> has the same shape as
      // getNeighbors, so the per-node logic below is unchanged.
      const bulkNeighborsMap = codeReader.getBulkNeighbors(nodeIds, 'both', 50);

      for (const node of matchingNodes.slice(0, 20)) {
        const neighbors = bulkNeighborsMap.get(node.id) ?? [];
        const outNeighbors = neighbors.filter((n) => n.edge.source_id === node.id);
        const inNeighbors = neighbors.filter((n) => n.edge.target_id === node.id);

        // Use split degrees for ACCURATE callers/callees counts (uncapped, unlike
        // the 50-cap from getNeighbors). actualDegree = in + out for risk scoring.
        const splitDegree = degreeSplitMap.get(node.id) ?? { in: 0, out: 0 };
        const actualDegree = splitDegree.in + splitDegree.out;
        const actualCallersCount = splitDegree.in;
        const actualCalleesCount = splitDegree.out;

        // Blast radius: collect unique node IDs that depend on this node (in-edges).
        inNeighbors.forEach((n) => allBlastRadiusNodes.add(n.node.id));

        const humanNotes = notesByNode.get(node.id) ?? [];
        const bugs = humanNotes.filter((n) => n.label === 'BugNote' && n.status === 'active');
        const adrs = humanNotes.filter((n) => n.label === 'ADR' && n.status === 'active');
        const refactors = humanNotes.filter((n) => n.label === 'RefactorPlan' && n.status === 'active');
        const conventions = humanNotes.filter((n) => n.label === 'Convention' && n.status === 'active');

        // Deduplicate by ID (same note can be linked to multiple nodes in the same file).
        for (const b of bugs) { if (!seenBugIds.has(b.id)) { seenBugIds.add(b.id); allBugs.push(b); } }
        for (const a of adrs) { if (!seenAdrIds.has(a.id)) { seenAdrIds.add(a.id); allAdrs.push(a); } }
        for (const r of refactors) { if (!seenRefactorIds.has(r.id)) { seenRefactorIds.add(r.id); allRefactors.push(r); } }
        for (const c of conventions) { if (!seenConventionIds.has(c.id)) { seenConventionIds.add(c.id); allConventions.push(c); } }

        // Risk score — use uncapped degree for accuracy. Use bugs+refactors count
        // (not total notes) since conventions and ADRs don't increase edit risk.
        const riskRelevantNotesCount = bugs.length + refactors.length;
        const props = safeJsonParse(node.properties_json, {} as Record<string, any>);
        const complexity = props.complexity_avg ?? props.complexity ?? 0;
        const riskScore = computeRiskScore(actualDegree, complexity, riskRelevantNotesCount);
        if (riskScore > maxRiskScore) {
          maxRiskScore = riskScore;
          highestRiskNode = node;
        }

        nodesWithContext.push({
          node: {
            id: node.id,
            label: node.label,
            name: node.name,
            qualified_name: node.qualified_name,
            file_path: node.file_path,
            start_line: node.start_line,
            end_line: node.end_line,
          },
          dependencies: {
            calls: outNeighbors.slice(0, 20).map((n) => ({
              type: n.edge.type,
              target: `${n.node.label}:${n.node.name}`,
              target_id: n.node.id,
            })),
            called_by: inNeighbors.slice(0, 20).map((n) => ({
              type: n.edge.type,
              source: `${n.node.label}:${n.node.name}`,
              source_id: n.node.id,
            })),
            // ACCURATE counts from bulk degree query (not capped at 50).
            callers_count: actualCallersCount,
            callees_count: actualCalleesCount,
            actual_degree: actualDegree,
          },
          human_notes: {
            bugs: bugs.map((b) => ({ id: b.id, title: b.title, status: b.status, body_excerpt: b.body_markdown.slice(0, 200) })),
            adrs: adrs.map((a) => ({ id: a.id, title: a.title, status: a.status, body_excerpt: a.body_markdown.slice(0, 200) })),
            refactors: refactors.map((r) => ({ id: r.id, title: r.title, status: r.status, body_excerpt: r.body_markdown.slice(0, 200) })),
            conventions: conventions.map((c) => ({ id: c.id, title: c.title, body_excerpt: c.body_markdown.slice(0, 200) })),
            total_notes: humanNotes.length,
          },
          risk: {
            score: riskScore,
            level: riskScore >= 0.7 ? 'HIGH' : riskScore >= 0.4 ? 'MEDIUM' : 'LOW',
            complexity,
            degree: actualDegree,
            documented: humanNotes.length > 0,
          },
        });
      }

      // Step 3: Build blast radius summary from actual dependent nodes.
      // Fetch all blast-radius nodes in ONE bulk query, then count by label.
      // (Previously called getNodesByIds 3 times — once per label — which was wasteful.)
      const blastRadiusNodes = allBlastRadiusNodes.size > 0
        ? codeReader.getNodesByIds([...allBlastRadiusNodes])
        : new Map();
      let affectedModules = 0;
      let affectedRoutes = 0;
      let affectedFunctions = 0;
      for (const node of blastRadiusNodes.values()) {
        if (node.label === 'Module') affectedModules++;
        else if (node.label === 'Route') affectedRoutes++;
        else if (node.label === 'Function') affectedFunctions++;
      }
      const blastRadius = {
        total_dependent_nodes: allBlastRadiusNodes.size,
        affected_modules: affectedModules,
        affected_routes: affectedRoutes,
        affected_functions: affectedFunctions,
      };

      // Step 4: Build recommendation.
      let recommendation = '';
      const warnings: string[] = [];

      if (maxRiskScore >= 0.7) {
        warnings.push(`HIGH RISK: ${highestRiskNode?.name} has risk score ${maxRiskScore.toFixed(2)}. ${allBlastRadiusNodes.size} nodes depend on this file.`);
      }
      if (allBugs.length > 0) {
        warnings.push(`${allBugs.length} known bug(s) affect this file. Review before editing: ${allBugs.map((b) => b.title).join(', ')}`);
      }
      if (allRefactors.length > 0) {
        warnings.push(`${allRefactors.length} refactor plan(s) target this file. Check if your edit conflicts: ${allRefactors.map((r) => r.title).join(', ')}`);
      }
      if (allConventions.length > 0) {
        warnings.push(`${allConventions.length} convention(s) apply to this file. Respect: ${allConventions.map((c) => c.title).join(', ')}`);
      }

      const freshness = this.getGraphFreshness(project, codeReader);
      if (freshness.score < 0.5) {
        warnings.push(`STALE DATA: Code graph freshness is ${freshness.label} (score ${freshness.score.toFixed(2)}). ${freshness.status.recommendation}`);
      }

      if (warnings.length === 0) {
        recommendation = 'SAFE TO EDIT: No known bugs, refactors, or conventions affect this file. Risk is low.';
      } else {
        recommendation = `⚠️ PROCEED WITH CAUTION:\n${warnings.map((w) => `  - ${w}`).join('\n')}`;
      }

      // Step 5: Return the complete context.
      return this.json({
        project,
        file_path: filePath,
        symbol_name: symbolName,
        found: true,
        nodes_analyzed: nodesWithContext.length,
        nodes_found: matchingNodes.length,
        nodes: nodesWithContext,
        blast_radius: blastRadius,
        human_memory_summary: {
          open_bugs: allBugs.length,
          active_adrs: allAdrs.length,
          pending_refactors: allRefactors.length,
          applicable_conventions: allConventions.length,
        },
        risk_assessment: {
          max_risk_score: maxRiskScore,
          max_risk_level: maxRiskScore >= 0.7 ? 'HIGH' : maxRiskScore >= 0.4 ? 'MEDIUM' : 'LOW',
          highest_risk_node: highestRiskNode ? highestRiskNode.name : null,
        },
        graph_freshness: freshness,
        recommendation,
      });
    } catch (e: any) {
      return this.error(e.message);
    }
  }

  private getGraphFreshness(project: string, codeReader: CodeGraphReader): any {
    try {
      const status = getGraphStatus(project, codeReader, process.cwd());
      const score = getFreshnessScore(status);
      return {
        score,
        label: freshnessLabel(score),
        status: {
          available: status.available,
          last_indexed: status.last_indexed,
          age_seconds: status.age_seconds,
          stale: status.stale,
          stale_reason: status.stale_reason,
          stale_files_count: status.stale_files_count,
          total_nodes: status.total_nodes,
          total_edges: status.total_edges,
          recommendation: status.recommendation,
        },
      };
    } catch {
      return { score: 0, label: 'UNKNOWN', status: { available: false } };
    }
  }
}
