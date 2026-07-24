import type { GraphScopeData } from "../lib/types";

interface ExactScopeControlsProps {
  hud: ExactScopeHudProps | null;
  active: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onOpen: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onClose: () => void;
}

interface ExactScopeHudProps {
  returnedNodes: number;
  totalNodes: number;
  visibleEdges: number;
  totalInternalEdges: number;
  complete: boolean;
  selectedCount: number;
  boundary: GraphScopeData["boundary"];
}

function ExactScopeHud({
  returnedNodes,
  totalNodes,
  visibleEdges,
  totalInternalEdges,
  complete,
  selectedCount,
  boundary,
}: ExactScopeHudProps) {
  const dependency = boundary.dependencies[0];
  return (
    <details className="group absolute left-14 top-3 z-20 max-w-[calc(100%-8rem)] overflow-hidden rounded-xl border border-white/10 bg-[#071219]/88 text-[10px] text-foreground/70 shadow-xl backdrop-blur-md lg:left-4 lg:top-4 lg:max-w-[min(760px,calc(100%-16rem))] lg:text-[11px]">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 font-mono marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400/70">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.8)]" />
        <span className="whitespace-nowrap">
          <strong className="font-semibold text-cyan-50">{returnedNodes.toLocaleString()}</strong>
          <span className="text-foreground/45"> / {totalNodes.toLocaleString()} exact nodes</span>
        </span>
        <span className={`whitespace-nowrap rounded-md border px-1.5 py-0.5 font-sans text-[9px] font-semibold uppercase tracking-[0.12em] ${complete ? "border-emerald-300/15 bg-emerald-300/[0.06] text-emerald-100/75" : "border-amber-300/15 bg-amber-300/[0.06] text-amber-100/75"}`}>
          {complete ? "exact" : "partial exact"}
        </span>
        {selectedCount > 0 && (
          <span className="hidden whitespace-nowrap text-cyan-300/65 md:inline">
            {selectedCount.toLocaleString()} selected
          </span>
        )}
        {dependency && (
          <span className="hidden whitespace-nowrap text-cyan-300/65 md:inline">
            References {dependency.direction === "outgoing" ? "→" : "←"} {dependency.external_key}
            {" · "}out:{boundary.outgoing_relations} in:{boundary.incoming_relations}
          </span>
        )}
      </summary>
      <div className="border-t border-white/[0.07] px-3 py-2 font-mono leading-relaxed text-foreground/48">
        <p>{visibleEdges.toLocaleString()} visible edges · {totalInternalEdges.toLocaleString()} internal edges</p>
      </div>
    </details>
  );
}

export default function ExactScopeControls({
  hud,
  active,
  loading,
  loadingMore,
  error,
  hasMore,
  onOpen,
  onLoadMore,
  onRetry,
  onClose,
}: ExactScopeControlsProps) {
  return (
    <>
      {hud && <ExactScopeHud {...hud} />}
      <div
        aria-live="polite"
        className="absolute left-14 top-16 z-20 flex max-w-[calc(100%-7rem)] items-center gap-2 rounded-xl border border-white/10 bg-[#071219]/90 px-2.5 py-2 text-[10px] text-slate-300 shadow-xl backdrop-blur-md lg:left-4 lg:text-[11px]"
      >
        {!active ? (
          <button
            onClick={onOpen}
            className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.08] px-2.5 py-1.5 font-medium text-cyan-100 hover:bg-cyan-300/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
          >
            Open exact scope
          </button>
        ) : (
          <>
            {loading && "Loading exact scope…"}
            {error && (
              <>
                <span className="max-w-48 truncate text-amber-200">{error}</span>
                <button onClick={onRetry} className="rounded-lg bg-amber-300/[0.1] px-2 py-1 text-amber-100 hover:bg-amber-300/[0.16]">
                  Retry
                </button>
              </>
            )}
            {hasMore && !error && (
              <button
                aria-label="Load more exact scope"
                disabled={loadingMore}
                onClick={onLoadMore}
                className="rounded-lg bg-white/[0.06] px-2 py-1 text-sky-100/80 hover:bg-white/[0.1] disabled:cursor-wait disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
            <button
              aria-label="Close exact scope"
              onClick={onClose}
              className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-white/[0.08] hover:text-slate-200"
            >
              ×
            </button>
          </>
        )}
      </div>
    </>
  );
}
