import { useCallback, useRef, useState } from "react";
import type { GraphData } from "../lib/types";
import { api } from "../api/client";

export const GRAPH_RENDER_NODE_LIMIT = 2000;

interface UseGraphDataResult {
  data: GraphData | null;
  loading: boolean;
  error: string | null;
  fetchOverview: (project: string) => void;
}

export function useGraphData(): UseGraphDataResult {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);
  // R43 (C1): track whether we have data for the CURRENT project. The loading
  // gate in GraphTab must NOT unmount GraphCanvas on a refetch (WS notification)
  // — doing so destroys the d3-force simulation and defeats the R40 sim-reuse
  // fix. We set loading=true ONLY when switching projects (no data for the new
  // project yet). Refetches for the SAME project keep the old data visible
  // (stale-while-revalidate) so the canvas stays mounted and the sim is preserved.
  const dataProjectRef = useRef<string | null>(null);

  const fetchOverview = useCallback(async (project: string) => {
    const reqId = ++reqIdRef.current;
    // If we're switching to a different project, show the spinner (no data yet
    // for this project). If we're refetching the same project (WS notification,
    // manual refresh), keep the existing data visible.
    const isProjectSwitch = dataProjectRef.current !== project;
    if (isProjectSwitch) {
      dataProjectRef.current = project;
      setLoading(true);
      setData(null); // clear stale project's data so the canvas doesn't show it
    }
    setError(null);
    try {
      const result = await api.getLayout(project, GRAPH_RENDER_NODE_LIMIT);
      if (reqIdRef.current !== reqId) return; // stale
      setData(result);
    } catch (e) {
      if (reqIdRef.current === reqId) setError(e instanceof Error ? e.message : "Failed to fetch layout");
    } finally {
      if (reqIdRef.current === reqId) setLoading(false);
    }
  }, []);

  return { data, loading, error, fetchOverview };
}
