// V2 ControlTab — simplified. V2 server doesn't implement /api/processes or /api/logs yet.
// Shows system info and a note about future features.

export function ControlTab() {
  return (
    <div className="h-full overflow-auto p-6 space-y-4">
      <h2 className="text-[14px] font-semibold text-foreground/60 uppercase tracking-wider">
        System Control
      </h2>
      <div className="rounded-xl border border-border/30 bg-[#0b1920]/60 p-4">
        <h3 className="text-[12px] font-medium text-foreground/40 mb-3">Server Status</h3>
        <div className="space-y-2 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400" />
            <span className="text-foreground/60">V2 UI Server running</span>
          </div>
          <p className="text-foreground/30 text-[11px] mt-2">
            Process management and log viewing will be available in a future version.
          </p>
        </div>
      </div>
    </div>
  );
}
