// Minimal i18n module — returns English strings directly.
// V1 had a full i18n system with zh/en; V2 starts with English only.

export interface UiMessages {
  tabs: { graph: string; projects: string; control: string };
  graph: {
    selectedLabel: string;
    folders: string;
    search: string;
    clearSelection: string;
  };
  common: { noMatches: string; save: string; cancel: string; delete: string; saving: string };
  projects: {
    healthHealthy: string;
    healthMissing: string;
    healthCorrupt: string;
    healthChecking: string;
  };
  adr: { title: string; lastUpdated: string };
}

const MESSAGES: UiMessages = {
  tabs: { graph: "Graph", projects: "Projects", control: "Control" },
  graph: {
    selectedLabel: "Project",
    folders: "Structure",
    search: "Search paths or symbols…",
    clearSelection: "Clear selection",
  },
  common: { noMatches: "No matches", save: "Save", cancel: "Cancel", delete: "Delete", saving: "Saving…" },
  projects: {
    healthHealthy: "Healthy",
    healthMissing: "Missing",
    healthCorrupt: "Corrupt",
    healthChecking: "Checking…",
  },
  adr: { title: "Architecture Decision Record", lastUpdated: "Last updated" },
};

export function useUiMessages(): UiMessages {
  return MESSAGES;
}
