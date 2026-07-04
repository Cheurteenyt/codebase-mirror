// graph-ui/src/lib/utils.ts
// Shared utility functions for the V2 graph UI.

/** Conditionally join class names (replaces V1 clsx + tailwind-merge). */
export function cn(...classes: (string | false | undefined | null)[]): string {
  return classes.filter(Boolean).join(" ");
}

/** Format a number with locale-aware grouping. */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Format bytes as a human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Format an ISO timestamp as a relative time (e.g. "2h ago"). */
export function timeAgo(iso: string | null): string {
  if (!iso) return "unknown";
  const now = Date.now();
  const then = new Date(iso).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Format age in seconds as a human-readable string. */
export function formatAge(seconds: number | null): string {
  if (seconds == null) return "unknown";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Truncate a string to maxLen, adding ellipsis. */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen - 1) + "…";
}
