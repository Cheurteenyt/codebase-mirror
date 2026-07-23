export type GraphKeyboardTraversalAction = 'complete' | 'zoom' | 'retry';

const DEPENDENCY_ATLAS_ZOOM_PROMPT = 'Open a domain or zoom in for symbols.';

/**
 * Keep the packaged browser smoke aligned with the public dependency-atlas
 * contract. At macro scale `N` intentionally has no symbol target; the smoke
 * must zoom through semantic disclosure before it can require node traversal.
 */
export function graphKeyboardTraversalAction(
  announcement: string,
): GraphKeyboardTraversalAction {
  if (/^Node\b/u.test(announcement)) return 'complete';
  if (announcement === DEPENDENCY_ATLAS_ZOOM_PROMPT) return 'zoom';
  return 'retry';
}
