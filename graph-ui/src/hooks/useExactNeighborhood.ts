import { useCallback, useMemo } from "react";
import { api } from "../api/client";
import type { GraphNeighborhoodData } from "../lib/types";
import { useRevisionBoundPages } from "./useRevisionBoundPages";

type RefreshKey = string | number | null | undefined;

export function useExactNeighborhood(
  project: string | null,
  nodeId: number,
  enabled: boolean,
  refreshKey?: RefreshKey,
) {
  const identity = JSON.stringify([project, nodeId, refreshKey]);
  const fetchPage = useCallback((cursor: string | null, signal: AbortSignal) => (
    api.getNeighborhood(project!, nodeId, cursor, { signal })
  ), [nodeId, project]);
  const validatePage = useCallback((page: GraphNeighborhoodData) => (
    page.anchor.id === nodeId
      ? null
      : "Exact neighborhood response did not match the selected node"
  ), [nodeId]);
  const state = useRevisionBoundPages({
    identity,
    enabled: enabled && project != null,
    fetchPage,
    validatePage,
    initialError: "Unable to load exact connections",
    moreError: "Unable to load more connections",
  });
  const data = useMemo(() => {
    const first = state.pages[0];
    const last = state.pages.at(-1);
    if (!first || !last) return null;
    const nodes = new Map<number, GraphNeighborhoodData["nodes"][number]>();
    const edges = new Map<number, GraphNeighborhoodData["edges"][number]>();
    for (const page of state.pages) {
      for (const node of page.nodes) nodes.set(node.id, node);
      for (const edge of page.edges) edges.set(edge.id, edge);
    }
    return {
      ...first,
      nodes: [...nodes.values()].sort((left, right) => left.id - right.id),
      edges: [...edges.values()].sort((left, right) => left.id - right.id),
      page: {
        limit: first.page.limit,
        returned: edges.size,
        next_cursor: last.page.next_cursor,
      },
    } satisfies GraphNeighborhoodData;
  }, [state.pages]);
  return { ...state, data };
}
