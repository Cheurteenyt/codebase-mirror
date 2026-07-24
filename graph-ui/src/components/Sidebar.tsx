import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { GraphNode } from "../lib/types";
import { useUiMessages } from "../lib/i18n";
import { useExactNodeSearch } from "../hooks/useExactNodeSearch";

interface SidebarProps {
  project?: string | null;
  /** Invalidates an exact search after any project-graph revalidation event. */
  exactRefreshKey?: string | number;
  nodes: GraphNode[];
  onSelectPath: (path: string, nodeIds: Set<number>) => void;
  onSelectNode: (node: GraphNode) => void;
  selectedPath: string | null;
  /** Node identity is distinct from the file/directory navigation path. */
  selectedNodeId?: number | null;
}

interface DirNode {
  name: string;
  fullPath: string;
  children: Map<string, DirNode>;
  nodeIds: Set<number>;
  directNodes: GraphNode[];
}

function buildFileTree(nodes: GraphNode[]): DirNode {
  const root: DirNode = { name: "/", fullPath: "", children: new Map(), nodeIds: new Set(), directNodes: [] };
  for (const node of nodes) {
    if (!node.file_path) continue;
    const parts = node.file_path.split(/[\\/]/).filter(Boolean);
    const directoryDepth = node.label === "Folder" || node.label === "Directory"
      ? parts.length
      : Math.max(0, parts.length - 1);
    let current = root;
    for (let index = 0; index < directoryDepth; index++) {
      let child = current.children.get(parts[index]);
      if (!child) {
        const prefix = parts.slice(0, index + 1).join("/");
        child = { name: parts[index], fullPath: prefix, children: new Map(), nodeIds: new Set(), directNodes: [] };
        current.children.set(parts[index], child);
      }
      current = child;
    }
    current.directNodes.push(node);
  }

  function collect(directory: DirNode): Set<number> {
    const ids = new Set<number>();
    for (const node of directory.directNodes) ids.add(node.id);
    for (const child of directory.children.values()) {
      for (const id of collect(child)) ids.add(id);
    }
    directory.nodeIds = ids;
    return ids;
  }

  collect(root);
  return root;
}

function flattenSingleChild(dir: DirNode): DirNode {
  const children = new Map<string, DirNode>();
  for (const [key, child] of dir.children) {
    let flat = flattenSingleChild(child);
    // The child is already flattened. Reusing its children keeps deep paths O(n).
    // Keep top-level domains visible instead of folding them into their only child.
    while (dir.fullPath !== "" && flat.children.size === 1 && flat.directNodes.length === 0) {
      const [segment, descendant] = [...flat.children.entries()][0];
      flat = { ...descendant, name: `${flat.name}/${segment}`, children: descendant.children };
    }
    children.set(key, flat);
  }
  return { ...dir, children };
}

interface TreeKeyboardContext {
  itemId: string;
  parentItemId: string | null;
  expanded: boolean;
  hasChildren: boolean;
  firstChildItemId: string | null;
  onExpand: () => void;
  onCollapse: () => void;
  onActivate: () => void;
}

type TreeKeyboardHandler = (
  event: ReactKeyboardEvent<HTMLElement>,
  context: TreeKeyboardContext,
) => void;

function directoryItemId(path: string): string {
  return `directory:${path}`;
}

function graphNodeItemId(node: GraphNode): string {
  return `node:${node.id}`;
}

function findTreeItem(root: HTMLElement | null, itemId: string): HTMLElement | null {
  if (!root) return null;
  return [...root.querySelectorAll<HTMLElement>("[role=treeitem]")]
    .find((item) => item.dataset.treeItemId === itemId) ?? null;
}

interface SharedTreeItemProps {
  depth: number;
  parentItemId: string | null;
  focusedItemId: string | null;
  onFocusItem: (itemId: string) => void;
  onTreeKeyDown: TreeKeyboardHandler;
}

