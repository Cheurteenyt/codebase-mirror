export type GraphKeyboardTraversalAction = 'complete' | 'zoom' | 'retry';

const DEPENDENCY_ATLAS_ZOOM_PROMPT = 'Open a domain or zoom in for symbols.';

export interface GraphBrowserSmokeOptions {
  baseUrl: string;
  project: string;
  timeoutMs: number;
  viewportWidth: number;
  viewportHeight: number;
  browserExecutable?: string;
}

export const GRAPH_BROWSER_SMOKE_USAGE =
  'Usage: npm run smoke:graph-ui:browser -- --project <name> '
  + '[--base-url http://127.0.0.1:9749] [--timeout-ms 30000] '
  + '[--viewport-width 1440] [--viewport-height 960] '
  + '[--browser-executable <path>]';

function option(argv: readonly string[], name: string, fallback?: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

function boundedInteger(
  argv: readonly string[],
  name: string,
  fallback: string,
  minimum: number,
  maximum: number,
): number {
  const value = Number(option(argv, name, fallback));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function parseGraphBrowserSmokeOptions(
  argv: readonly string[],
): GraphBrowserSmokeOptions {
  const project = option(argv, 'project');
  if (!project) throw new Error(GRAPH_BROWSER_SMOKE_USAGE);
  const baseUrl = new URL(option(argv, 'base-url', 'http://127.0.0.1:9749')!);
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error(`Unsupported Graph UI URL: ${baseUrl.toString()}`);
  }
  const timeoutMs = boundedInteger(argv, 'timeout-ms', '30000', 5000, 120000);
  return {
    baseUrl: baseUrl.toString().replace(/\/$/u, ''),
    project,
    timeoutMs,
    viewportWidth: boundedInteger(argv, 'viewport-width', '1440', 360, 3840),
    viewportHeight: boundedInteger(argv, 'viewport-height', '960', 640, 2160),
    browserExecutable: option(argv, 'browser-executable'),
  };
}

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
