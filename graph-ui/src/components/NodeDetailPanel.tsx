import { useMemo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { colorForLabel, colorForRisk } from "../lib/colors";
import type { GraphNode, GraphEdge } from "../lib/types";

interface Connection {
  node: GraphNode;
  edgeType: string;
  direction: "inbound" | "outbound";
}

interface NodeDetailPanelProps {
  node: GraphNode;
  allNodes: GraphNode[];
  allEdges: GraphEdge[];
  /** Kept for API compatibility — currently unused (no /api/repo-info endpoint). */
  project: string | null;
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
  allNodes,
  allEdges,
  onClose,
  onNavigate,
}: NodeDetailPanelProps) {
  const connections = useMemo(() => {
    const nodeMap = new Map<number, GraphNode>();
    for (const n of allNodes) nodeMap.set(n.id, n);
    const conns: Connection[] = [];
    for (const edge of allEdges) {
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

  // R43 (L2): memoize the split + grouping so it doesn't recompute on every
  // parent re-render. groupByType was O(n²) (spread-per-iteration); now O(n).
  const { groupedOutbound, groupedInbound } = useMemo(() => {
    const out: Connection[] = [];
    const inb: Connection[] = [];
    for (const c of connections) {
      if (c.direction === "outbound") out.push(c);
      else inb.push(c);
    }
    return { groupedOutbound: groupByType(out), groupedInbound: groupByType(inb) };
  }, [connections]);

  return (
    <div className="w-full bg-[#0b1920]/95 backdrop-blur-xl flex flex-col h-full min-h-0 overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-border/30">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colorForLabel(node.label) }} />
              <h3 className="text-[13px] font-semibold text-foreground truncate">{node.name}</h3>
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
            { label: "Out", value: groupedOutbound.reduce((s, [, c]) => s + c.length, 0), color: "text-primary" },
            { label: "In", value: groupedInbound.reduce((s, [, c]) => s + c.length, 0), color: "text-accent" },
            { label: "Total", value: connections.length, color: "text-foreground" },
          ].map((s) => (
            <div key={s.label}>
              <p className="text-[9px] text-foreground/25 uppercase tracking-widest">{s.label}</p>
              <p className={`text-[18px] font-semibold tabular-nums ${s.color}`}>{s.value}</p>
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
      </div>

      {/* Connections */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-4 py-3 space-y-4">
          {groupedOutbound.length > 0 && (
            <ConnectionSection title="References" count={groupedOutbound.reduce((s, [, c]) => s + c.length, 0)} icon="→" groups={groupedOutbound} onNavigate={onNavigate} />
          )}
          {groupedInbound.length > 0 && (
            <ConnectionSection title="Referenced by" count={groupedInbound.reduce((s, [, c]) => s + c.length, 0)} icon="←" groups={groupedInbound} onNavigate={onNavigate} />
          )}
          {connections.length === 0 && (
            <p className="text-[12px] text-foreground/20 text-center py-8">No connections</p>
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

function ConnectionSection({ title, count, icon, groups, onNavigate }: {
  title: string; count: number; icon: string;
  groups: [string, Connection[]][];
  onNavigate: (n: GraphNode) => void;
}) {
  return (
    <div>
      <p className="text-[11px] font-medium text-foreground/40 mb-2">
        {title} <span className="text-foreground/15">({count})</span>
      </p>
      {groups.map(([type, conns]) => (
        <div key={type} className="mb-2">
          <p className="text-[9px] text-foreground/20 uppercase tracking-wider mb-1 font-medium">
            {type.replace(/_/g, " ").toLowerCase()}
          </p>
          <div className="space-y-px">
            {conns.slice(0, 25).map((c, i) => (
              <button
                key={`${c.node.id}-${i}`}
                onClick={() => onNavigate(c.node)}
                className="flex items-center gap-1.5 w-full text-left px-2 py-[4px] rounded-md hover:bg-white/[0.04] text-[11px] transition-colors group"
              >
                <span className="text-foreground/15 text-[10px] group-hover:text-foreground/30">{icon}</span>
                <span className="w-[5px] h-[5px] rounded-full shrink-0" style={{ backgroundColor: colorForLabel(c.node.label) }} />
                <span className="text-foreground/55 group-hover:text-foreground/80 truncate">{c.node.name}</span>
                <span className="text-foreground/10 ml-auto text-[10px] shrink-0">{c.node.label}</span>
              </button>
            ))}
            {conns.length > 25 && (
              <p className="text-[10px] text-foreground/15 px-2 py-1">+{conns.length - 25} more</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
