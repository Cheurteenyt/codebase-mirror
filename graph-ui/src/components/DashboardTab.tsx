// Architecture dashboard — fast, readable system health before graph exploration.

import { useEffect, useState, useCallback, type ComponentType } from "react";
import {
  ArrowUpRight,
  BookOpenCheck,
  BrainCircuit,
  GitBranch,
  Network,
  RefreshCw,
  Sparkles,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useDashboard } from "../hooks/useDashboard";
import { useWebSocket } from "../hooks/useWebSocket";
import { colorForFreshness, colorForLabel } from "../lib/colors";
import { formatNumber, formatAge } from "../lib/utils";

interface DashboardTabProps {
  project: string;
  active?: boolean;
  onNavigateToGraph: () => void;
}

export function DashboardTab({ project, active = true, onNavigateToGraph }: DashboardTabProps) {
  const { data, loading, error, fetch } = useDashboard();
  const [refreshKey, setRefreshKey] = useState(0);

  const handleNotification = useCallback(() => {
    void fetch(project);
  }, [fetch, project]);
  // The dashboard remains mounted as a warm cache when another tab is active,
  // but hidden views must not keep a duplicate WebSocket alive.
  const { connected } = useWebSocket(active ? project : null, handleNotification);

  useEffect(() => {
    if (active) void fetch(project);
  }, [active, project, fetch, refreshKey]);

  if (loading && !data) return <DashboardLoading />;

  if (error && !data) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-md rounded-2xl border border-red-400/20 bg-red-950/20 p-6 text-center shadow-2xl">
          <p className="mb-4 text-sm text-red-200">{error}</p>
          <button onClick={() => setRefreshKey((key) => key + 1)} className="rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2 text-sm text-slate-200 transition hover:bg-white/[0.10]">Retry</button>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const gs = data.graph_status;
  const dc = data.documentation_coverage;
  const hm = data.human_memory;
  const activeBugs = hm.active_bugs ?? hm.bugs;
  const activeRefactors = hm.active_refactors ?? hm.refactors;
  const cg = data.code_graph;
  const labelEntries = Object.entries(cg.nodes_by_label).sort((a, b) => b[1] - a[1]);
  const maxLabelCount = Math.max(1, ...labelEntries.map(([, count]) => count));

  return (
    <div className="h-full overflow-auto px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <div className="mx-auto max-w-[1480px] space-y-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-300/75">
              <Sparkles className="h-3 w-3" />
              System intelligence
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50 sm:text-3xl">Architecture at a glance</h1>
            <p className="mt-1.5 max-w-2xl text-[12px] leading-5 text-slate-400">
              Current graph health, memory coverage, and the signals worth checking before an edit.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] ${connected ? "border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-300" : "border-amber-400/20 bg-amber-400/[0.07] text-amber-200"}`}>
              {connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {connected ? "Live updates" : "Reconnecting"}
            </span>
            <span className="rounded-full border border-white/[0.08] bg-white/[0.035] px-2.5 py-1 font-mono text-[10px] text-slate-400">{project}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiCard icon={Network} label="Code graph" value={formatNumber(cg.total_nodes)} sub={`${formatNumber(cg.total_edges)} relationships`} color="#60a5fa" />
          <KpiCard icon={BrainCircuit} label="Human memory" value={formatNumber(hm.total_notes)} sub={`${hm.adrs} ADRs · ${activeBugs}/${hm.bugs} active bugs · ${activeRefactors}/${hm.refactors} active refactors`} color="#a78bfa" />
          <KpiCard icon={BookOpenCheck} label="Documentation" value={dc.coverage_pct != null ? `${dc.coverage_pct.toFixed(0)}%` : "N/A"} sub={dc.coverage_pct != null ? `${dc.critical_modules_documented}/${dc.critical_modules_total} critical covered${dc.coverage_is_partial ? " · partial scan" : ""}` : "No critical modules detected"} color={dc.coverage_pct != null && dc.coverage_pct < 50 ? "#fbbf24" : "#34d399"} />
          <KpiCard icon={GitBranch} label="Graph freshness" value={gs.freshness_label} sub={gs.stale ? gs.stale_reason ?? "Stale graph" : `Indexed ${formatAge(gs.age_seconds)} ago`} color={colorForFreshness(gs.freshness_label)} />
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)]">
          <section className="rounded-2xl border border-white/[0.09] bg-gradient-to-br from-[#0b1a24]/90 to-[#09131c]/80 p-5 shadow-[0_18px_60px_rgba(0,0,0,0.18)]">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-300">Topology mix</h2>
                <p className="mt-1 text-[11px] text-slate-500">Indexed entities by semantic label</p>
              </div>
              <span className="rounded-full bg-cyan-300/[0.08] px-2 py-1 text-[9px] font-medium uppercase tracking-wider text-cyan-200">{labelEntries.length} labels</span>
            </div>
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {labelEntries.map(([label, count]) => (
                <div key={label}>
                  <div className="mb-1.5 flex items-center gap-2 text-[11px]">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorForLabel(label), boxShadow: `0 0 10px ${colorForLabel(label)}55` }} />
                    <span className="text-slate-300">{label}</span>
                    <span className="ml-auto font-mono text-slate-400">{formatNumber(count)}</span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-white/[0.055]">
                    <div className="h-full rounded-full opacity-80" style={{ width: `${Math.max(3, (count / maxLabelCount) * 100)}%`, backgroundColor: colorForLabel(label) }} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-white/[0.09] bg-[#0a1720]/82 p-5 shadow-[0_18px_60px_rgba(0,0,0,0.18)]">
            <div className="mb-4 flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-cyan-300/[0.10] text-cyan-200"><Sparkles className="h-3.5 w-3.5" /></span>
              <div>
                <h2 className="text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-300">Recommended next</h2>
                <p className="mt-0.5 text-[10px] text-slate-500">Prioritized from graph state</p>
              </div>
            </div>
            <div className="space-y-2.5">
              {(data.recommendations.length > 0 ? data.recommendations : ["Project is ready for exploration."]).map((recommendation, index) => (
                <div key={`${index}-${recommendation}`} className="flex gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.025] p-3 text-[11px] leading-5 text-slate-300">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-300" />
                  <span>{recommendation}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="flex flex-wrap gap-2.5">
          <button onClick={onNavigateToGraph} className="group flex items-center gap-2 rounded-xl border border-cyan-300/20 bg-cyan-300/[0.11] px-4 py-2.5 text-[12px] font-medium text-cyan-100 shadow-[0_8px_30px_rgba(34,211,238,0.08)] transition hover:bg-cyan-300/[0.17]">
            Explore graph <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          </button>
          <button onClick={() => setRefreshKey((key) => key + 1)} className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.035] px-4 py-2.5 text-[12px] text-slate-300 transition hover:bg-white/[0.07]">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
          {error && data && <span className="self-center text-[10px] text-amber-300">Refresh failed; showing the last valid snapshot.</span>}
        </div>
      </div>
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, sub, color }: { icon: ComponentType<{ className?: string; strokeWidth?: number }>; label: string; value: string; sub: string; color: string }) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-white/[0.09] bg-[#0a1720]/82 p-4 shadow-[0_16px_50px_rgba(0,0,0,0.16)] transition hover:-translate-y-0.5 hover:border-white/[0.15] sm:p-5">
      <div className="absolute -right-7 -top-7 h-24 w-24 rounded-full opacity-[0.07] blur-2xl" style={{ backgroundColor: color }} />
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-400">{label}</span>
        <span className="grid h-7 w-7 place-items-center rounded-lg border border-white/[0.07] bg-white/[0.035]" style={{ color }}><Icon className="h-3.5 w-3.5" strokeWidth={1.8} /></span>
      </div>
      <p className="font-mono text-xl font-semibold tracking-tight text-slate-50 sm:text-2xl">{value}</p>
      <p className="mt-1.5 truncate text-[10px] text-slate-400">{sub}</p>
    </div>
  );
}

function DashboardLoading() {
  return (
    <div className="grid h-full place-items-center">
      <div className="text-center">
        <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-cyan-300/20 border-t-cyan-300" />
        <p className="text-[12px] text-slate-400">Building system overview…</p>
      </div>
    </div>
  );
}
