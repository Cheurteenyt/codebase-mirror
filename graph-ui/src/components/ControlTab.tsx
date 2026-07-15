// graph-ui/src/components/ControlTab.tsx
// V2 ControlTab — system info, processes, logs.
// R17: now uses /api/processes, /api/logs, /api/index-status endpoints.
// R24: fixed setState-on-unmounted via cancelled flag + abort stale refresh.

import { useEffect, useState, useCallback, useRef } from "react";
import { api, ApiError } from "../api/client";
import type { ProcessInfo } from "../lib/types";
import { formatBytes } from "../lib/utils";

export function ControlTab() {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Array<{ id: string; status: string; error?: string; started_at: string; project: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [terminateError, setTerminateError] = useState<string | null>(null);
  // R47 (M1): replaced mountedRef with AbortController for real network
  // cancellation. The old mountedRef prevented setState on unmounted but
  // the 3 API requests still ran to completion (each spawning ps aux on
  // the server). Now the fetch is cancelled at the network level.
  const abortRef = useRef<AbortController | null>(null);
  // R47 (L3): track the kill-refresh timer so it can be cleaned up on unmount.
  const terminateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [procRes, logRes, jobRes] = await Promise.all([
        api.getProcesses({ signal }),
        api.getLogs(50, { signal }),
        api.getIndexStatus({ signal }),
      ]);
      if (signal?.aborted) return;
      setProcesses(procRes.processes ?? []);
      setLogs(logRes.lines ?? []);
      setJobs(jobRes.jobs ?? []);
    } catch (e) {
      // AbortError is expected on unmount/refresh — swallow it.
      if (signal?.aborted) return;
      if (e instanceof ApiError && e.code === 0) return; // timeout or abort
      setError(e instanceof Error ? e.message : "Failed to fetch control data");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    refresh(controller.signal);
    // Auto-refresh every 10 seconds. R47 (M1): guard against overlapping
    // refreshes on slow backends — the AbortController cancels the previous
    // batch before starting a new one.
    // R48 (#2): use abortRef.current?.abort() instead of controller.abort()
    // — the closure captures the ORIGINAL controller, not the latest one.
    // After the first interval, abortRef.current points to a NEW controller,
    // but controller.abort() would abort the already-aborted original,
    // leaving the new one running forever.
    const interval = setInterval(() => {
      abortRef.current?.abort(); // abort the CURRENT controller, not the stale one
      const newController = new AbortController();
      abortRef.current = newController;
      refresh(newController.signal);
    }, 10000);
    return () => {
      abortRef.current?.abort(); // R48 (#2): abort current, not stale closure
      clearInterval(interval);
      // Clean up the delayed post-termination refresh.
      if (terminateTimerRef.current) clearTimeout(terminateTimerRef.current);
    };
  }, [refresh]);

  // Only server-owned running index jobs are terminable, by job ID.
  const handleTerminate = async (jobId: string) => {
    if (!window.confirm(`Terminate index job ${jobId}?`)) return;
    setTerminateError(null);
    try {
      await api.terminateIndexJob(jobId);
      // Replace any pending delayed refresh after a termination request.
      if (terminateTimerRef.current) clearTimeout(terminateTimerRef.current);
      terminateTimerRef.current = setTimeout(() => refresh(abortRef.current?.signal), 500);
    } catch (e) {
      setTerminateError(e instanceof Error ? e.message : "Failed to terminate index job");
    }
  };

  if (loading && processes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-red-400 text-sm mb-2">{error}</p>
          <button onClick={() => refresh(abortRef.current?.signal)} className="px-4 py-2 rounded-lg bg-white/[0.04] text-foreground/60 hover:bg-white/[0.08] text-sm">
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold text-foreground/60 uppercase tracking-wider">
          System Control
        </h2>
        <button onClick={() => refresh(abortRef.current?.signal)} className="px-3 py-1.5 rounded-lg bg-white/[0.04] text-foreground/50 hover:bg-white/[0.08] text-[12px]">
          Refresh
        </button>
      </div>

      {terminateError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[12px] text-red-400">
          {terminateError}
        </div>
      )}

      {/* Server Status */}
      <div className="rounded-xl border border-border/30 bg-[#0b1920]/60 p-4">
        <h3 className="text-[12px] font-medium text-foreground/40 mb-3">Server Status</h3>
        <div className="space-y-2 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400" />
            <span className="text-foreground/60">V2 UI Server running</span>
          </div>
        </div>
      </div>

      {/* Index Jobs */}
      {jobs.length > 0 && (
        <div className="rounded-xl border border-border/30 bg-[#0b1920]/60 p-4">
          <h3 className="text-[12px] font-medium text-foreground/40 mb-3">Index Jobs</h3>
          <div className="space-y-1.5">
            {jobs.slice(0, 10).map((job) => (
              <div key={job.id} className="flex items-center gap-3 text-[11px] font-mono">
                <span className={`px-2 py-0.5 rounded ${
                  job.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                  job.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                  job.status === 'running' ? 'bg-blue-500/20 text-blue-400' :
                  'bg-yellow-500/20 text-yellow-400'
                }`}>
                  {job.status}
                </span>
                <span className="text-foreground/40 truncate">{job.project}</span>
                <span className="text-foreground/20 ml-auto">{job.started_at}</span>
                {job.status === 'running' && (
                  <button
                    onClick={() => handleTerminate(job.id)}
                    className="px-2 py-0.5 rounded text-red-400/60 hover:bg-red-500/10 hover:text-red-400 text-[10px]"
                  >
                    Terminate
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Processes */}
      <div className="rounded-xl border border-border/30 bg-[#0b1920]/60 p-4">
        <h3 className="text-[12px] font-medium text-foreground/40 mb-3">
          Processes ({processes.length})
        </h3>
        {processes.length === 0 ? (
          <p className="text-foreground/30 text-[12px]">No processes found (or not available on this platform).</p>
        ) : (
          <div className="space-y-1">
            {processes.slice(0, 20).map((p) => (
              <div key={p.pid} className="flex items-center gap-2 text-[11px] font-mono py-1 px-2 rounded hover:bg-white/[0.03]">
                <span className={`w-2 h-2 rounded-full ${p.is_self ? 'bg-cyan-400' : 'bg-foreground/30'}`} />
                <span className="text-foreground/40 tabular-nums w-16">{p.pid}</span>
                <span className="text-foreground/30 tabular-nums w-14">{p.cpu.toFixed(1)}%</span>
                <span className="text-foreground/30 tabular-nums w-20">{formatBytes(p.rss_mb * 1024 * 1024)}</span>
                <span className="text-foreground/50 truncate flex-1">{p.command}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Logs */}
      <div className="rounded-xl border border-border/30 bg-[#0b1920]/60 p-4">
        <h3 className="text-[12px] font-medium text-foreground/40 mb-3">Recent Logs</h3>
        {logs.length === 0 ? (
          <p className="text-foreground/30 text-[12px]">No logs yet.</p>
        ) : (
          <pre className="text-[10px] font-mono text-foreground/40 overflow-auto max-h-[200px] whitespace-pre-wrap">
            {logs.join('\n')}
          </pre>
        )}
      </div>
    </div>
  );
}
