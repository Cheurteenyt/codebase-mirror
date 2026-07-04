// graph-ui/src/hooks/useGraphData.ts
// Fetches graph layout data from the V2 API.
// Replaces V1's hook — same interface but uses the V2 api client.

import { useCallback, useState } from "react";
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

  const fetchOverview = useCallback(async (project: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getLayout(project, GRAPH_RENDER_NODE_LIMIT);
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch layout");
    } finally {
      setLoading(false);
    }
  }, []);

  return { data, loading, error, fetchOverview };
}
