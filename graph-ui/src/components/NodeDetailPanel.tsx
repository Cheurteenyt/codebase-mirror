import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { colorForLabel, colorForRisk } from "../lib/colors";
import type { GraphNode, GraphEdge } from "../lib/types";
import { useExactNeighborhood } from "../hooks/useExactNeighborhood";
import { useExactPath } from "../hooks/useExactPath";

interface Connection {
  node: GraphNode;
  edgeType: string;
  direction: "inbound" | "outbound" | "self";
  occurrences: number;
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
  /** Optional source retained while the user selects a target symbol. */
  pathSource: GraphNode | null;
  onPathSourceChange: (node: GraphNode | null) => void;
}

function collectConnections(anchor: GraphNode, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Connection[] {
  const nodeMap = new Map<number, GraphNode>([[anchor.id, anchor]]);
  for (const node of nodes) nodeMap.set(node.id, node);
  const connections = new Map<string, Connection>();
  for (const edge of edges) {
    let direction: Connection["direction"];
    let neighborId: number;
    if (edge.source === anchor.id && edge.target === anchor.id) {
      direction = "self";
      neighborId = anchor.id;
    } else if (edge.source === anchor.id) {
      direction = "outbound";
      neighborId = edge.target;
    } else if (edge.target === anchor.id) {
      direction = "inbound";
      neighborId = edge.source;
    } else continue;
    const neighbor = nodeMap.get(neighborId);
    if (!neighbor) continue;
    const key = `${direction}\0${edge.type}\0${neighborId}`;
    const existing = connections.get(key);
    if (existing) existing.occurrences += 1;
    else connections.set(key, { node: neighbor, edgeType: edge.type, direction, occurrences: 1 });
  }
  return [...connections.values()];
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
  pathSource,
  onPathSourceChange,
}: NodeDetailPanelProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const isVisibleInOverview = allNodes.some((candidate) => candidate.id === node.id);
  const isInOverview = (overviewNodes ?? allNodes).some((candidate) => candidate.id === node.id);
  useEffect(() => {
    headingRef.current?.focus();
  }, [node.id]);
  const overviewConnections = useMemo(
    () => collectConnections(node, allNodes, allEdges),
    [node, allNodes, allEdges],
  );

  let overviewOutbound = 0;
  let overviewInbound = 0;
  for (const connection of overviewConnections) {
    if (connection.direction !== "inbound") overviewOutbound += connection.occurrences;
    if (connection.direction !== "outbound") overviewInbound += connection.occurrences;
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
    return collectConnections(node, exactData.nodes, exactData.edges);
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
  const visibleConnectionCount = visibleOutbound + visibleInbound - visibleSelf;
  const totalOutbound = exactData?.anchor.total_outbound ?? node.out_degree ?? visibleOutbound;
  const totalInbound = exactData?.anchor.total_inbound ?? node.in_degree ?? visibleInbound;
  const totalConnectionsIsExact = exactData != null
    || (overviewCompletenessKnown && !overviewIsPartial);
  // In/out degrees both include a self-loop. Until the exact neighborhood is
  // available, subtract every self-loop already observed so the provisional
  // unique-edge total does not count it twice. Keep the estimate at least as
  // large as the number of distinct overview edges currently rendered.
  const provisionalUniqueConnections = Math.max(
    visibleConnectionCount,
    totalOutbound + totalInbound - visibleSelf,
  );
  const totalConnections = exactData?.anchor.total_unique_edges
    ?? (totalConnectionsIsExact ? visibleConnectionCount : provisionalUniqueConnections);
  const connectionsArePartial = exactData
    ? exactData.page.next_cursor != null
    : overviewIsPartial;
  const profileRole = flowRole(totalOutbound, totalInbound, visibleSelf);
  const profileCoverage = exactPending
    ? "Loading"
    : exactData
    ? connectionsArePartial ? "Partial" : "Exact"
    : "Overview";
  const dominantOutbound = groupedOutbound[0];
  const dominantInbound = groupedInbound[0];

  return (
    <div className="nd-panel">
      {/* Header */}
      <div className="nd-header">
        <div className="nd-heading-row">
          <div className="nd-grow">
            <div className="nd-title-row">
              <span className="nd-dot" style={{ backgroundColor: colorForLabel(node.label) }} />
              <h3
                ref={headingRef}
                tabIndex={-1}
                className="nd-title"
              >
                {node.name}
              </h3>
            </div>
            <span
              className="nd-label"
              style={{ backgroundColor: colorForLabel(node.label) + "18", color: colorForLabel(node.label) }}
            >
              {node.label}
            </span>
          </div>
          {/* R43 (a11y): aria-label so screen readers announce "Close" instead of "times". */}
          <button onClick={onClose} aria-label="Close" className="nd-close">×</button>
        </div>

        {node.file_path && (
          <p className="nd-file">
            {node.file_path}
            {node.start_line ? (
              <span className="nd-line">
                {" "}:{node.start_line}
                {node.end_line && node.end_line !== node.start_line ? `-${node.end_line}` : ""}
              </span>
            ) : null}
          </p>
        )}

        <div
          aria-label={`Flow profile: ${profileRole}`}
          aria-live="polite"
          className="nd-flow"
        >
          <div className="nd-between">
            <div>
              <p className="nd-kicker">Flow profile</p>
              <p className="nd-role">{profileRole}</p>
            </div>
            <span className="nd-coverage">
              {profileCoverage}
            </span>
          </div>
          <div className="nd-stats">
            <span aria-label={`Out connections: ${totalOutbound}`} className="nd-pill text-primary">→ {totalOutbound}</span>
            <span aria-label={`In connections: ${totalInbound}`} className="nd-pill text-accent">← {totalInbound}</span>
            <span
              aria-label={totalConnectionsIsExact
                ? `Total connections: ${totalConnections}`
                : `Estimated total unique connections: ${totalConnections}`}
              className="nd-pill"
            >
              {totalConnectionsIsExact ? totalConnections : `≈${totalConnections}`} unique
            </span>
            {node.risk_score != null && (
              <span className="nd-pill" style={{ color: colorForRisk(node.risk_score) }}>
                Risk {(node.risk_score * 100).toFixed(0)}%
              </span>
            )}
          </div>
          {(dominantOutbound || dominantInbound) && (
            <div className="nd-dominant">
              {dominantOutbound && <span>OUT {relationName(dominantOutbound[0])} · {countConnections(dominantOutbound[1])}</span>}
              {dominantInbound && <span>IN {relationName(dominantInbound[0])} · {countConnections(dominantInbound[1])}</span>}
            </div>
          )}
        </div>
        <ConnectionPath
          node={node}
          project={project}
          refreshKey={exactRefreshKey}
          source={pathSource}
          onSourceChange={onPathSourceChange}
          onNavigate={onNavigate}
        />
        {!isInOverview && (
          <p role="status" className="nd-note nd-note-sky">
            Outside the representative map · exact neighborhood below.
          </p>
        )}
        {isInOverview && !isVisibleInOverview && (
          <p role="status" className="nd-note nd-note-violet">
            Hidden by active filters · exact neighborhood below.
          </p>
        )}
        {exactError && (
          <div
            role="alert"
            className="nd-alert"
          >
            <span>
              {exactErrorPhase === "more"
                ? "Could not load the next page: "
                : "Could not load exact connections: "}
              {exactError}
            </span>
            <button
              onClick={exactNeighborhood.retry}
              className="nd-retry"
            >
              {exactErrorPhase === "more" ? "Retry page" : "Retry exact load"}
            </button>
          </div>
        )}
        {exactData && connectionsArePartial && (
          <p role="status" aria-live="polite" className="nd-partial">
            Loaded {visibleConnectionCount.toLocaleString()} of {totalConnections.toLocaleString()} exact connections.
          </p>
        )}
      </div>

      {/* Connections */}
      <ScrollArea className="nd-scroll">
        <div className="nd-connections">
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
            <p role="status" className="nd-empty">
              Loading exact connections…
            </p>
          )}
          {connections.length === 0 && !exactPending && !exactError && (
            <p className="nd-empty opacity-70">No connections</p>
          )}
          {exactData?.page.next_cursor && exactErrorPhase !== "more" && (
            <button
              onClick={exactNeighborhood.loadMore}
              disabled={exactNeighborhood.loadingMore}
              aria-busy={exactNeighborhood.loadingMore}
              className="nd-more"
            >
              {exactNeighborhood.loadingMore ? "Loading more exact connections…" : "Load more exact connections"}
            </button>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ConnectionPath({
  node,
  project,
  refreshKey,
  source,
  onSourceChange,
  onNavigate,
}: {
  node: GraphNode;
  project: string | null;
  refreshKey?: string | number;
  source: GraphNode | null;
  onSourceChange: (node: GraphNode | null) => void;
  onNavigate: (node: GraphNode) => void;
}) {
  const start = source ?? node;
  const enabled = source != null && source.id !== node.id;
  const path = useExactPath(project, start.id, node.id, enabled, refreshKey);
  if (!source) {
    return (
      <button
        type="button"
        onClick={() => onSourceChange(node)}
        className="path-trigger"
      >
        Trace connection from here
      </button>
    );
  }

  const data = path.data;
  const stoppedMessage = data?.status === "not_found"
    ? "No connection exists in the complete project graph."
    : data?.status === "max_hops"
      ? `No path within ${data.limits.max_hops} hops; deeper links were not searched.`
      : data?.status === "limit_reached"
        ? "Search stopped at its safety limit; this does not prove the symbols are disconnected."
        : null;
  return (
    <div aria-label="Connection path" className="path-card">
      <div className="nd-between-start">
        <div className="nd-min">
          <p className="path-kicker">{enabled ? "Coupling path" : "Path start"}</p>
          <p className={enabled ? "path-route" : "path-source"}>
            {enabled ? `${source.name} → ${node.name}` : source.name}
          </p>
        </div>
        <button type="button" onClick={() => onSourceChange(null)} className="path-clear">Clear</button>
      </div>
      {!enabled && <p role="status" className="path-prompt">Choose another symbol on the map or with Search.</p>}
      {path.loading && <p role="status" className="path-loading">Searching the complete graph…</p>}
      {path.error && (
        <div role="alert" className="path-alert">
          <span>{path.error}</span>
          <button type="button" onClick={path.retry} className="path-retry">Retry</button>
        </div>
      )}
      {data?.status === "found" && (
        <div className="path-result">
          <p className="path-result-title">
            Exact shortest path · {data.hops} {data.hops === 1 ? "hop" : "hops"}
          </p>
          <ol className="path-list">
            {data.nodes.map((step, index) => {
              const edge = data.edges[index];
              const next = data.nodes[index + 1];
              const forward = edge?.source === step.id;
              const from = forward ? step : next;
              const to = forward ? next : step;
              return (
                <li key={step.id}>
                  <button
                    type="button"
                    aria-label={`Open path step ${step.name}`}
                    onClick={() => onNavigate(step)}
                    className="path-step"
                  >
                    <span className="path-step-name">{step.name}</span>
                    {step.file_path && <span className="path-step-file">{step.file_path}</span>}
                  </button>
                  {edge && next && from && to && (
                    <p
                      aria-label={`${relationName(edge.type)} points from ${from.name} to ${to.name}`}
                      className="path-relation"
                    >
                      {forward ? "↓" : "↑"} {relationName(edge.type)}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {stoppedMessage && <p role="status" className={`path-status${data?.status === "not_found" ? "" : " path-warning"}`}>{stoppedMessage}</p>}
    </div>
  );
}

export default NodeDetailPanel;

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
  return [...g.entries()].sort((a, b) => countConnections(b[1]) - countConnections(a[1]));
}

function countConnections(connections: Connection[]): number {
  return connections.reduce((sum, connection) => sum + connection.occurrences, 0);
}

function countGroups(groups: [string, Connection[]][]): number {
  return groups.reduce((sum, [, connections]) => sum + countConnections(connections), 0);
}

function flowRole(outbound: number, inbound: number, self: number): string {
  const externalOut = Math.max(0, outbound - self);
  const externalIn = Math.max(0, inbound - self);
  if (!externalOut && !externalIn) return self ? "Self-linked" : "Isolated";
  if (!externalIn) return "Outbound only";
  if (!externalOut) return "Inbound only";
  if (externalOut >= externalIn * 3) return "Outbound hub";
  if (externalIn >= externalOut * 3) return "Inbound hub";
  return "Connector";
}

function relationName(type: string): string {
  return type.replace(/_/g, " ").toLowerCase();
}

function connectionName(node: GraphNode, ambiguous: boolean): string {
  const file = node.file_path?.split(/[\\/]/).pop();
  if (node.name.startsWith("anonymous#") && file) {
    return `${file}${node.start_line != null ? `:${node.start_line}` : ""}`;
  }
  if (!ambiguous) return node.name;
  const qualified = node.qualified_name?.split("::");
  const scope = qualified && qualified.length > 1 ? qualified.at(-2) : file;
  return scope ? `${node.name} · ${scope}` : node.name;
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
      <p className="nd-section-title">
        {title} <span className="nd-section-count">({count})</span>
      </p>
      {groups.map(([type, conns]) => {
        const expanded = expandedTypes.has(type);
        const visibleConnections = expanded ? conns : conns.slice(0, 25);
        const normalizedType = relationName(type);
        const hiddenCount = conns.length - visibleConnections.length;
        const nameCounts = new Map<string, number>();
        let showLabels = false;
        for (const connection of conns) {
          nameCounts.set(connection.node.name, (nameCounts.get(connection.node.name) ?? 0) + 1);
          if (connection.node.label !== conns[0].node.label) showLabels = true;
        }
        return (
          <div key={type} className="nd-group">
            <p className="nd-relation-type">
              {normalizedType}
            </p>
            <div className="nd-relation-list">
              {visibleConnections.map((c) => {
                const displayName = connectionName(c.node, (nameCounts.get(c.node.name) ?? 0) > 1);
                return (
                  <button
                    key={c.node.id}
                    onClick={() => onNavigate(c.node)}
                    aria-label={`Open ${displayName} (${c.node.label})${c.occurrences > 1 ? `, ${c.occurrences} connections` : ""}`}
                    className="nd-connection group"
                  >
                    <span className="nd-connection-icon">{icon}</span>
                    <span className="nd-connection-dot" style={{ backgroundColor: colorForLabel(c.node.label) }} />
                    <span className="nd-connection-name">{displayName}</span>
                    {c.occurrences > 1 && <span className="nd-occurrences">×{c.occurrences}</span>}
                    {showLabels && <span className="nd-connection-label">{c.node.label}</span>}
                  </button>
                );
              })}
              {conns.length > 25 && (
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggleType(type)}
                  className="nd-connection-more"
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
