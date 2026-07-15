import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("./components/DashboardTab", () => ({
  DashboardTab: ({ project, active }: { project: string; active?: boolean }) => (
    <div data-testid="dashboard" data-project={project} data-active={String(active)} />
  ),
}));

vi.mock("./components/GraphTab", () => ({
  GraphTab: ({ project, active }: { project: string; active?: boolean }) => (
    <div data-testid="graph" data-project={project} data-active={String(active)} />
  ),
}));

vi.mock("./components/StatsTab", () => ({
  StatsTab: ({ onSelectProject }: { onSelectProject: (project: string) => void }) => (
    <div>
      <button onClick={() => onSelectProject("project-a")}>Open A</button>
      <button onClick={() => onSelectProject("project-b")}>Open B</button>
    </div>
  ),
}));

vi.mock("./components/ControlTab", () => ({
  ControlTab: () => <div data-testid="control" />,
}));

import { App } from "./App";

describe("App project-scoped warm panels", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/?tab=stats");
  });

  afterEach(() => cleanup());

  it("canonicalizes project-scoped deep links that omit the project", () => {
    window.history.replaceState(null, "", "/?tab=graph");
    render(<App />);

    expect(screen.getByRole("tab", { name: "Projects" })).toHaveAttribute("aria-selected", "true");
    expect(document.getElementById("tabpanel-stats")).not.toHaveAttribute("hidden");
    expect(document.getElementById("tabpanel-graph")).toHaveAttribute("hidden");
    expect(window.location.search).toBe("?tab=stats");
  });

  it("keeps one visited graph warm but never preloads it for a different project", async () => {
    window.history.replaceState(null, "", "/?tab=dashboard&project=project-a");
    render(<App />);

    expect(screen.getByTestId("dashboard")).toHaveAttribute("data-project", "project-a");
    expect(screen.getByTestId("dashboard")).toHaveAttribute("data-active", "true");
    expect(screen.queryByTestId("graph")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    await waitFor(() => expect(screen.getByTestId("graph")).toHaveAttribute("data-project", "project-a"));
    expect(screen.getByTestId("graph")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("dashboard")).toHaveAttribute("data-active", "false");

    fireEvent.click(screen.getByRole("tab", { name: "Dashboard" }));
    expect(screen.getByTestId("graph")).toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("dashboard")).toHaveAttribute("data-active", "true");

    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Open B" }));
    expect(screen.getByTestId("dashboard")).toHaveAttribute("data-project", "project-b");
    expect(screen.queryByTestId("graph")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    await waitFor(() => expect(screen.getByTestId("graph")).toHaveAttribute("data-project", "project-b"));
  });
});
