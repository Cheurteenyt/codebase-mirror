import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import type { GraphNode, GraphNodeSearchData } from "../lib/types";
import { api, ApiError } from "../api/client";

function makeNode(id: number, name: string, filePath: string): GraphNode {
  return {
    id,
    label: "Function",
    name,
    file_path: filePath,
    qualified_name: name,
    start_line: 1,
    end_line: 10,
    properties_json: "{}",
    risk_score: null,
    notes_count: 0,
    status: "active",
    color: "#5eead4",
  } as GraphNode;
}

function makeSearchPage(
  query: string,
  nodes: GraphNode[],
  graphRevision = "graph-reader-v1:aaaaaaaaaaaaaaaaaaaaaa",
): GraphNodeSearchData {
  return {
    contract_version: 1,
    exact: true,
    graph_revision: graphRevision,
    scope: "complete_project",
    query,
    match_strategy: "literal-relevance-v1",
    total_matches: nodes.length,
    returned_nodes: nodes.length,
    truncated: false,
    nodes,
    page: { limit: 50, returned: nodes.length, next_cursor: null },
  };
}

function treeItem(itemId: string): HTMLElement {
  const item = [...screen.getByRole("tree").querySelectorAll<HTMLElement>("[role=treeitem]")]
    .find((candidate) => candidate.dataset.treeItemId === itemId);
  if (!item) throw new Error(`Missing tree item ${itemId}`);
  return item;
}

function tabStops(): HTMLElement[] {
  return [...screen.getByRole("tree").querySelectorAll<HTMLElement>("[role=treeitem][tabindex='0']")];
}

afterEach(() => vi.restoreAllMocks());

