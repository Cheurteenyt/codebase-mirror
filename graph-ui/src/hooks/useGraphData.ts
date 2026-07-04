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

  const fetchOverview = useCallback(async (project: string) => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
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