function NodeTreeItem({
  node,
  depth,
  parentItemId,
  focusedItemId,
  onFocusItem,
  onTreeKeyDown,
  onSelectNode,
  selectedNodeId,
}: SharedTreeItemProps & {
  node: GraphNode;
  onSelectNode: (node: GraphNode) => void;
  selectedNodeId: number | null;
}) {
  const itemId = graphNodeItemId(node);
  const activate = () => onSelectNode(node);
  const isSelected = selectedNodeId === node.id;

  return (
    <div
      role="treeitem"
      aria-label={`${node.name}, ${node.label}`}
      aria-selected={isSelected}
      aria-level={depth + 1}
      data-tree-item-id={itemId}
      tabIndex={focusedItemId === itemId ? 0 : -1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocusItem(itemId);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        onTreeKeyDown(event, {
          itemId,
          parentItemId,
          expanded: false,
          hasChildren: false,
          firstChildItemId: null,
          onExpand: () => {},
          onCollapse: () => {},
          onActivate: activate,
        });
      }}
      className="group/tree-node focus:outline-none"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Open ${node.name}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onFocusItem(itemId);
          activate();
        }}
        className="flex min-h-9 w-full items-center gap-2 px-3 text-left text-[12px] text-foreground/65 transition-colors hover:bg-white/[0.05] hover:text-foreground/90 group-focus-visible/tree-node:bg-cyan-400/[0.07] group-focus-visible/tree-node:text-foreground group-focus-visible/tree-node:ring-2 group-focus-visible/tree-node:ring-inset group-focus-visible/tree-node:ring-cyan-400/70 focus:outline-none"
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: node.color }} />
        <span className="truncate font-mono">{node.name}</span>
        <span className="ml-auto shrink-0 text-[10px] text-foreground/40">{node.label}</span>
      </button>
    </div>
  );
}

