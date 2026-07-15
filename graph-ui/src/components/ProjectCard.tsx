import { ArrowUpRight, Database, GitFork, Network } from "lucide-react";
import type { Project } from "../lib/types";
import { formatBytes, formatNumber, timeAgo } from "../lib/utils";

interface ProjectCardProps {
  project: Project;
  onSelect: (project: string) => void;
}

export function ProjectCard({ project, onSelect }: ProjectCardProps) {
  const nodeCount = project.node_count ?? 0;
  const edgeCount = project.edge_count ?? 0;
  const status = project.status ?? "unknown";
  const isCorrupt = status === "corrupt";
  const density = nodeCount > 0 ? edgeCount / nodeCount : 0;

  return (
    <article className="group relative overflow-hidden rounded-2xl border border-white/[0.09] bg-gradient-to-br from-[#0b1923]/92 to-[#08131c]/88 p-5 shadow-[0_18px_60px_rgba(0,0,0,0.16)] transition duration-300 hover:-translate-y-0.5 hover:border-cyan-200/20 hover:shadow-[0_24px_80px_rgba(0,0,0,0.25)]">
      <div className="absolute -right-12 -top-14 h-36 w-36 rounded-full bg-cyan-300 opacity-[0.035] blur-3xl transition group-hover:opacity-[0.07]" />
      <div className="relative flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${isCorrupt ? "bg-red-400" : "bg-emerald-400 shadow-[0_0_9px_rgba(52,211,153,0.7)]"}`} />
            <span className={`text-[9px] font-semibold uppercase tracking-[0.16em] ${isCorrupt ? "text-red-300" : "text-slate-500"}`}>{isCorrupt ? "Needs repair" : "Indexed graph"}</span>
          </div>
          <h3 className="truncate text-base font-semibold tracking-tight text-slate-50">{project.name}</h3>
          <p className="mt-1 text-[10px] text-slate-400">Updated {timeAgo(project.indexed_at)}</p>
        </div>
        <button
          onClick={() => onSelect(project.name)}
          disabled={isCorrupt}
          className="group/button flex shrink-0 items-center gap-1.5 rounded-xl border border-cyan-300/20 bg-cyan-300/[0.10] px-3 py-2 text-[10px] font-medium text-cyan-100 transition hover:bg-cyan-300/[0.17] disabled:cursor-not-allowed disabled:opacity-40"
          title={isCorrupt ? "Code graph DB is corrupt" : "Open project dashboard"}
        >
          Open project
          <ArrowUpRight className="h-3 w-3 transition-transform group-hover/button:-translate-y-0.5 group-hover/button:translate-x-0.5" />
        </button>
      </div>

      {isCorrupt ? (
        <p className="relative mt-5 rounded-xl border border-red-400/15 bg-red-400/[0.06] p-3 text-[11px] text-red-200">⚠ Code graph DB is corrupt</p>
      ) : (
        <div className="relative mt-5 grid grid-cols-3 gap-2">
          <Metric icon={Network} label="Nodes" value={formatNumber(nodeCount)} />
          <Metric icon={GitFork} label="Edges" value={formatNumber(edgeCount)} />
          <Metric icon={Database} label={project.size_bytes != null ? "Storage" : "Density"} value={project.size_bytes != null ? formatBytes(project.size_bytes) : density.toFixed(1)} />
        </div>
      )}
    </article>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof Network; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/10 p-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-slate-500"><Icon className="h-3 w-3" /><span className="text-[8px] font-semibold uppercase tracking-wider">{label}</span></div>
      <p className="truncate font-mono text-[11px] text-slate-200">{value}</p>
    </div>
  );
}
