// graph-ui/src/components/ProjectCard.test.tsx
// R46 (F6): regression test for the corrupt-state disable gate.
// When project.status === "corrupt", the Open project button must be disabled
// and clicking it must NOT call onSelect.

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { ProjectCard } from "./ProjectCard";
import type { Project } from "../lib/types";

const base: Project = {
  name: "demo",
  root_path: "/x",
  indexed_at: new Date().toISOString(),
  node_count: 10,
  edge_count: 20,
  status: "healthy",
};

describe("ProjectCard corrupt-state gate", () => {
  it("disables Open project button and shows warning when status is 'corrupt'", () => {
    const onSelect = vi.fn();
    const { getByRole, getByText } = render(
      <ProjectCard project={{ ...base, status: "corrupt" }} onSelect={onSelect} />,
    );
    const btn = getByRole("button", { name: "Open project" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(getByText(/corrupt/i)).toBeTruthy();
    fireEvent.click(btn);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("calls onSelect when status is healthy", () => {
    const onSelect = vi.fn();
    const { getByRole } = render(
      <ProjectCard project={base} onSelect={onSelect} />,
    );
    fireEvent.click(getByRole("button", { name: "Open project" }));
    expect(onSelect).toHaveBeenCalledWith("demo");
  });
});
