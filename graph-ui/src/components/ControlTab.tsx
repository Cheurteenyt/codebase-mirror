// graph-ui/src/components/ControlTab.tsx
// V2: Process management, logs, and system info.
// Simplified version of V1's ControlTab.

import { useEffect, useState } from "react";
import { api } from "../api/client";
import { cn } from "../lib/utils";

export function ControlTab() {
  const [logs, setLogs] = useState<string[]>([]);
  const [processes, setProcesses] = useState<Array<{ pid: number; cpu: number; rss_mb: number; command: string; is_self: boolean }>>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    api.getLogs(50).then((d) => setLogs(d.lines ?? [])).catch(() => {});
    api.getProcesses().then((d) => setProcesses(d.processes ?? [])).catch(() => {});
  }, [refreshKey]);

  return (
    <div className="h-full overflow-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold text-foreground/60 uppercase tracking-wider">
          System Control
        </h2>
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          className="px-3 py-1.5 rounded-lg bg-white/[0.04] text-foreground/50 hover:bg-white/[0.08] text-[12px]"
        >
          Refresh
        </button>
      </div>

      {/* Processes */}
      <div className="rounded-xl border border-border/30 bg-[#0b1920]/60 p-4">
        <h3 className="text-[12px] font-medium text-foreground/40 mb-3">Processes</h3>
        {processes.length === 0 ? (
          <p className="text-foreground/20 text-[12px]">No processes found</p>
        ) : (
          <div className="space-y-1">
            {processes.map((p) => (
              <div
                key={p.pid}
                className={cn(
                  "flex items-center gap-3 text-[11px] font-mono py-1",
                  p.is_self && "text-primary",
                )}
              >
                <span className="text-foreground/40 w-16">PID {p.pid}</span>
                <span className="text-foreground/30 w-12">{p.cpu.toFixed(1)}%</span>
                <span className="text-foreground/30 w-20">{p.rss_mb.toFixed(0)} MB</span>
                <span className="text-foreground/50 truncate">{p.command}</span>
                {!p.is_self && (
                  <button
                    onClick={() => api.killProcess(p.pid).then(() => setRefreshKey((k) => k + 1))}
                    className="ml-auto text-red-400/40 hover:text-red-400 text-[10px]"
                  >
                    Kill
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Logs */}
      <div className="rounded-xl border border-border/30 bg-[#0b1920]/60 p-4">
        <h3 className="text-[12px] font-medium text-foreground/40 mb-3">Recent Logs</h3>
        {logs.length === 0 ? (
          <p className="text-foreground/20 text-[12px]">No logs</p>
        ) : (
          <div className="font-mono text-[10px] text-foreground/40 space-y-0.5 max-h-64 overflow-auto">
            {logs.map((line, i) => (
              <div key={i} className="truncate">{line}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
