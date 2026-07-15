import { FolderSearch, RefreshCw, Sparkles } from "lucide-react";
import { useProjects } from "../hooks/useProjects";
import { ProjectCard } from "./ProjectCard";

interface StatsTabProps {
  onSelectProject: (project: string) => void;
}

export function StatsTab({ onSelectProject }: StatsTabProps) {
  const { projects, loading, error, refresh } = useProjects();

  if (loading) {
    return <div className="grid h-full place-items-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-300/20 border-t-cyan-300" /></div>;
  }

  if (error) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="rounded-2xl border border-red-400/20 bg-red-950/20 p-6 text-center">
          <p className="mb-4 text-sm text-red-200">{error}</p>
          <button onClick={refresh} className="rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2 text-[12px] text-slate-200">Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-[1320px]">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-300/75"><Sparkles className="h-3 w-3" />Workspace intelligence</div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50 sm:text-3xl">Choose a codebase</h1>
            <p className="mt-1.5 text-[12px] text-slate-400">Open a project dashboard before exploring its graph.</p>
          </div>
          <button onClick={refresh} className="flex w-fit items-center gap-2 rounded-xl border border-white/[0.09] bg-white/[0.04] px-3.5 py-2 text-[11px] text-slate-300 transition hover:bg-white/[0.08]"><RefreshCw className="h-3.5 w-3.5" />Refresh projects</button>
        </div>

        {projects.length === 0 ? (
          <div className="grid min-h-[360px] place-items-center rounded-3xl border border-dashed border-white/10 bg-white/[0.015] p-8 text-center">
            <div>
              <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/[0.04] text-slate-400"><FolderSearch className="h-5 w-5" /></span>
              <p className="text-sm font-medium text-slate-200">No projects indexed</p>
              <p className="mt-2 text-[11px] text-slate-500">Run <code className="rounded bg-cyan-300/[0.08] px-1.5 py-1 text-cyan-200">cbm-v2 index</code> to build your first graph.</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {projects.map((project) => <ProjectCard key={project.name} project={project} onSelect={() => onSelectProject(project.name)} />)}
          </div>
        )}
      </div>
    </div>
  );
}
