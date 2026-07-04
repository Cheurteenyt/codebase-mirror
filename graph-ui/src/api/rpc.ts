// RPC client stub — V2 uses REST API (api/client.ts) instead of JSON-RPC.
// This file exists for backwards compatibility with V1 components (NodeDetailPanel).
// The get_code_snippet feature is disabled in V2 (return empty on call).

export class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
    this.name = "RpcError";
  }
}

export async function callTool<T = unknown>(
  _name: string,
  _args: Record<string, unknown> = {},
): Promise<T> {
  // V2 doesn't expose MCP tools over HTTP yet.
  // Return empty result to avoid crashes in V1 components.
  throw new RpcError(-32601, "RPC not available in V2 — use REST API instead");
}
