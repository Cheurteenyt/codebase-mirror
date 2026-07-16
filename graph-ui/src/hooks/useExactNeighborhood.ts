import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { GraphNeighborhoodData } from "../lib/types";

type LoadPhase = "initial" | "more";

interface NeighborhoodFailure {
  message: string;
  phase: LoadPhase;
  status: number | null;
  project: string;
  nodeId: number;
  refreshKey: RefreshKey;
}

interface ActiveRequest {
  controller: AbortController;
  revision: number;
  phase: LoadPhase;
}

type RefreshKey = string | number | null | undefined;

interface LoadedPages {
  project: string;
  nodeId: number;
  refreshKey: RefreshKey;
  pages: GraphNeighborhoodData[];
}

function failureMessage(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

function failureStatus(caught: unknown): number | null {
  return caught instanceof ApiError ? caught.code : null;
}

function isCurrentFailure(
  failure: NeighborhoodFailure | null,
  project: string | null,
  nodeId: number,
  refreshKey: RefreshKey,
): failure is NeighborhoodFailure {
  return failure != null
    && failure.project === project
    && failure.nodeId === nodeId
    && failure.refreshKey === refreshKey;
}

function isGraphRevisionMismatch(caught: unknown): boolean {
  if (!(caught instanceof ApiError) || caught.code !== 409) return false;
  const details = caught.details as { code?: unknown; restart_from_first_page?: unknown } | undefined;
  return details?.code === "GRAPH_REVISION_MISMATCH"
    && details.restart_from_first_page === true;
}

export function useExactNeighborhood(
  project: string | null,
  nodeId: number,
  enabled: boolean,
  refreshKey?: string | number | null,
) {
  const [loadedPages, setLoadedPages] = useState<LoadedPages | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<NeighborhoodFailure | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const requestRevisionRef = useRef(0);

  useEffect(() => {
    activeRequestRef.current?.controller.abort();
    activeRequestRef.current = null;
    const requestRevision = ++requestRevisionRef.current;
    setLoadedPages(null);
    setFailure(null);
    setLoading(false);
    setLoadingMore(false);
    if (!enabled || !project) return;

    const controller = new AbortController();
    activeRequestRef.current = {
      controller,
      revision: requestRevision,
      phase: "initial",
    };
    setLoading(true);
    void api.getNeighborhood(project, nodeId, null, { signal: controller.signal })
      .then((page) => {
        if (requestRevision !== requestRevisionRef.current || controller.signal.aborted) return;
        if (page.anchor.id !== nodeId) {
          setFailure({
            message: "Exact neighborhood response did not match the selected node",
            phase: "initial",
            status: null,
            project,
            nodeId,
            refreshKey,
          });
          return;
        }
        setLoadedPages({ project, nodeId, refreshKey, pages: [page] });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || requestRevision !== requestRevisionRef.current) return;
        if (isGraphRevisionMismatch(caught)) {
          // A reindex invalidates every accumulated edge page. Restart from
          // page one instead of presenting a mixed, falsely exact result.
          setLoadedPages(null);
          setFailure(null);
          setRetryRevision((value) => value + 1);
          return;
        }
        setFailure({
          message: failureMessage(caught, "Unable to load exact connections"),
          phase: "initial",
          status: failureStatus(caught),
          project,
          nodeId,
          refreshKey,
        });
      })
      .finally(() => {
        if (requestRevision !== requestRevisionRef.current || controller.signal.aborted) return;
        activeRequestRef.current = null;
        setLoading(false);
      });
    return () => {
      // The active request may be a pagination request that replaced the
      // completed initial request. Abort whichever request is current.
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
      requestRevisionRef.current += 1;
    };
  }, [enabled, nodeId, project, refreshKey, retryRevision]);

  // Effects clear stale state after commit. Mask it synchronously as soon as
  // the project, node, or caller-provided graph generation changes so a render
  // can never consume a frame belonging to the previous selection/revision.
  const pages = loadedPages
    && loadedPages.project === project
    && loadedPages.nodeId === nodeId
    && loadedPages.refreshKey === refreshKey
    ? loadedPages.pages
    : [];
  const currentFailure = isCurrentFailure(failure, project, nodeId, refreshKey)
    ? failure
    : null;

  const data = useMemo(() => {
    const first = pages[0];
    const last = pages.at(-1);
    if (!first || !last) return null;
    const nodes = new Map<number, GraphNeighborhoodData["nodes"][number]>();
    const edges = new Map<number, GraphNeighborhoodData["edges"][number]>();
    for (const page of pages) {
      for (const node of page.nodes) nodes.set(node.id, node);
      for (const edge of page.edges) edges.set(edge.id, edge);
    }
    return {
      ...first,
      nodes: [...nodes.values()].sort((left, right) => left.id - right.id),
      edges: [...edges.values()].sort((left, right) => left.id - right.id),
      page: {
        limit: first.page.limit,
        returned: edges.size,
        next_cursor: last.page.next_cursor,
      },
    } satisfies GraphNeighborhoodData;
  }, [pages]);

  const loadMore = useCallback(() => {
    const cursor = data?.page.next_cursor;
    if (!project || !cursor || loading || loadingMore || activeRequestRef.current) return;
    const controller = new AbortController();
    const requestRevision = ++requestRevisionRef.current;
    activeRequestRef.current = {
      controller,
      revision: requestRevision,
      phase: "more",
    };
    setLoadingMore(true);
    setFailure(null);
    void api.getNeighborhood(project, nodeId, cursor, { signal: controller.signal })
      .then((page) => {
        if (requestRevision !== requestRevisionRef.current || controller.signal.aborted) return;
        if (page.anchor.id !== nodeId) {
          setFailure({
            message: "Exact neighborhood response did not match the selected node",
            phase: "more",
            status: null,
            project,
            nodeId,
            refreshKey,
          });
          return;
        }
        if (data && page.graph_revision !== data.graph_revision) {
          // A backend should normally report this as a 409, but never merge
          // independently-versioned frames even if a proxy/server omitted it.
          setLoadedPages(null);
          setFailure(null);
          setRetryRevision((value) => value + 1);
          return;
        }
        setLoadedPages((previous) => {
          if (!previous
            || previous.project !== project
            || previous.nodeId !== nodeId
            || previous.refreshKey !== refreshKey) return previous;
          return { ...previous, pages: [...previous.pages, page] };
        });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || requestRevision !== requestRevisionRef.current) return;
        if (isGraphRevisionMismatch(caught)) {
          // A reindex invalidates every accumulated edge page. Restart from
          // page one instead of presenting a mixed, falsely exact result.
          setLoadedPages(null);
          setFailure(null);
          setRetryRevision((value) => value + 1);
          return;
        }
        setFailure({
          message: failureMessage(caught, "Unable to load more connections"),
          phase: "more",
          status: failureStatus(caught),
          project,
          nodeId,
          refreshKey,
        });
      })
      .finally(() => {
        if (requestRevision !== requestRevisionRef.current || controller.signal.aborted) return;
        activeRequestRef.current = null;
        setLoadingMore(false);
      });
  }, [data, loading, loadingMore, nodeId, project, refreshKey]);

  const retry = useCallback(() => {
    if (currentFailure?.phase === "more" && data?.page.next_cursor) {
      loadMore();
      return;
    }
    setFailure(null);
    setRetryRevision((value) => value + 1);
  }, [currentFailure?.phase, data?.page.next_cursor, loadMore]);

  return {
    data,
    loading,
    loadingMore,
    error: currentFailure?.message ?? null,
    errorPhase: currentFailure?.phase ?? null,
    errorStatus: currentFailure?.status ?? null,
    loadMore,
    retry,
  };
}
