// graph-ui/src/hooks/useProjects.ts
import type { Project } from "../lib/types";
// Fetches project list from the V2 API.

import { useEffect, useState, useRef } from "react";

import { api } from "../api/client";

interface UseProjectsResult {
  projects: Project[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // R24: reqIdRef prevents stale responses from overwriting newer data.
  // If the user clicks "Refresh" rapidly, only the latest response is applied.
  const reqIdRef = useRef(0);

  useEffect(() => {
    const reqId = ++reqIdRef.current;
    let cancelled = false;
    setLoading(true);
    api
      .getProjects()
      .then((data) => {
        // R24: only apply if this is the latest request AND not cancelled.
        if (cancelled || reqIdRef.current !== reqId) return;
        setProjects(data.projects ?? []);
        setError(null);
      })
      .catch((e) => {
        if (cancelled || reqIdRef.current !== reqId) return;
        setError(e instanceof Error ? e.message : "Failed to fetch projects");
      })
      .finally(() => {
        if (!cancelled && reqIdRef.current === reqId) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const refresh = () => setRefreshKey((k) => k + 1);

  return { projects, loading, error, refresh };
}
