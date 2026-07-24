import { useCallback, useMemo } from "react";
import { api } from "../api/client";
import type { GraphScopeData, GraphScopeKind } from "../lib/types";
import { useRevisionBoundPages } from "./useRevisionBoundPages";

type RefreshKey = string | number | null | undefined;

export function useExactScope(
  project: string | null,
  kind: GraphScopeKind,
  key: string,
  enabled: boolean,
  refreshKey?: RefreshKey,
) {
  const identity = JSON.stringify([project, kind, key, refreshKey]);
  const fetchPage = useCallback((cursor: string | null, signal: AbortSignal) => (
    api.getScope(project!, kind, key, cursor, { signal })
  ), [key, kind, project]);
  const validatePage = useCallback((page: GraphScopeData, first: GraphScopeData | null) => {
    if (page.scope.kind !== kind || page.scope.key !== key) return "Exact scope response mismatch";
    if (first && (
      page.scope.total_nodes !== first.scope.total_nodes
      || page.scope.total_internal_edges !== first.scope.total_internal_edges
      || page.boundary.total_relations !== first.boundary.total_relations
    )) return "Exact scope totals changed within one graph revision";
    return null;
  }, [key, kind]);
  const state = useRevisionBoundPages({
    identity,
    enabled: enabled && project != null,
    fetchPage,
    validatePage,
    initialError: "Unable to load exact scope",
    moreError: "Unable to load more",
  });
  const data = useMemo(() => {
    const first = state.pages[0];
    const last = state.pages.at(-1);
    if (!first || !last) return null;
    const nodes = new Map<number, GraphScopeData["nodes"][number]>();
    const edges = new Map<number, GraphScopeData["edges"][number]>();
    for (const page of state.pages) {
      for (const node of page.nodes) nodes.set(node.id, node);
      for (const edge of page.edges) edges.set(edge.id, edge);
    }
    return {
      ...first,
      nodes: [...nodes.values()].sort((left, right) => left.id - right.id),
      edges: [...edges.values()].sort((left, right) => left.id - right.id),
      complete: last.complete,
      page: {
        ...first.page,
        returned_nodes: nodes.size,
        returned_edges: edges.size,
        next_cursor: last.page.next_cursor,
      },
    } satisfies GraphScopeData;
  }, [state.pages]);
  return { ...state, data };
}