describe("Sidebar tree construction", () => {
  it("renders without exploding on a deep single-child chain", () => {
    const node = makeNode(1, "file.ts", "src/a/b/c/d/e/file.ts");

    const { container } = render(
      <Sidebar nodes={[node]} onSelectPath={vi.fn()} onSelectNode={vi.fn()} selectedPath={null} />,
    );

    expect(container.children.length).toBeGreaterThan(0);
  });

  it("keeps deep single-child flattening linear", () => {
    const node = makeNode(1, "f.ts", `${"a/".repeat(20)}f.ts`);
    const start = Date.now();

    render(<Sidebar nodes={[node]} onSelectPath={vi.fn()} onSelectNode={vi.fn()} selectedPath={null} />);

    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("exposes root-level files as the same (root) architecture scope as the canvas", () => {
    const rootNode = makeNode(1, "README.md", "README.md");
    const onSelectPath = vi.fn();
    const onSelectNode = vi.fn();
    render(
      <Sidebar
        nodes={[rootNode, makeNode(2, "nested.ts", "src/nested.ts")]}
        onSelectPath={onSelectPath}
        onSelectNode={onSelectNode}
        selectedPath={null}
      />,
    );

    const root = screen.getByRole("treeitem", { name: "(root), 1 items" });
    fireEvent.click(screen.getByRole("button", { name: "Select (root)" }));
    expect(onSelectPath).toHaveBeenCalledWith("(root)", new Set([1]));

    fireEvent.click(screen.getByRole("button", { name: "Expand (root)" }));
    expect(screen.getByRole("treeitem", { name: "README.md, Function" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));
    expect(onSelectNode).toHaveBeenCalledWith(rootNode);
    expect(root).toHaveAttribute("aria-expanded", "true");
  });
});

describe("Sidebar ARIA tree keyboard navigation", () => {
  it("uses one roving tab stop and supports ArrowUp, ArrowDown, Home, and End", () => {
    render(
      <Sidebar
        nodes={[
          makeNode(1, "alpha.ts", "alpha/alpha.ts"),
          makeNode(2, "beta.ts", "beta/beta.ts"),
          makeNode(3, "gamma.ts", "gamma/gamma.ts"),
        ]}
        onSelectPath={vi.fn()}
        onSelectNode={vi.fn()}
        selectedPath={null}
      />,
    );

    const alpha = treeItem("directory:alpha");
    const beta = treeItem("directory:beta");
    const gamma = treeItem("directory:gamma");
    expect(tabStops()).toEqual([alpha]);

    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowDown" });
    expect(beta).toHaveFocus();
    expect(tabStops()).toEqual([beta]);

    fireEvent.keyDown(beta, { key: "End" });
    expect(gamma).toHaveFocus();
    fireEvent.keyDown(gamma, { key: "ArrowUp" });
    expect(beta).toHaveFocus();
    fireEvent.keyDown(beta, { key: "Home" });
    expect(alpha).toHaveFocus();
  });

  it("expands, enters children, returns to parents, and activates with Enter or Space", () => {
    const node = makeNode(1, "alpha.ts", "src/alpha.ts");
    const onSelectPath = vi.fn();
    const onSelectNode = vi.fn();
    render(
      <Sidebar
        nodes={[node]}
        onSelectPath={onSelectPath}
        onSelectNode={onSelectNode}
        selectedPath={null}
      />,
    );

    const src = treeItem("directory:src");
    src.focus();
    expect(src).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(src, { key: "Enter" });
    expect(onSelectPath).toHaveBeenCalledWith("src", new Set([1]));

    fireEvent.keyDown(src, { key: "ArrowRight" });
    expect(src).toHaveAttribute("aria-expanded", "true");
    const leaf = treeItem("node:1");
    expect(leaf).toHaveAttribute("role", "treeitem");

    fireEvent.keyDown(src, { key: "ArrowRight" });
    expect(leaf).toHaveFocus();
    fireEvent.keyDown(leaf, { key: " " });
    expect(onSelectNode).toHaveBeenCalledWith(node);

    fireEvent.keyDown(leaf, { key: "ArrowLeft" });
    expect(src).toHaveFocus();
    fireEvent.keyDown(src, { key: "ArrowLeft" });
    expect(src).toHaveAttribute("aria-expanded", "false");
    expect(tabStops()).toEqual([src]);
  });

  it("keeps expansion and selection as distinct pointer actions", () => {
    const node = makeNode(1, "alpha.ts", "src/alpha.ts");
    const onSelectPath = vi.fn();
    render(
      <Sidebar nodes={[node]} onSelectPath={onSelectPath} onSelectNode={vi.fn()} selectedPath={null} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand src" }));
    expect(treeItem("directory:src")).toHaveAttribute("aria-expanded", "true");
    expect(onSelectPath).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Select src" }));
    expect(onSelectPath).toHaveBeenCalledWith("src", new Set([1]));
    expect(treeItem("directory:src")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "Collapse src" }));
    expect(treeItem("directory:src")).toHaveAttribute("aria-expanded", "false");
  });

  it("exposes the selected state consistently on file leaves", () => {
    const node = makeNode(1, "alpha.ts", "src/alpha.ts");
    const view = render(
      <Sidebar
        nodes={[node]}
        onSelectPath={vi.fn()}
        onSelectNode={vi.fn()}
        selectedPath="src/alpha.ts"
        selectedNodeId={1}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand src" }));
    expect(treeItem("node:1")).toHaveAttribute("aria-selected", "true");

    view.rerender(
      <Sidebar
        nodes={[node]}
        onSelectPath={vi.fn()}
        onSelectNode={vi.fn()}
        selectedPath={null}
        selectedNodeId={null}
      />,
    );
    expect(treeItem("node:1")).toHaveAttribute("aria-selected", "false");
  });

  it("uses node identity so duplicate file paths expose exactly one selected treeitem", () => {
    const first = makeNode(1, "first", "src/shared.ts");
    const second = makeNode(2, "second", "src/shared.ts");
    render(
      <Sidebar
        nodes={[first, second]}
        onSelectPath={vi.fn()}
        onSelectNode={vi.fn()}
        selectedPath="src/shared.ts"
        selectedNodeId={2}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand src" }));
    expect(treeItem("directory:src")).toHaveAttribute("aria-selected", "false");
    expect(treeItem("node:1")).toHaveAttribute("aria-selected", "false");
    expect(treeItem("node:2")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tree").querySelectorAll('[role="treeitem"][aria-selected="true"]'))
      .toHaveLength(1);
  });

  it("preserves search navigation and does not steal focus when search is cleared", () => {
    const node = makeNode(1, "alpha.ts", "src/alpha.ts");
    const onSelectNode = vi.fn();
    render(
      <Sidebar nodes={[node]} onSelectPath={vi.fn()} onSelectNode={onSelectNode} selectedPath={null} />,
    );

    const search = screen.getByRole("textbox", { name: "Search paths or symbols" });
    search.focus();
    fireEvent.change(search, { target: { value: "alpha" } });
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open alpha.ts at src/alpha.ts" }));
    expect(onSelectNode).toHaveBeenCalledWith(node);

    search.focus();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("tree")).toBeInTheDocument();
    expect(tabStops()).toHaveLength(1);
    expect(search).toHaveFocus();
  });

  it("replaces overview matches with exact project-wide results", async () => {
    const overviewNode = makeNode(1, "visible.ts", "src/visible.ts");
    const exactNode = makeNode(99, "outside.ts", "hidden/outside.ts");
    vi.spyOn(api, "searchNodes").mockResolvedValue(makeSearchPage("outside", [exactNode]));
    const onSelectNode = vi.fn();
    render(
      <Sidebar
        project="test"
        nodes={[overviewNode]}
        onSelectPath={vi.fn()}
        onSelectNode={onSelectNode}
        selectedPath={null}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Search paths or symbols" }), {
      target: { value: "outside" },
    });

    await waitFor(() => expect(screen.getByText(/Exact search/u)).toBeInTheDocument());
    expect(screen.getByText(/1\/1 loaded/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open outside.ts at hidden/outside.ts" }));
    expect(onSelectNode).toHaveBeenCalledWith(exactNode);
  });

  it("promotes an exact path query to an actionable directory scope", async () => {
    const exactNode = makeNode(
      99,
      "benchUtil.ts",
      "packages\\bench\\benchUtil.ts",
    );
    vi.spyOn(api, "searchNodes").mockResolvedValue(
      makeSearchPage("packages/bench", [exactNode]),
    );
    const onSelectPath = vi.fn();
    render(
      <Sidebar
        project="test"
        nodes={[makeNode(1, "visible.ts", "src/visible.ts")]}
        onSelectPath={onSelectPath}
        onSelectNode={vi.fn()}
        selectedPath={null}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Search paths or symbols" }), {
      target: { value: "packages/bench" },
    });

    const openDirectory = await screen.findByRole("button", {
      name: /Open directory packages\/bench/u,
    });
    fireEvent.click(openDirectory);
    expect(onSelectPath).toHaveBeenCalledWith("packages/bench", new Set());
  });

  it("revalidates an active exact query when exactRefreshKey changes", async () => {
    const staleNode = makeNode(90, "outside-old.ts", "hidden/outside-old.ts");
    const freshNode = makeNode(91, "outside-new.ts", "hidden/outside-new.ts");
    const search = vi.spyOn(api, "searchNodes")
      .mockResolvedValueOnce(makeSearchPage("outside", [staleNode], "graph-reader-v1:old"))
      .mockResolvedValueOnce(makeSearchPage("outside", [freshNode], "graph-reader-v1:new"));
    const props = {
      project: "test",
      nodes: [makeNode(1, "visible.ts", "src/visible.ts")],
      onSelectPath: vi.fn(),
      onSelectNode: vi.fn(),
      selectedPath: null,
    };
    const view = render(<Sidebar {...props} exactRefreshKey={1} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search paths or symbols" }), {
      target: { value: "outside" },
    });
    await waitFor(() => expect(
      screen.getByRole("button", { name: "Open outside-old.ts at hidden/outside-old.ts" }),
    ).toBeInTheDocument());

    view.rerender(<Sidebar {...props} exactRefreshKey={2} />);

    await waitFor(() => expect(
      screen.getByRole("button", { name: "Open outside-new.ts at hidden/outside-new.ts" }),
    ).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Open outside-old.ts at hidden/outside-old.ts" }))
      .not.toBeInTheDocument();
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenLastCalledWith(
      "test",
      "outside",
      null,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("never renders or announces an exact page for another active query", async () => {
    const overviewNode = makeNode(1, "outside-local.ts", "src/outside-local.ts");
    const staleNode = makeNode(99, "stale-exact.ts", "hidden/stale-exact.ts");
    vi.spyOn(api, "searchNodes").mockResolvedValue(makeSearchPage("previous", [staleNode]));
    render(
      <Sidebar
        project="test"
        nodes={[overviewNode]}
        onSelectPath={vi.fn()}
        onSelectNode={vi.fn()}
        selectedPath={null}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Search paths or symbols" }), {
      target: { value: "outside" },
    });

    await waitFor(() => expect(screen.getByText(/Updating exact search/u))
      .toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Open outside-local.ts at src/outside-local.ts" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open stale-exact.ts at hidden/stale-exact.ts" }))
      .not.toBeInTheDocument();
    expect(screen.queryByText(/Exact search/u)).not.toBeInTheDocument();
  });

  it("does not claim there are no matches when complete-project search fails", async () => {
    vi.spyOn(api, "searchNodes").mockRejectedValue(new ApiError(503, "Search backend unavailable"));
    render(
      <Sidebar
        project="test"
        nodes={[makeNode(1, "visible.ts", "src/visible.ts")]}
        onSelectPath={vi.fn()}
        onSelectNode={vi.fn()}
        selectedPath={null}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Search paths or symbols" }), {
      target: { value: "outside" },
    });

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Search backend unavailable"));
    expect(screen.getByText(/Exact search failed; matches outside it are unknown/u))
      .toBeInTheDocument();
    expect(screen.queryByText(/^No matches$/u)).not.toBeInTheDocument();
  });
});
