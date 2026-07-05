// graph-ui/src/components/StatsTab.tsx
// V2: Project list with health dots, ADR button, and create-index modal.
// Adapted from V1 to use V2 API client.

import { useProjects } from "../hooks/useProjects";
import { ProjectCard } from "./ProjectCard";



interface StatsTabProps {
  onSelectProject: (project: string) => void;
}

export function StatsTab({ onSelectProject }: StatsTabProps) {
  const { projects, loading, error, refresh } = useProjects();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[14px] font-semibold text-foreground/60 uppercase tracking-wider">
          Projects ({projects.length})
        </h2>
        <button
          onClick={refresh}
          className="px-3 py-1.5 rounded-lg bg-white/[0.04] text-foreground/50 hover:bg-white/[0.08] text-[12px]"
        >
          Refresh
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <p className="text-foreground/30 text-sm mb-2">No projects indexed</p>
          <p className="text-foreground/20 text-[12px]">
            Run <code className="text-primary/60">cbm index_repository</code> to build a code graph
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {projects.map((p) => (
            <ProjectCard
              key={p.name}
              project={p}
              onSelect={() => onSelectProject(p.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