function TreeItem({
  dir,
  depth,
  parentItemId,
  focusedItemId,
  expandedPaths,
  onFocusItem,
  onSetExpanded,
  onTreeKeyDown,
  onSelect,
  onSelectNode,
  selectedPath,
  selectedNodeId,
}: SharedTreeItemProps & {
  dir: DirNode;
  expandedPaths: ReadonlySet<string>;
  onSetExpanded: (path: string, expanded: boolean, itemId: string) => void;
  onSelect: (path: string, ids: Set<number>) => void;
  onSelectNode: (node: GraphNode) => void;
  selectedPath: string | null;
  selectedNodeId: number | null;
}) {
  const itemId = directoryItemId(dir.fullPath);
  const hasChildren = dir.children.size > 0 || dir.directNodes.length > 0;
  const expanded = hasChildren && expandedPaths.has(dir.fullPath);
  const isSelected = selectedNodeId == null && selectedPath === dir.fullPath;
  const sorted = useMemo(
    () => [...dir.children.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [dir.children],
  );
  const sortedNodes = useMemo(
    () => [...dir.directNodes].sort((a, b) => a.name.localeCompare(b.name)),
    [dir.directNodes],
  );
  const firstChildItemId = sorted[0]
    ? directoryItemId(sorted[0].fullPath)
    : sortedNodes[0]
      ? graphNodeItemId(sortedNodes[0])
      : null;
  const activate = () => onSelect(dir.fullPath, dir.nodeIds);

  return (
    <div
      role="treeitem"
      aria-label={`${dir.name}, ${dir.nodeIds.size} items`}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={isSelected}
      aria-level={depth + 1}
      data-tree-item-id={itemId}
      tabIndex={focusedItemId === itemId ? 0 : -1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocusItem(itemId);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        onTreeKeyDown(event, {
          itemId,
          parentItemId,
          expanded,
          hasChildren,
          firstChildItemId,
          onExpand: () => onSetExpanded(dir.fullPath, true, itemId),
          onCollapse: () => onSetExpanded(dir.fullPath, false, itemId),
          onActivate: activate,
        });
      }}
      className="group/tree-item focus:outline-none"
    >
      <div
        className={`flex min-h-10 w-full items-center gap-1.5 px-3 text-left text-[12px] transition-colors group-focus-visible/tree-item:ring-2 group-focus-visible/tree-item:ring-inset group-focus-visible/tree-item:ring-cyan-400/70 ${
          isSelected
            ? "bg-primary/[0.12] text-primary"
            : "text-foreground/70 hover:bg-white/[0.05] hover:text-foreground/95 group-focus-visible/tree-item:bg-cyan-400/[0.07]"
        }`}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onFocusItem(itemId);
            onSetExpanded(dir.fullPath, !expanded, itemId);
          }}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${dir.fullPath || dir.name}`}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-foreground/55 hover:bg-white/[0.08] hover:text-foreground/90 focus:outline-none"
          disabled={!hasChildren}
        >
          <span className="w-3 shrink-0 text-center text-[11px]">
            {hasChildren ? (expanded ? "▾" : "▸") : ""}
          </span>
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Select ${dir.fullPath || dir.name}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onFocusItem(itemId);
            activate();
          }}
          aria-current={isSelected ? "page" : undefined}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left focus:outline-none"
        >
          <span className="truncate font-medium">{dir.name}</span>
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-foreground/45">{dir.nodeIds.size}</span>
        </button>
      </div>
      {expanded && (
        <div role="group">
          {sorted.map((child) => (
            <TreeItem
              key={child.fullPath}
              dir={child}
              depth={depth + 1}
              parentItemId={itemId}
              focusedItemId={focusedItemId}
              expandedPaths={expandedPaths}
              onFocusItem={onFocusItem}
              onSetExpanded={onSetExpanded}
              onTreeKeyDown={onTreeKeyDown}
              onSelect={onSelect}
              onSelectNode={onSelectNode}
              selectedPath={selectedPath}
              selectedNodeId={selectedNodeId}
            />
          ))}
          {sortedNodes.map((node) => (
            <NodeTreeItem
              key={node.id}
              node={node}
              depth={depth + 1}
              parentItemId={itemId}
              focusedItemId={focusedItemId}
              onFocusItem={onFocusItem}
              onTreeKeyDown={onTreeKeyDown}
              onSelectNode={onSelectNode}
              selectedNodeId={selectedNodeId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar({
  project = null,
  exactRefreshKey,
  nodes,
  onSelectPath,
  onSelectNode,
  selectedPath,
  selectedNodeId = null,
}: SidebarProps) {
  const t = useUiMessages();
  const [search, setSearch] = useState("");
  const exactSearch = useExactNodeSearch(project, search, 180, exactRefreshKey);
  const tree = useMemo(() => flattenSingleChild(buildFileTree(nodes)), [nodes]);

  const filtered = useMemo(() => {
    if (!search) return null;
    const query = search.toLowerCase();
    return nodes
      .filter((node) => node.name.toLowerCase().includes(query) || (node.file_path ?? "").toLowerCase().includes(query))
      .slice(0, 50);
  }, [nodes, search]);
  const activeSearchQuery = search.trim();
  const exactData = exactSearch.data?.query === activeSearchQuery
    ? exactSearch.data
    : null;
  const searchResults = exactData?.nodes ?? filtered;
  const staleExactDataIgnored = exactSearch.data != null && exactData == null;
  const exactSearchPending = exactSearch.loading || staleExactDataIgnored;
  const completeSearchFailed = exactSearch.error != null
    && exactData == null
    && (filtered?.length ?? 0) === 0;
  const exactDirectoryKey = useMemo(() => {
    if (!exactData) return null;
    const key = activeSearchQuery.replaceAll("\\", "/")
      .replace(/^\.\/+|\/+$/gu, "");
    if (!key.includes("/")) return null;
    const prefix = `${key}/`;
    return exactData.nodes.some((node) => (
      node.file_path?.replaceAll("\\", "/").startsWith(prefix)
    )) ? key : null;
  }, [activeSearchQuery, exactData]);

  const topLevel = useMemo(() => {
    const directories = [...tree.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (tree.directNodes.length === 0) return directories;
    // Root-level files are a real architecture domain in /api/layout. They
    // used to disappear because only root.children were rendered, making the
    // Sidebar disagree with the canvas and its exact domain count.
    const rootScope: DirNode = {
      name: "(root)",
      fullPath: "(root)",
      children: new Map(),
      nodeIds: new Set(tree.directNodes.map((node) => node.id)),
      directNodes: tree.directNodes,
    };
    return [rootScope, ...directories];
  }, [tree]);
  const treeRef = useRef<HTMLDivElement>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [focusedItemId, setFocusedItemId] = useState<string | null>(() => (
    topLevel[0] ? directoryItemId(topLevel[0].fullPath) : null
  ));

  const focusTreeItem = useCallback((itemId: string) => {
    setFocusedItemId(itemId);
    findTreeItem(treeRef.current, itemId)?.focus();
  }, []);

  const setDirectoryExpanded = useCallback((path: string, expanded: boolean, itemId: string) => {
    if (!expanded && focusedItemId && focusedItemId !== itemId) {
      const directoryElement = findTreeItem(treeRef.current, itemId);
      const focusedElement = findTreeItem(treeRef.current, focusedItemId);
      if (directoryElement && focusedElement && directoryElement.contains(focusedElement)) {
        focusTreeItem(itemId);
      }
    }

    setExpandedPaths((current) => {
      if (current.has(path) === expanded) return current;
      const next = new Set(current);
      if (expanded) next.add(path);
      else next.delete(path);
      return next;
    });
  }, [focusTreeItem, focusedItemId]);

  const handleTreeKeyDown = useCallback<TreeKeyboardHandler>((event, context) => {
    const handledKeys = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", " ", "Spacebar"];
    if (!handledKeys.includes(event.key)) return;

    event.preventDefault();
    event.stopPropagation();

    const visibleItems = treeRef.current
      ? [...treeRef.current.querySelectorAll<HTMLElement>("[role=treeitem]")]
      : [];
    const currentIndex = visibleItems.findIndex((item) => item.dataset.treeItemId === context.itemId);

    if (event.key === "ArrowDown" && currentIndex >= 0) {
      const nextId = visibleItems[Math.min(currentIndex + 1, visibleItems.length - 1)]?.dataset.treeItemId;
      if (nextId) focusTreeItem(nextId);
      return;
    }
    if (event.key === "ArrowUp" && currentIndex >= 0) {
      const previousId = visibleItems[Math.max(currentIndex - 1, 0)]?.dataset.treeItemId;
      if (previousId) focusTreeItem(previousId);
      return;
    }
    if (event.key === "Home") {
      const firstId = visibleItems[0]?.dataset.treeItemId;
      if (firstId) focusTreeItem(firstId);
      return;
    }
    if (event.key === "End") {
      const lastId = visibleItems.at(-1)?.dataset.treeItemId;
      if (lastId) focusTreeItem(lastId);
      return;
    }
    if (event.key === "ArrowRight") {
      if (context.hasChildren && !context.expanded) context.onExpand();
      else if (context.expanded && context.firstChildItemId) focusTreeItem(context.firstChildItemId);
      return;
    }
    if (event.key === "ArrowLeft") {
      if (context.hasChildren && context.expanded) context.onCollapse();
      else if (context.parentItemId) focusTreeItem(context.parentItemId);
      return;
    }

    context.onActivate();
  }, [focusTreeItem]);

  useEffect(() => {
    if (filtered !== null) return;
    setFocusedItemId((current) => {
      if (current && findTreeItem(treeRef.current, current)) return current;
      return topLevel[0] ? directoryItemId(topLevel[0].fullPath) : null;
    });
  }, [filtered, topLevel]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-4 pb-2 pt-3">
        <span className="text-[11px] font-medium uppercase tracking-widest text-foreground/55">
          {t.graph.folders}
        </span>
      </div>
      <div className="shrink-0 border-b border-border/30 px-3 pb-2.5">
        <input
          aria-label="Search paths or symbols"
          placeholder={t.graph.search}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="w-full rounded-lg border border-white/[0.09] bg-white/[0.05] px-3 py-2 text-[12px] text-foreground outline-none transition-all placeholder:text-foreground/35 focus:border-cyan-400/50 focus:bg-white/[0.07] focus:ring-2 focus:ring-cyan-400/20"
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div
          ref={treeRef}
          className="py-1"
          role={searchResults !== null ? undefined : "tree"}
          aria-label={searchResults !== null ? undefined : "Structure tree"}
        >
          {searchResults !== null ? (
            <>
              <div
                role="status"
                aria-live="polite"
                className="border-b border-white/[0.06] px-4 py-2 text-[10px] leading-relaxed"
              >
                {exactData ? (
                  <span className="text-emerald-100/70">
                    Exact search · {exactData.nodes.length.toLocaleString()}/
                    {exactData.total_matches.toLocaleString()} loaded
                  </span>
                ) : staleExactDataIgnored ? (
                  <span className="text-sky-100/65">
                    Updating exact search · {(filtered?.length ?? 0).toLocaleString()} overview matches
                  </span>
                ) : exactSearch.loading ? (
                  <span className="text-sky-100/65">
                    Searching project… · {(filtered?.length ?? 0).toLocaleString()} overview matches
                  </span>
                ) : (
                  <span className="text-amber-100/60">
                    Overview only · exact search unavailable
                  </span>
                )}
              </div>
              {exactDirectoryKey && (
                <button
                  onClick={() => onSelectPath(exactDirectoryKey, new Set())}
                  className="mx-3 my-2 min-h-10 w-[calc(100%-1.5rem)] rounded-lg border border-sky-300/20 bg-sky-300/[0.06] px-3 text-[11px] font-medium text-sky-100/75 hover:bg-sky-300/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-200/50"
                >
                  Open directory {exactDirectoryKey}
                </button>
              )}
              {exactSearch.error && (
                <div
                  role="alert"
                  className="mx-3 my-2 rounded-lg border border-amber-300/15 bg-amber-200/[0.04] p-2 text-[10px] leading-relaxed text-amber-100/70"
                >
                  <p>Exact search failed: {exactSearch.error}</p>
                  <button
                    type="button"
                    onClick={exactSearch.retry}
                    className="mt-1 min-h-9 rounded-md border border-amber-200/20 px-2 font-medium text-amber-50 hover:bg-amber-200/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/50"
                  >
                    {exactSearch.errorPhase === "more" ? "Retry page" : "Retry search"}
                  </button>
                </div>
              )}
              {searchResults.length === 0 && !exactSearchPending ? (
                <p className="px-4 py-6 text-center text-[12px] text-foreground/40">
                  {completeSearchFailed
                    ? "No overview match. Exact search failed; matches outside it are unknown."
                    : t.common.noMatches}
                </p>
              ) : (
                searchResults.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    aria-label={"Open " + node.name + (node.file_path ? " at " + node.file_path : "")}
                    onClick={() => onSelectNode(node)}
                    className="flex min-h-10 w-full items-center gap-2 px-4 text-left text-[12px] transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400/70"
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: node.color }} />
                    <span className="truncate text-foreground/80">{node.name}</span>
                    <span className="ml-auto max-w-[110px] shrink truncate font-mono text-[10px] text-foreground/45">{node.file_path}</span>
                  </button>
                ))
              )}
              {exactData?.page.next_cursor && exactSearch.errorPhase !== "more" && (
                <button
                  type="button"
                  onClick={exactSearch.loadMore}
                  disabled={exactSearch.loadingMore}
                  aria-busy={exactSearch.loadingMore}
                  className="mx-3 my-2 min-h-10 w-[calc(100%-1.5rem)] rounded-lg border border-sky-300/20 bg-sky-300/[0.06] px-3 text-[11px] font-medium text-sky-100/75 hover:bg-sky-300/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-200/50 disabled:cursor-wait disabled:opacity-50"
                >
                  {exactSearch.loadingMore ? "Loading more…" : "Load more"}
                </button>
              )}
            </>
          ) : (
            topLevel.map((child) => (
              <TreeItem
                key={child.fullPath}
                dir={child}
                depth={0}
                parentItemId={null}
                focusedItemId={focusedItemId}
                expandedPaths={expandedPaths}
                onFocusItem={focusTreeItem}
                onSetExpanded={setDirectoryExpanded}
                onTreeKeyDown={handleTreeKeyDown}
                onSelect={onSelectPath}
                onSelectNode={onSelectNode}
                selectedPath={selectedPath}
                selectedNodeId={selectedNodeId}
              />
            ))
          )}
        </div>
      </ScrollArea>

      {selectedPath && (
        <div className="border-t border-border/30 px-3 py-2">
          <button
            type="button"
            onClick={() => onSelectPath("", new Set())}
            className="min-h-9 w-full rounded-lg bg-white/[0.05] px-3 py-1.5 text-[11px] font-medium text-foreground/60 transition-all hover:bg-white/[0.09] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
          >
            {t.graph.clearSelection}
          </button>
        </div>
      )}
    </div>
  );
}
