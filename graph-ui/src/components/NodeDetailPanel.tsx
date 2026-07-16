import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { colorForLabel, colorForRisk } from "../lib/colors";
import type { GraphNode, GraphEdge } from "../lib/types";
import { useExactNeighborhood } from "../hooks/useExactNeighborhood";

interface Connection {
  node: GraphNode;
  edgeType: string;
  direction: "inbound" | "outbound" | "self";
  edgeId?: number;
}

interface NodeDetailPanelProps {
  node: GraphNode;
  /** Complete representative overview before the user's visual filters. */
  overviewNodes?: GraphNode[];
  /** Nodes currently visible after filters. */
  allNodes: GraphNode[];
  allEdges: GraphEdge[];
  /** Active project used to resolve exact, project-scoped connections. */
  project: string | null;
  /** Invalidates exact pages when the authoritative graph generation changes. */
  exactRefreshKey?: string | number;
  /** Force an anchor lookup for a selected node absent from the overview. */
  requiresExactValidation?: boolean;
  onExactValidation?: (
    nodeId: number,
    refreshKey: string | number | undefined,
    valid: boolean,
  ) => void;
  onClose: () => void;
  onNavigate: (node: GraphNode) => void;
}

/**
 * R43 (L1 + L2 + M1 + a11y): cleaned up NodeDetailPanel.
 *
 * Removed (L1): dead "Show code" button + state (canFetchCode was hardcoded
 * false, RPC endpoint not implemented in V2), dead "Open on GitHub" link
 * (repoInfo was always null — no /api/repo-info endpoint exists), dead
 * helpers (lineSuffix, encodePath, githubUrl), dead SnippetResult type,
 * dead callTool/rpc import, dead RepoInfo import. ~80 lines removed.
 *
 * Fixed (L2): groupByType was O(n²) (spread-per-iteration). Rewritten to
 * push-in-place. Also memoized via useMemo so it doesn't recompute on every
 * parent re-render (e.g., when hoveredNode changes in GraphTab).
 *
 * Added (M1): risk-score display in the Stats row. The data (node.risk_score)
 * and the color function (colorForRisk) already existed but were unused —
 * hover showed risk, detail panel didn't. Now consistent.
 *
 * Added (a11y): aria-label="Close" on the × button (screen readers announced
 * "times" / "multiplication sign" instead of "Close").
 */
