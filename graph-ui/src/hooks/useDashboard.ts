import { useCallback, useRef, useState } from "react";
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
  const reqIdRef = useRef(0);

  const fetch = useCallback(async (project: string) => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getDashboard(project);
      if (reqIdRef.current !== reqId) return; // stale
      setData(result);
    } catch (e) {
      if (reqIdRef.current === reqId) setError(e instanceof Error ? e.message : "Failed to fetch dashboard");
    } finally {
      if (reqIdRef.current === reqId) setLoading(false);
    }
  }, []);

  return { data, loading, error, fetch };
}
