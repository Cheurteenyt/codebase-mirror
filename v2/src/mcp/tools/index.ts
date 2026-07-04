// v2/src/mcp/tools/index.ts
// Registry of V2 MCP tools.

import { McpServerOptions } from '../server.js';
import { GetProjectOverviewTool } from './get_project_overview.js';
import { GetModuleContextTool } from './get_module_context.js';
import { GetUndocumentedHotspotsTool } from './get_undocumented_hotspots.js';
import { CreateHumanNoteTool } from './create_human_note.js';
import { LinkNoteToCodeNodeTool } from './link_note_to_code_node.js';
import { SearchCodeAndMemoryTool } from './search_code_and_memory.js';

export interface ToolHandler {
  handle(args: Record<string, unknown>): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: new (opts: McpServerOptions) => ToolHandler;
}

export const TOOL_CLASSES: Array<new (opts: McpServerOptions) => ToolHandler & { definition: ToolDefinition }> = [
  GetProjectOverviewTool,
  GetModuleContextTool,
  GetUndocumentedHotspotsTool,
  CreateHumanNoteTool,
  LinkNoteToCodeNodeTool,
  SearchCodeAndMemoryTool,
];

export const ALL_TOOLS: ToolDefinition[] = TOOL_CLASSES.map((T) => new T({
  project: '', // placeholder — definitions don't depend on opts
  humanStore: null as any,
}).definition);
