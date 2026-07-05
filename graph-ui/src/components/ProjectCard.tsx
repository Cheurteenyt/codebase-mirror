import type { Project } from "../lib/types";
import { formatNumber, timeAgo } from "../lib/utils";

interface ProjectCardProps {
  project: Project;
  onSelect: (project: string) => void;
}

export function ProjectCard({ project, onSelect }: ProjectCardProps) {
  // R15: the V2 /api/projects endpoint now returns node_count, edge_count,
  // size_bytes, and status directly. No more "Loading schema..." placeholder.
  const nodeCount = project.node_count ?? 0;
  const edgeCount = project.edge_count ?? 0;
  const status = project.status ?? "unknown";
  const isCorrupt = status === "corrupt";

  return (
    <div className="border border-white/10 rounded-lg p-4 hover:border-white/20 transition-colors">
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-white font-medium truncate">{project.name}</h3>
          <p className="text-white/40 text-xs font-mono mt-0.5 truncate max-w-[300px]">
            Indexed {timeAgo(project.indexed_at)}
          </p>
        </div>
        <button
          onClick={() => onSelect(project.name)}
          disabled={isCorrupt}
          className="px-3 py-1 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 rounded text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title={isCorrupt ? "Code graph DB is corrupt" : undefined}
        >
          View Graph
        </button>
      </div>

      {isCorrupt ? (
        <p className="text-red-400/70 text-xs italic">⚠ Code graph DB is corrupt</p>
      ) : (
        <div className="flex gap-4 text-xs text-white/60">
          <span>{formatNumber(nodeCount)} nodes</span>
          <span>{formatNumber(edgeCount)} edges</span>
        </div>
      )}
    </div>
  );
}
