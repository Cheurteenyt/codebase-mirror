// graph-ui/src/components/ControlTab.tsx
// V2 ControlTab — system info, processes, logs.
// R17: now uses /api/processes, /api/logs, /api/index-status endpoints.
// R24: fixed setState-on-unmounted via cancelled flag + abort stale refresh.

import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "../api/client";
import type { ProcessInfo } from "../lib/types";
import { formatBytes } from "../lib/utils";

export function ControlTab() {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Array<{ id: string; status: string; error?: string; started_at: string; project: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [killError, setKillError] = useState<string | null>(null);
  // R24: track mounted state to prevent setState on unmounted components.
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [procRes, logRes, jobRes] = await Promise.all([
        api.getProcesses(),
        api.getLogs(50),
        api.getIndexStatus(),
      ]);
      // R24: only update state if still mounted.
      if (!mountedRef.current) return;
      setProcesses(procRes.processes ?? []);
      setLogs(logRes.lines ?? []);
      setJobs(jobRes.jobs ?? []);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : "Failed to fetch control data");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    // Auto-refresh every 10 seconds.
    const interval = setInterval(refresh, 10000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [refresh]);

  // R43 (M3): confirmation gate on process-kill. Killing a process is
  // irreversible — a misclick on the small Kill button shouldn't terminate
  // a long-running index job without consent.
  const handleKill = async (pid: number) => {
    if (!window.confirm(`Kill process ${pid}? This cannot be undone.`)) return;
    setKillError(null);
    try {
      await api.killProcess(pid);
      // Refresh after a short delay.
      setTimeout(refresh, 500);
    } catch (e) {
      setKillError(e instanceof Error ? e.message : "Failed to kill process");
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
          <button onClick={refresh} className="px-4 py-2 rounded-lg bg-white/[0.04] text-foreground/60 hover:bg-white/[0.08] text-sm">
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
        <button onClick={refresh} className="px-3 py-1.5 rounded-lg bg-white/[0.04] text-foreground/50 hover:bg-white/[0.08] text-[12px]">
          Refresh
        </button>
      </div>

      {killError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[12px] text-red-400">
          {killError}
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
                {!p.is_self && (
                  <button
                    onClick={() => handleKill(p.pid)}
                    className="px-2 py-0.5 rounded text-red-400/60 hover:bg-red-500/10 hover:text-red-400 text-[10px]"
                  >
                    Kill
                  </button>
                )}
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
