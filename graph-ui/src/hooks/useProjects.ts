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
    // R45 (F4): AbortController cancels the in-flight fetch on unmount or
    // refresh. The old `cancelled` boolean prevented stale state updates but
    // the network request still ran to completion — for /api/projects that
    // means opening N SQLite readers (one per .db file) on the server, all
    // wasted if the user navigated away. Now the fetch is cancelled at the
    // network level too.
    const controller = new AbortController();
    setLoading(true);
    api
      .getProjects({ signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted || reqIdRef.current !== reqId) return;
        setProjects(data.projects ?? []);
        setError(null);
      })
      .catch((e) => {
        // AbortError is expected on unmount/refresh — swallow it.
        if (controller.signal.aborted || (e instanceof Error && e.name === "AbortError")) return;
        if (reqIdRef.current !== reqId) return;
        setError(e instanceof Error ? e.message : "Failed to fetch projects");
      })
      .finally(() => {
        if (!controller.signal.aborted && reqIdRef.current === reqId) setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [refreshKey]);

  const refresh = () => setRefreshKey((k) => k + 1);

  return { projects, loading, error, refresh };
}
