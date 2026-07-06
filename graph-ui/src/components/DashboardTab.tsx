// graph-ui/src/components/DashboardTab.tsx
// V2: Architecture dashboard — KPIs, graph freshness, recommendations, top modules.
// This is the DEFAULT view when a project is selected (replaces V1's graph-first approach).

import { useEffect, useState, useCallback } from "react";
import { useDashboard } from "../hooks/useDashboard";
import { useWebSocket } from "../hooks/useWebSocket";
import { colorForFreshness, colorForLabel } from "../lib/colors";
import { formatNumber, formatAge } from "../lib/utils";

interface DashboardTabProps {
  project: string;
  onNavigateToGraph: () => void;
}

export function DashboardTab({ project, onNavigateToGraph }: DashboardTabProps) {
  const { data, loading, error, fetch } = useDashboard();
  const [refreshKey, setRefreshKey] = useState(0);

  // R25: WebSocket for real-time updates. When human_nodes or human_edges
  // change (via CLI, MCP, or sync), the dashboard re-fetches automatically.
  const handleNotification = useCallback(() => {
    // Re-fetch the dashboard data when any notification arrives.
    // The hub debounces, so we won't get flooded.
    fetch(project);
  }, [fetch, project]);

  const { connected } = useWebSocket(project, handleNotification);
  // R25: 'connected' is used to show a live indicator in the header.
  void connected; // referenced for future UI indicator

  useEffect(() => {
    fetch(project);
  }, [project, fetch, refreshKey]);

  // R43 (H1): only show spinner on initial load (no data yet). Refetches
  // (WS notifications) keep the existing dashboard visible to avoid flicker.
  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-foreground/40 text-sm">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center p-8">
          <p className="text-red-400 text-sm mb-2">{error}</p>
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="px-4 py-2 rounded-lg bg-white/[0.04] text-foreground/60 hover:text-foreground hover:bg-white/[0.08] text-sm transition-all"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const gs = data.graph_status;
  const dc = data.documentation_coverage;
  const hm = data.human_memory;
  const cg = data.code_graph;

  return (
    <div className="h-full overflow-auto p-6 space-y-4">
      {/* Top row: KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label="Code Nodes"
          value={formatNumber(cg.total_nodes)}
          sub={`${formatNumber(cg.total_edges)} edges`}
          color="#60a5fa"
        />
        <KpiCard
          label="Human Notes"
          value={formatNumber(hm.total_notes)}
          sub={`${hm.adrs} ADRs · ${hm.bugs} bugs · ${hm.refactors} refactors`}
          color="#a78bfa"
        />
        <KpiCard
          label="Doc Coverage"
          value={dc.coverage_pct != null ? `${dc.coverage_pct.toFixed(0)}%` : "N/A"}
          sub={dc.coverage_pct != null ? `${dc.critical_modules_documented}/${dc.critical_modules_total} critical` : "no critical modules"}
          color={dc.coverage_pct != null && dc.coverage_pct < 50 ? "#fbbf24" : "#34d399"}
        />
        <KpiCard
          label="Graph Freshness"
          value={gs.freshness_label}
          sub={gs.stale ? gs.stale_reason ?? "stale" : formatAge(gs.age_seconds)}
          color={colorForFreshness(gs.freshness_label)}
        />
      </div>

      {/* Recommendations */}
      {data.recommendations.length > 0 && (
        <div className="rounded-xl border border-border/30 bg-[#0b1920]/60 p-4">
          <h3 className="text-[12px] font-semibold text-foreground/60 uppercase tracking-wider mb-3">
            Recommendations
          </h3>
          <div className="space-y-2">
            {data.recommendations.map((rec, i) => (
              <div
                key={i}
                className="flex items-start gap-2 text-[12px] text-foreground/70"
              >
                <span className="text-primary mt-0.5">→</span>
                <span>{rec}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Nodes by label */}
      {Object.keys(cg.nodes_by_label).length > 0 && (
        <div className="rounded-xl border border-border/30 bg-[#0b1920]/60 p-4">
          <h3 className="text-[12px] font-semibold text-foreground/60 uppercase tracking-wider mb-3">
            Nodes by Label
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {Object.entries(cg.nodes_by_label)
              .sort((a, b) => b[1] - a[1])
              .map(([label, count]) => (
                <div key={label} className="flex items-center gap-2 text-[12px]">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: colorForLabel(label) }}
                  />
                  <span className="text-foreground/50">{label}</span>
                  <span className="text-foreground/80 font-mono ml-auto">{formatNumber(count)}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={onNavigateToGraph}
          className="px-4 py-2 rounded-lg bg-primary/15 text-primary hover:bg-primary/25 text-[13px] font-medium transition-all"
        >
          View Graph →
        </button>
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          className="px-4 py-2 rounded-lg bg-white/[0.04] text-foreground/50 hover:bg-white/[0.08] text-[13px] transition-all"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-border/30 bg-[#0b1920]/60 p-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-[10px] font-medium text-foreground/40 uppercase tracking-wider">
          {label}
        </span>
      </div>
      <p className="text-[20px] font-semibold text-foreground/90 font-mono">{value}</p>
      <p className="text-[10px] text-foreground/30 mt-1">{sub}</p>
    </div>
  );
}

