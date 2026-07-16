import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { GraphNodeSearchData } from "../lib/types";

type LoadPhase = "initial" | "more";

type RefreshKey = string | number | undefined;

interface SearchContext {
  project: string;
  query: string;
  refreshKey: RefreshKey;
}

interface SearchFailure extends SearchContext {
  message: string;
  phase: LoadPhase;
  status: number | null;
}

interface ActiveRequest {
  controller: AbortController;
  revision: number;
}

interface LoadedPages extends SearchContext {
  pages: GraphNodeSearchData[];
}

function failureMessage(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : "Unable to search the complete project";
}

function failureStatus(caught: unknown): number | null {
  return caught instanceof ApiError ? caught.code : null;
}

function isCurrentContext(
  context: SearchContext | null,
  project: string | null,
  query: string,
  refreshKey: RefreshKey,
): context is SearchContext {
  return context != null
    && context.project === project
    && context.query === query
    && context.refreshKey === refreshKey;
}

function isGraphRevisionMismatch(caught: unknown): boolean {
  if (!(caught instanceof ApiError) || caught.code !== 409) return false;
  const details = caught.details as { code?: unknown; restart_from_first_page?: unknown } | undefined;
  return details?.code === "GRAPH_REVISION_MISMATCH"
    && details.restart_from_first_page === true;
}

/**
 * Debounced, exact project-wide node search. Local overview filtering can stay
 * instant in the Sidebar while this hook establishes whether the same query
 * matches nodes outside the 1,000-node representative map.
 */
export function useExactNodeSearch(
  project: string | null,
  query: string,
  debounceMs = 180,
  refreshKey?: string | number,
) {
  const normalizedQuery = query.trim();
  const [loadedPages, setLoadedPages] = useState<LoadedPages | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingContext, setLoadingContext] = useState<SearchContext | null>(null);
  const [loadingMoreContext, setLoadingMoreContext] = useState<SearchContext | null>(null);
  const [failure, setFailure] = useState<SearchFailure | null>(null);
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
    setLoadingContext(null);
    setLoadingMoreContext(null);
    if (!project || normalizedQuery.length === 0) return;

    setLoading(true);
    setLoadingContext({ project, query: normalizedQuery, refreshKey });
    const timer = window.setTimeout(() => {
      const controller = new AbortController();
      activeRequestRef.current = { controller, revision: requestRevision };
      void api.searchNodes(project, normalizedQuery, null, { signal: controller.signal })
        .then((page) => {
          if (requestRevision !== requestRevisionRef.current || controller.signal.aborted) return;
          setLoadedPages({
            project,
            query: normalizedQuery,
            refreshKey,
            pages: [page],
          });
        })
        .catch((caught: unknown) => {
          if (requestRevision !== requestRevisionRef.current || controller.signal.aborted) return;
          setFailure({
            message: failureMessage(caught),
            phase: "initial",
            status: failureStatus(caught),
            project,
            query: normalizedQuery,
            refreshKey,
          });
        })
        .finally(() => {
          if (requestRevision !== requestRevisionRef.current || controller.signal.aborted) return;
          activeRequestRef.current = null;
          setLoading(false);
          setLoadingContext(null);
        });
    }, Math.max(0, debounceMs));

    return () => {
      window.clearTimeout(timer);
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
      requestRevisionRef.current += 1;
    };
  }, [debounceMs, normalizedQuery, project, refreshKey, retryRevision]);

  // Clearing in an effect is too late for a project/query transition: React
  // renders once before that cleanup. Only expose pages whose full request
  // context matches the current consumer so project A can never flash in B.
  const pages = loadedPages
    && loadedPages.project === project
    && loadedPages.query === normalizedQuery
    && loadedPages.refreshKey === refreshKey
    ? loadedPages.pages
    : [];
  const currentFailure = isCurrentContext(failure, project, normalizedQuery, refreshKey)
    ? failure
    : null;
  const currentLoading = loading
    && isCurrentContext(loadingContext, project, normalizedQuery, refreshKey);
  const currentLoadingMore = loadingMore
    && isCurrentContext(loadingMoreContext, project, normalizedQuery, refreshKey);

  const data = useMemo(() => {
    const first = pages[0];
    const last = pages.at(-1);
    if (!first || !last) return null;
    const nodes = new Map<number, GraphNodeSearchData["nodes"][number]>();
    for (const page of pages) {
      for (const node of page.nodes) {
        if (!nodes.has(node.id)) nodes.set(node.id, node);
      }
    }
    return {
      ...first,
      nodes: [...nodes.values()],
      returned_nodes: nodes.size,
      truncated: last.page.next_cursor != null,
      page: {
        limit: first.page.limit,
        returned: nodes.size,
        next_cursor: last.page.next_cursor,
      },
    } satisfies GraphNodeSearchData;
  }, [pages]);

  const loadMore = useCallback(() => {
    const cursor = data?.page.next_cursor;
    if (!project || !normalizedQuery || !cursor || currentLoading || currentLoadingMore || activeRequestRef.current) return;
    const controller = new AbortController();
    const requestRevision = ++requestRevisionRef.current;
    activeRequestRef.current = { controller, revision: requestRevision };
    setLoadingMore(true);
    setLoadingMoreContext({ project, query: normalizedQuery, refreshKey });
    setFailure(null);
    void api.searchNodes(project, normalizedQuery, cursor, { signal: controller.signal })
      .then((page) => {
        if (requestRevision !== requestRevisionRef.current || controller.signal.aborted) return;
        if (data && page.graph_revision !== data.graph_revision) {
          setLoadedPages(null);
          setFailure(null);
          setRetryRevision((value) => value + 1);
          return;
        }
        setLoadedPages((previous) => {
          if (!previous
            || previous.project !== project
            || previous.query !== normalizedQuery
            || previous.refreshKey !== refreshKey) return previous;
          return { ...previous, pages: [...previous.pages, page] };
        });
      })
      .catch((caught: unknown) => {
        if (requestRevision !== requestRevisionRef.current || controller.signal.aborted) return;
        if (isGraphRevisionMismatch(caught)) {
          // Never merge pages from two immutable graph revisions. Discard the
          // old result and transparently establish a fresh page-one snapshot.
          setLoadedPages(null);
          setFailure(null);
          setRetryRevision((value) => value + 1);
          return;
        }
        setFailure({
          message: failureMessage(caught),
          phase: "more",
          status: failureStatus(caught),
          project,
          query: normalizedQuery,
          refreshKey,
        });
      })
      .finally(() => {
        if (requestRevision !== requestRevisionRef.current || controller.signal.aborted) return;
        activeRequestRef.current = null;
        setLoadingMore(false);
        setLoadingMoreContext(null);
      });
  }, [currentLoading, currentLoadingMore, data, normalizedQuery, project, refreshKey]);

  const retry = useCallback(() => {
    if (currentFailure?.phase === "more" && data?.page.next_cursor) {
      loadMore();
      return;
    }
    setFailure(null);
    setRetryRevision((value) => value + 1);
  }, [currentFailure?.phase, data?.page.next_cursor, loadMore]);

  return {
    query: normalizedQuery,
    data,
    loading: currentLoading,
    loadingMore: currentLoadingMore,
    error: currentFailure?.message ?? null,
    errorPhase: currentFailure?.phase ?? null,
    errorStatus: currentFailure?.status ?? null,
    loadMore,
    retry,
  };
}
