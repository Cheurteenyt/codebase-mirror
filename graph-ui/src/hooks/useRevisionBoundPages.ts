import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";

type LoadPhase = "initial" | "more";

interface RevisionPage {
  graph_revision: string;
  page: { next_cursor: string | null };
}

interface Failure {
  identity: string;
  message: string;
  phase: LoadPhase;
  status: number | null;
}

function revisionMismatch(caught: unknown): boolean {
  if (!(caught instanceof ApiError) || caught.code !== 409) return false;
  const details = caught.details as { code?: unknown; restart_from_first_page?: unknown } | undefined;
  return details?.code === "GRAPH_REVISION_MISMATCH"
    && details.restart_from_first_page === true;
}

/** Shared abort/staleness/revision state machine for exact paginated reads. */
export function useRevisionBoundPages<TPage extends RevisionPage>({
  identity,
  enabled,
  fetchPage,
  validatePage,
  initialError,
  moreError,
}: {
  identity: string;
  enabled: boolean;
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<TPage>;
  validatePage: (page: TPage, first: TPage | null) => string | null;
  initialError: string;
  moreError: string;
}) {
  const [loaded, setLoaded] = useState<{ identity: string; pages: TPage[] } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retryRevision, setRetryRevision] = useState(0);
  const activeRequestRef = useRef<AbortController | null>(null);
  const requestRevisionRef = useRef(0);

  useEffect(() => {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    const requestRevision = ++requestRevisionRef.current;
    setLoaded(null);
    setFailure(null);
    setLoading(false);
    setLoadingMore(false);
    if (!enabled) return;

    const controller = new AbortController();
    activeRequestRef.current = controller;
    setLoading(true);
    void fetchPage(null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || requestRevision !== requestRevisionRef.current) return;
        const validationError = validatePage(page, null);
        if (validationError) {
          setFailure({ identity, message: validationError, phase: "initial", status: null });
          return;
        }
        setLoaded({ identity, pages: [page] });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || requestRevision !== requestRevisionRef.current) return;
        if (revisionMismatch(caught)) {
          setRetryRevision((value) => value + 1);
          return;
        }
        setFailure({
          identity,
          message: caught instanceof ApiError ? caught.message : initialError,
          phase: "initial",
          status: caught instanceof ApiError ? caught.code : null,
        });
      })
      .finally(() => {
        if (controller.signal.aborted || requestRevision !== requestRevisionRef.current) return;
        activeRequestRef.current = null;
        setLoading(false);
      });

    return () => {
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
      requestRevisionRef.current += 1;
    };
  }, [enabled, fetchPage, identity, initialError, retryRevision, validatePage]);

  const pages = loaded?.identity === identity ? loaded.pages : [];
  const currentFailure = failure?.identity === identity ? failure : null;

  const loadMore = useCallback(() => {
    const first = pages[0];
    const cursor = pages.at(-1)?.page.next_cursor;
    if (!enabled || !first || !cursor || loading || loadingMore || activeRequestRef.current) return;
    const controller = new AbortController();
    const requestRevision = ++requestRevisionRef.current;
    activeRequestRef.current = controller;
    setLoadingMore(true);
    setFailure(null);
    void fetchPage(cursor, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || requestRevision !== requestRevisionRef.current) return;
        if (page.graph_revision !== first.graph_revision) {
          setLoaded(null);
          setRetryRevision((value) => value + 1);
          return;
        }
        const validationError = validatePage(page, first);
        if (validationError) {
          setFailure({ identity, message: validationError, phase: "more", status: null });
          return;
        }
        setLoaded((previous) => previous?.identity === identity
          ? { identity, pages: [...previous.pages, page] }
          : previous);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || requestRevision !== requestRevisionRef.current) return;
        if (revisionMismatch(caught)) {
          setLoaded(null);
          setFailure(null);
          setRetryRevision((value) => value + 1);
          return;
        }
        setFailure({
          identity,
          message: caught instanceof ApiError ? caught.message : moreError,
          phase: "more",
          status: caught instanceof ApiError ? caught.code : null,
        });
      })
      .finally(() => {
        if (controller.signal.aborted || requestRevision !== requestRevisionRef.current) return;
        activeRequestRef.current = null;
        setLoadingMore(false);
      });
  }, [enabled, fetchPage, identity, loading, loadingMore, moreError, pages, validatePage]);

  const retry = useCallback(() => {
    if (currentFailure?.phase === "more" && pages.at(-1)?.page.next_cursor) {
      loadMore();
      return;
    }
    setFailure(null);
    setRetryRevision((value) => value + 1);
  }, [currentFailure?.phase, loadMore, pages]);

  return {
    pages,
    loading,
    loadingMore,
    error: currentFailure?.message ?? null,
    errorPhase: currentFailure?.phase ?? null,
    errorStatus: currentFailure?.status ?? null,
    loadMore,
    retry,
  };
}
