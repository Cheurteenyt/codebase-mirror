import { useCallback, useEffect, useRef, useState } from "react";
import type { GraphData } from "../lib/types";
import { api } from "../api/client";

// A stratified 1k-node overview retains every label and the highest-degree
// hubs while cutting the main-thread d3 workload and payload roughly in half.
export const GRAPH_RENDER_NODE_LIMIT = 1000;

interface UseGraphDataResult {
  data: GraphData | null;
  loading: boolean;
  error: string | null;
  fetchOverview: (project: string) => Promise<void>;
}

export function useGraphData(): UseGraphDataResult {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // R43 (C1): track whether we have data for the CURRENT project. The loading
  // gate in GraphTab must NOT unmount GraphCanvas on a refetch (WS notification)
  // — doing so destroys the d3-force simulation and defeats the R40 sim-reuse
  // fix. We set loading=true ONLY when switching projects (no data for the new
  // project yet). Refetches for the SAME project keep the old data visible
  // (stale-while-revalidate) so the canvas stays mounted and the sim is preserved.
  const dataProjectRef = useRef<string | null>(null);
  // Keep request identity separate from successful-data identity. If the first
  // request fails, a same-project retry is still an initial load and must show
  // loading feedback instead of briefly rendering the empty-state message.
  const loadedProjectRef = useRef<string | null>(null);

  const fetchOverview = useCallback(async (project: string) => {
    const reqId = ++reqIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    // If we're switching to a different project, show the spinner (no data yet
    // for this project). If we're refetching the same project (WS notification,
    // manual refresh), keep the existing data visible.
    const isProjectSwitch = dataProjectRef.current !== project;
    if (isProjectSwitch) {
      dataProjectRef.current = project;
      setData(null); // clear stale project's data so the canvas doesn't show it
    }
    if (isProjectSwitch || loadedProjectRef.current !== project) setLoading(true);
    setError(null);
    try {
      const result = await api.getLayout(project, GRAPH_RENDER_NODE_LIMIT, {
        signal: controller.signal,
      });
      if (reqIdRef.current !== reqId) return; // stale
      loadedProjectRef.current = project;
      setData(result);
    } catch (e) {
      if (controller.signal.aborted) return;
      if (reqIdRef.current === reqId) setError(e instanceof Error ? e.message : "Failed to fetch layout");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      // An aborted current request commonly means the component unmounted.
      // Avoid scheduling a state update after cleanup.
      if (!controller.signal.aborted && reqIdRef.current === reqId) setLoading(false);
    }
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { data, loading, error, fetchOverview };
}
