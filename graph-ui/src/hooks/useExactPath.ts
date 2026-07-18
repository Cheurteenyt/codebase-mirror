import { useCallback } from "react";
import { api } from "../api/client";
import type { GraphPathData } from "../lib/types";
import { useRevisionBoundPages } from "./useRevisionBoundPages";

type PathPage = GraphPathData & { page: { next_cursor: null } };

function validatePath(page: GraphPathData, sourceId: number, targetId: number): string | null {
  const invalid = "Exact path response is invalid for the selected symbols";
  if (page.source_id !== sourceId || page.target_id !== targetId) {
    return invalid;
  }
  if (page.status !== "found") {
    return page.hops == null && page.nodes.length === 0 && page.edges.length === 0
      ? null
      : invalid;
  }
  if (page.hops !== page.edges.length
    || page.nodes.length !== page.edges.length + 1
    || page.nodes[0]?.id !== sourceId
    || page.nodes.at(-1)?.id !== targetId) {
    return invalid;
  }
  for (let index = 0; index < page.edges.length; index += 1) {
    const edge = page.edges[index];
    const left = page.nodes[index]?.id;
    const right = page.nodes[index + 1]?.id;
    if (!edge || !((edge.source === left && edge.target === right)
      || (edge.source === right && edge.target === left))) {
      return invalid;
    }
  }
  return null;
}

export function useExactPath(
  project: string | null,
  sourceId: number,
  targetId: number,
  enabled: boolean,
  refreshKey?: string | number | null,
) {
  const identity = JSON.stringify([project, sourceId, targetId, refreshKey]);
  const fetchPage = useCallback(async (_cursor: string | null, signal: AbortSignal): Promise<PathPage> => ({
    ...await api.getPath(project!, sourceId, targetId, { signal }),
    page: { next_cursor: null },
  }), [project, sourceId, targetId]);
  const validatePage = useCallback(
    (page: PathPage) => validatePath(page, sourceId, targetId),
    [sourceId, targetId],
  );
  const state = useRevisionBoundPages({
    identity,
    enabled: enabled && project != null,
    fetchPage,
    validatePage,
    initialError: "Unable to explain this connection",
    moreError: "Unable to explain this connection",
  });
  return { ...state, data: state.pages[0] ?? null };
}
