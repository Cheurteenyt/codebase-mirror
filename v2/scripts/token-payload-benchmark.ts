import { Buffer } from 'node:buffer';
import { CodeGraphReader, defaultCodeDbPath } from '../src/bridge/sqlite-ro.js';
import { HumanMemoryStore } from '../src/human/store.js';
import { GetModuleContextTool } from '../src/mcp/tools/get_module_context.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const project = option('--project') ?? 'codebase-mirror';
const requestedModule = option('--module');
const requestedMax = Number(option('--max-nodes') ?? 200);
const requestedMinimum = Number(option('--min-saving-pct') ?? 20);
const maxNodes = Number.isFinite(requestedMax)
  ? Math.max(0, Math.min(1000, Math.floor(requestedMax)))
  : 200;
const minimumSavingPct = Number.isFinite(requestedMinimum)
  ? Math.max(0, Math.min(100, requestedMinimum))
  : 20;

const codeReader = new CodeGraphReader(defaultCodeDbPath(project));
// The payload comparison does not need persisted notes. An in-memory store
// guarantees that a benchmark can never migrate or mutate a user's human DB.
const humanStore = HumanMemoryStore.openMemory();

try {
  const moduleName = requestedModule
    ?? codeReader.listNodesByLabelRanked(project, 'File', 1)[0]?.file_path;
  if (!moduleName) {
    throw new Error(`No File node is available for project "${project}".`);
  }

  const tool = new GetModuleContextTool({ project, codeReader, humanStore });
  const response = await tool.handle({
    module_name: moduleName,
    max_nodes: maxNodes,
  });
  if (response.isError) {
    throw new Error(response.content[0]?.text ?? 'get_module_context failed');
  }

  const compact = response.content[0]?.text ?? '';
  const parsed = JSON.parse(compact);
  const pretty = JSON.stringify(parsed, null, 2);
  const compactBytes = Buffer.byteLength(compact, 'utf8');
  const prettyBytes = Buffer.byteLength(pretty, 'utf8');
  const savedBytes = prettyBytes - compactBytes;
  const savedPct = prettyBytes === 0
    ? 0
    : Number(((savedBytes / prettyBytes) * 100).toFixed(1));

  process.stdout.write(`${JSON.stringify({
    measurement: 'json-whitespace-only',
    project,
    module: moduleName,
    max_nodes: maxNodes,
    neighbors_returned: parsed.code_stats?.neighbors_returned ?? 0,
    compact_bytes: compactBytes,
    pretty_bytes: prettyBytes,
    saved_bytes: savedBytes,
    compact_estimated_tokens: Math.ceil(compactBytes / 4),
    pretty_estimated_tokens: Math.ceil(prettyBytes / 4),
    saved_pct: savedPct,
    minimum_saving_pct: minimumSavingPct,
    passed: savedPct >= minimumSavingPct,
  })}\n`);
  if (savedPct < minimumSavingPct) {
    process.stderr.write(
      `Compact JSON whitespace saving ${savedPct}% is below the ${minimumSavingPct}% gate.\n`,
    );
    process.exitCode = 1;
  }
} finally {
  codeReader.close();
  humanStore.close();
}
