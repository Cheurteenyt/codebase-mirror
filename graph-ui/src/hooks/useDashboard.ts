// graph-ui/src/hooks/useDashboard.ts
// V2: Fetches dashboard data (KPIs, graph status, recommendations).

import { useCallback, useState } from "react";
import type { DashboardData } from "../lib/types";
import { api } from "../api/client";

interface UseDashboardResult {
  data: DashboardData | null;
  loading: boolean;
  error: string | null;
  fetch: (project: string) => void;
}

export function useDashboard(): UseDashboardResult {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async (project: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getDashboard(project);
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch dashboard");
    } finally {
      setLoading(false);
    }
  }, []);

  return { data, loading, error, fetch };
}
