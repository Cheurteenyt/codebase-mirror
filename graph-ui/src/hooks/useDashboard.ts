import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardData } from "../lib/types";
import { api } from "../api/client";

interface UseDashboardResult {
  data: DashboardData | null;
  loading: boolean;
  error: string | null;
  fetch: (project: string) => Promise<void>;
}

export function useDashboard(): UseDashboardResult {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // R43 (H1): same fix as useGraphData (C1) — only show loading spinner on
  // initial fetch / project switch. Refetches (WS notifications) keep the
  // existing dashboard visible to avoid the full-spinner flicker.
  const dataProjectRef = useRef<string | null>(null);
  const loadedProjectRef = useRef<string | null>(null);

  const fetch = useCallback(async (project: string) => {
    const reqId = ++reqIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const isProjectSwitch = dataProjectRef.current !== project;
    if (isProjectSwitch) {
      dataProjectRef.current = project;
      setData(null);
    }
    // A retry after the initial request failed has no valid stale data, so it
    // remains an initial load even though the project string is unchanged.
    if (isProjectSwitch || loadedProjectRef.current !== project) setLoading(true);
    setError(null);
    try {
      const result = await api.getDashboard(project, { signal: controller.signal });
      if (reqIdRef.current !== reqId) return; // stale
      loadedProjectRef.current = project;
      setData(result);
    } catch (e) {
      if (controller.signal.aborted) return;
      if (reqIdRef.current === reqId) setError(e instanceof Error ? e.message : "Failed to fetch dashboard");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!controller.signal.aborted && reqIdRef.current === reqId) setLoading(false);
    }
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { data, loading, error, fetch };
}
