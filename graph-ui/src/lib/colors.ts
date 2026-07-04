// graph-ui/src/lib/colors.ts
// Color utilities for graph nodes — based on V1 but extended for V2 risk scores.

/** Label → color mapping (matches V1). */
const LABEL_COLORS: Record<string, string> = {
  Function: "#60a5fa",   // blue
  Method: "#818cf8",     // indigo
  Class: "#a78bfa",      // violet
  Interface: "#c084fc",  // purple
  Module: "#34d399",     // green
  File: "#6b7280",       // gray
  Folder: "#4b5563",     // dark gray
  Route: "#fbbf24",      // amber
  Package: "#f97316",    // orange
  Variable: "#94a3b8",   // slate
  Resource: "#ec4899",   // pink
  Channel: "#14b8a6",    // teal
  Type: "#a3e635",       // lime
  Enum: "#fde047",       // yellow
  Decorator: "#f472b6",  // light pink
  Section: "#67e8f9",    // cyan
};

/** Default color for unknown labels. */
const DEFAULT_COLOR = "#7dd3fc";

/** Get the color for a node label. */
export function colorForLabel(label: string): string {
  return LABEL_COLORS[label] ?? DEFAULT_COLOR;
}

/** Dead-code status → color mapping (matches V1). */
export function colorForStatus(status?: string): string {
  switch (status) {
    case "dead":
      return "#ef4444"; // red
    case "single":
      return "#f97316"; // orange
    case "entry":
      return "#34d399"; // green
    case "test":
      return "#a78bfa"; // violet
    case "exported":
      return "#60a5fa"; // blue
    case "structural":
      return "#6b7280"; // gray
    default:
      return "#7dd3fc"; // default
  }
}

/** V2: Risk score → color (heatmap). */
export function colorForRisk(score: number): string {
  if (score >= 0.7) return "#ef4444"; // red — HIGH
  if (score >= 0.4) return "#fbbf24"; // amber — MEDIUM
  return "#34d399"; // green — LOW
}

/** V2: Freshness label → color. */
export function colorForFreshness(label: string): string {
  switch (label) {
    case "FRESH":
      return "#34d399"; // green
    case "RECENT":
      return "#60a5fa"; // blue
    case "STALE":
      return "#fbbf24"; // amber
    case "OLD":
      return "#f97316"; // orange
    case "CRITICAL":
      return "#ef4444"; // red
    default:
      return "#6b7280"; // gray
  }
}

/** V2: Human memory note label → color. */
export function colorForHumanNote(label: string): string {
  switch (label) {
    case "ADR":
      return "#a78bfa"; // violet
    case "BugNote":
      return "#ef4444"; // red
    case "RefactorPlan":
      return "#fbbf24"; // amber
    case "Convention":
      return "#60a5fa"; // blue
    case "LegacyNote":
      return "#6b7280"; // gray
    case "RiskNote":
      return "#f97316"; // orange
    case "ModuleNote":
      return "#34d399"; // green
    case "RouteNote":
      return "#14b8a6"; // teal
    default:
      return "#7dd3fc"; // default
  }
}