export function NodeDetailPanel({
  node,
  overviewNodes,
  allNodes,
  allEdges,
  project,
  exactRefreshKey,
  requiresExactValidation = false,
  onExactValidation,
  onClose,
  onNavigate,
}: NodeDetailPanelProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const isVisibleInOverview = allNodes.some((candidate) => candidate.id === node.id);
  const isInOverview = (overviewNodes ?? allNodes).some((candidate) => candidate.id === node.id);
  useEffect(() => {
    headingRef.current?.focus();
  }, [node.id]);
  const overviewConnections = useMemo(() => {
    const nodeMap = new Map<number, GraphNode>();
    for (const n of allNodes) nodeMap.set(n.id, n);
    const conns: Connection[] = [];
    for (const edge of allEdges) {
      if (edge.source === node.id && edge.target === node.id) {
        conns.push({ node, edgeType: edge.type, direction: "self" });
        continue;
      }
      if (edge.source === node.id) {
        const t = nodeMap.get(edge.target);
        if (t) conns.push({ node: t, edgeType: edge.type, direction: "outbound" });
      }
      if (edge.target === node.id) {
        const s = nodeMap.get(edge.source);
        if (s) conns.push({ node: s, edgeType: edge.type, direction: "inbound" });
      }
    }
    return conns;
  }, [node, allNodes, allEdges]);

  let overviewOutbound = 0;
  let overviewInbound = 0;
  for (const connection of overviewConnections) {
    if (connection.direction !== "inbound") overviewOutbound += 1;
    if (connection.direction !== "outbound") overviewInbound += 1;
  }
  const overviewCompletenessKnown = node.out_degree != null && node.in_degree != null;
  const overviewTotalOutbound = node.out_degree ?? overviewOutbound;
  const overviewTotalInbound = node.in_degree ?? overviewInbound;
  const overviewIsPartial = overviewOutbound < overviewTotalOutbound
    || overviewInbound < overviewTotalInbound;
  const exactLoadRequired = !overviewCompletenessKnown
    || overviewIsPartial
    || requiresExactValidation;
  const exactNeighborhood = useExactNeighborhood(
    project,
    node.id,
    exactLoadRequired,
    exactRefreshKey,
  );
  // A node transition and its effect cleanup are not atomic with rendering.
  // Never let a completed frame for the previous detail node leak into this
  // panel, even for that single render between commit and effect cleanup.
  const exactData = exactNeighborhood.data?.anchor.id === node.id
    ? exactNeighborhood.data
    : null;
  const hasMismatchedExactFrame = exactNeighborhood.data != null && exactData == null;
  const exactError = hasMismatchedExactFrame
    ? "Exact neighborhood response did not match the selected node"
    : exactNeighborhood.error;
  const exactErrorPhase = hasMismatchedExactFrame ? "initial" : exactNeighborhood.errorPhase;
  const exactErrorStatus = hasMismatchedExactFrame ? null : exactNeighborhood.errorStatus;
  const exactPending = exactLoadRequired
    && !exactData
    && !exactError;

  useEffect(() => {
    if (!requiresExactValidation || !onExactValidation) return;
    if (exactData) {
      onExactValidation(node.id, exactRefreshKey, true);
      return;
    }
    // Only an authoritative, current 404 proves that the off-overview anchor
    // was deleted. Transient/server failures remain visible and retryable;
    // treating a 503 as absence would silently discard a valid selection.
    if (!exactNeighborhood.loading && exactError && exactErrorStatus === 404) {
      onExactValidation(node.id, exactRefreshKey, false);
    }
  }, [
    exactData,
    exactError,
    exactErrorStatus,
    exactNeighborhood.loading,
    exactRefreshKey,
    node.id,
    onExactValidation,
    requiresExactValidation,
  ]);
  const connections = useMemo(() => {
    if (!exactData) return overviewConnections;
    const nodeMap = new Map<number, GraphNode>([[node.id, node]]);
    for (const neighbor of exactData.nodes) nodeMap.set(neighbor.id, neighbor);
    const exactConnections: Connection[] = [];
    for (const edge of exactData.edges) {
      if (edge.source === node.id && edge.target === node.id) {
        exactConnections.push({
          node,
          edgeType: edge.type,
          direction: "self",
          edgeId: edge.id,
        });
        continue;
      }
      if (edge.source === node.id) {
        const target = nodeMap.get(edge.target);
        if (target) exactConnections.push({
          node: target,
          edgeType: edge.type,
          direction: "outbound",
          edgeId: edge.id,
        });
      }
      if (edge.target === node.id) {
        const source = nodeMap.get(edge.source);
        if (source) exactConnections.push({
          node: source,
          edgeType: edge.type,
          direction: "inbound",
          edgeId: edge.id,
        });
      }
    }
    return exactConnections;
  }, [exactData, node, overviewConnections]);

  // R43 (L2): memoize the split + grouping so it doesn't recompute on every
  // parent re-render. groupByType was O(n²) (spread-per-iteration); now O(n).
  const { groupedOutbound, groupedInbound, groupedSelf } = useMemo(() => {
    const out: Connection[] = [];
    const inb: Connection[] = [];
    const self: Connection[] = [];
    for (const c of connections) {
      if (c.direction === "outbound") out.push(c);
      else if (c.direction === "inbound") inb.push(c);
      else self.push(c);
    }
    return {
      groupedOutbound: groupByType(out),
      groupedInbound: groupByType(inb),
      groupedSelf: groupByType(self),
    };
  }, [connections]);
  const visibleSelf = countGroups(groupedSelf);
  const visibleOutbound = countGroups(groupedOutbound) + visibleSelf;
  const visibleInbound = countGroups(groupedInbound) + visibleSelf;
  const totalOutbound = exactData?.anchor.total_outbound ?? node.out_degree ?? visibleOutbound;
  const totalInbound = exactData?.anchor.total_inbound ?? node.in_degree ?? visibleInbound;
  const totalConnectionsIsExact = exactData != null
    || (overviewCompletenessKnown && !overviewIsPartial);
  // In/out degrees both include a self-loop. Until the exact neighborhood is
  // available, subtract every self-loop already observed so the provisional
  // unique-edge total does not count it twice. Keep the estimate at least as
  // large as the number of distinct overview edges currently rendered.
  const provisionalUniqueConnections = Math.max(
    connections.length,
    totalOutbound + totalInbound - visibleSelf,
  );
  const totalConnections = exactData?.anchor.total_unique_edges
    ?? (totalConnectionsIsExact ? connections.length : provisionalUniqueConnections);
  const connectionsArePartial = exactData
    ? exactData.page.next_cursor != null
    : overviewIsPartial;

  return (
    <div className="w-full bg-[#0b1920]/95 backdrop-blur-xl flex flex-col h-full min-h-0 overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-border/30">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colorForLabel(node.label) }} />
              <h3
                ref={headingRef}
                tabIndex={-1}
                className="truncate text-[13px] font-semibold text-foreground focus:outline-none"
              >
                {node.name}
              </h3>
            </div>
            <span
              className="inline-block px-2 py-0.5 rounded-md text-[10px] font-medium"
              style={{ backgroundColor: colorForLabel(node.label) + "18", color: colorForLabel(node.label) }}
            >
              {node.label}
            </span>
          </div>
          {/* R43 (a11y): aria-label so screen readers announce "Close" instead of "times". */}
          <button onClick={onClose} aria-label="Close" className="text-foreground/20 hover:text-foreground/50 transition-colors text-[16px] leading-none p-1">×</button>
        </div>

        {node.file_path && (
          <p className="text-[11px] text-foreground/30 font-mono mt-2 break-all leading-relaxed">
            {node.file_path}
            {node.start_line ? (
              <span className="text-foreground/45">
                {" "}:{node.start_line}
                {node.end_line && node.end_line !== node.start_line ? `-${node.end_line}` : ""}
              </span>
            ) : null}
          </p>
        )}

        {/* Stats */}
        <div className="flex gap-5 mt-3">
          {[
            { label: "Out", value: totalOutbound, color: "text-primary" },
            { label: "In", value: totalInbound, color: "text-accent" },
            {
              label: "Total",
              value: totalConnections,
              color: "text-foreground",
              estimated: !totalConnectionsIsExact,
            },
          ].map((s) => (
            <div
              key={s.label}
              aria-label={s.estimated
                ? `Estimated total unique connections: ${s.value}`
                : `${s.label} connections: ${s.value}`}
            >
              <p className="text-[9px] text-foreground/25 uppercase tracking-widest">
                {s.label}{s.estimated ? " est." : ""}
              </p>
              <p className={`text-[18px] font-semibold tabular-nums ${s.color}`}>
                {s.estimated ? "≈" : ""}{s.value}
              </p>
            </div>
          ))}
          {/* R43 (M1): risk-score display. The data and colorForRisk function
              already existed but were never used in the detail panel — only
              in the hover tooltip. Now consistent. */}
          {node.risk_score != null && (
            <div>
              <p className="text-[9px] text-foreground/25 uppercase tracking-widest">Risk</p>
              <p
                className="text-[18px] font-semibold tabular-nums"
                style={{ color: colorForRisk(node.risk_score) }}
              >
                {(node.risk_score * 100).toFixed(0)}%
              </p>
            </div>
          )}
        </div>
        {exactPending && (
          <p
            role="status"
            aria-live="polite"
            className="mt-2 text-[10px] leading-relaxed text-amber-200/70"
          >
            Loading the exact neighborhood; bounded overview connections remain visible.
          </p>
        )}
        {!isInOverview && (
          <p role="status" className="mt-2 rounded-md border border-sky-300/15 bg-sky-300/[0.05] px-2 py-1.5 text-[10px] leading-relaxed text-sky-100/70">
            Exact project result · outside the representative map. Its complete direct neighborhood remains available below.
          </p>
        )}
        {isInOverview && !isVisibleInOverview && (
          <p role="status" className="mt-2 rounded-md border border-violet-300/15 bg-violet-300/[0.05] px-2 py-1.5 text-[10px] leading-relaxed text-violet-100/70">
            Exact project result · present in the representative overview but hidden by active filters. Its exact neighborhood remains available below.
          </p>
        )}
        {exactError && (
          <div
            role="alert"
            className="mt-2 flex items-center justify-between gap-2 rounded-md border border-amber-300/15 bg-amber-200/[0.04] px-2 py-1.5 text-[10px] leading-relaxed text-amber-100/75"
          >
            <span>
              {exactErrorPhase === "more"
                ? "Could not load the next page: "
                : "Could not load exact connections: "}
              {exactError}
            </span>
            <button
              onClick={exactNeighborhood.retry}
              className="shrink-0 rounded-md border border-amber-300/25 px-2 py-1 font-medium text-amber-50 transition-colors hover:bg-amber-200/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/50"
            >
              {exactErrorPhase === "more" ? "Retry page" : "Retry exact load"}
            </button>
          </div>
        )}
        {!exactData && !exactError && connectionsArePartial && (
          <p role="status" className="mt-2 text-[10px] leading-relaxed text-amber-200/65">
            Showing {connections.length.toLocaleString()} overview {connections.length === 1 ? "connection" : "connections"}. Estimated unique total: {totalConnections.toLocaleString()}.
            In/out totals are exact; the unique total remains provisional until exact data loads.
          </p>
        )}
        {!exactData
          && !exactPending
          && !exactError
          && overviewCompletenessKnown
          && !overviewIsPartial && (
          <p role="status" className="mt-2 text-[10px] leading-relaxed text-emerald-200/60">
            Complete neighborhood present in overview · {connections.length.toLocaleString()} connections
          </p>
        )}
        {exactData && connectionsArePartial && (
          <p role="status" aria-live="polite" className="mt-2 text-[10px] leading-relaxed text-sky-200/70">
            Loaded {connections.length.toLocaleString()} of {totalConnections.toLocaleString()} exact connections.
          </p>
        )}
        {exactData && !connectionsArePartial && (
          <p role="status" aria-live="polite" className="mt-2 text-[10px] leading-relaxed text-emerald-200/70">
            Exact neighborhood loaded · {totalConnections.toLocaleString()} connections
          </p>
        )}
      </div>

      {/* Connections */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-4 py-3 space-y-4">
          {groupedOutbound.length > 0 && (
            <ConnectionSection key={`out-${node.id}`} title="References" count={countGroups(groupedOutbound)} icon="→" groups={groupedOutbound} onNavigate={onNavigate} />
          )}
          {groupedInbound.length > 0 && (
            <ConnectionSection key={`in-${node.id}`} title="Referenced by" count={countGroups(groupedInbound)} icon="←" groups={groupedInbound} onNavigate={onNavigate} />
          )}
          {groupedSelf.length > 0 && (
            <ConnectionSection key={`self-${node.id}`} title="Self references" count={visibleSelf} icon="↻" groups={groupedSelf} onNavigate={onNavigate} />
          )}
          {connections.length === 0 && exactPending && (
            <p role="status" className="text-[12px] text-foreground/30 text-center py-8">
              Loading exact connections…
            </p>
          )}
          {connections.length === 0 && !exactPending && !exactError && (
            <p className="text-[12px] text-foreground/20 text-center py-8">No connections</p>
          )}
          {exactData?.page.next_cursor && exactErrorPhase !== "more" && (
            <button
              onClick={exactNeighborhood.loadMore}
              disabled={exactNeighborhood.loadingMore}
              aria-busy={exactNeighborhood.loadingMore}
              className="min-h-10 w-full rounded-lg border border-sky-300/20 bg-sky-300/[0.06] px-3 py-2 text-[12px] font-medium text-sky-100/80 transition-colors hover:bg-sky-300/[0.11] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-200/50 disabled:cursor-wait disabled:opacity-50"
            >
              {exactNeighborhood.loadingMore ? "Loading more exact connections…" : "Load more exact connections"}
            </button>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * Group connections by edge type, sorted by count descending.
 * R43 (L2): rewritten to push-in-place (was O(n²) spread-per-iteration).
 */
function groupByType(conns: Connection[]): [string, Connection[]][] {
  const g = new Map<string, Connection[]>();
  for (const c of conns) {
    const arr = g.get(c.edgeType);
    if (arr) arr.push(c);
    else g.set(c.edgeType, [c]);
  }
  return [...g.entries()].sort((a, b) => b[1].length - a[1].length);
}

function countGroups(groups: [string, Connection[]][]): number {
  return groups.reduce((sum, [, connections]) => sum + connections.length, 0);
}

function ConnectionSection({ title, count, icon, groups, onNavigate }: {
  title: string; count: number; icon: string;
  groups: [string, Connection[]][];
  onNavigate: (n: GraphNode) => void;
}) {
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(() => new Set());

  const toggleType = (type: string) => {
    setExpandedTypes((previous) => {
      const next = new Set(previous);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <div>
      <p className="text-[11px] font-medium text-foreground/40 mb-2">
        {title} <span className="text-foreground/15">({count})</span>
      </p>
      {groups.map(([type, conns]) => {
        const expanded = expandedTypes.has(type);
        const visibleConnections = expanded ? conns : conns.slice(0, 25);
        const normalizedType = type.replace(/_/g, " ").toLowerCase();
        const hiddenCount = conns.length - visibleConnections.length;
        return (
          <div key={type} className="mb-2">
            <p className="text-[9px] text-foreground/25 uppercase tracking-wider mb-1 font-medium">
              {normalizedType}
            </p>
            <div className="space-y-px">
              {visibleConnections.map((c, i) => (
              <button
                key={`${c.edgeId ?? "overview"}-${c.node.id}-${i}`}
                onClick={() => onNavigate(c.node)}
                aria-label={`Open ${c.node.name} (${c.node.label})`}
                className="group flex min-h-8 w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-200/40"
              >
                <span className="text-foreground/25 text-[10px] group-hover:text-foreground/40">{icon}</span>
                <span className="w-[5px] h-[5px] rounded-full shrink-0" style={{ backgroundColor: colorForLabel(c.node.label) }} />
                <span className="text-foreground/65 group-hover:text-foreground/85 truncate">{c.node.name}</span>
                <span className="text-foreground/25 ml-auto text-[10px] shrink-0">{c.node.label}</span>
              </button>
              ))}
              {conns.length > 25 && (
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggleType(type)}
                  className="min-h-8 w-full rounded-md px-2 py-1 text-left text-[10px] font-medium text-sky-200/60 transition-colors hover:bg-sky-200/[0.05] hover:text-sky-100/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-200/40"
                >
                  {expanded
                    ? `Show fewer ${normalizedType} connections`
                    : `Show ${hiddenCount} more ${normalizedType} connections`}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
