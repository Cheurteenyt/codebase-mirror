import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { isAbsolute, posix, win32 } from 'node:path';
import { BaseTool } from './base.js';
import type { ToolDefinition } from './index.js';
import {
  assertPathInsideRoot,
  isPathInside,
  safeRealpathStrict,
} from '../../utils/safe-path.js';
import type { CodeNode } from '../../bridge/sqlite-ro.js';

const MAX_QUERIES = 10;
const MAX_QUERY_LENGTH = 256;
const DEFAULT_RESULTS_PER_QUERY = 20;
const MAX_RESULTS_PER_QUERY = 50;
const MAX_INDEXED_FILES = 20_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_TEXT_LENGTH = 500;
const MAX_CALLERS = 1000;
const DEFAULT_CALLERS = 200;
const MAX_TRACKED_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TOP_LEVEL_DIRECTORIES = 1024;
const MAX_CHAIN_HOPS = 8;
const DEFAULT_CHAIN_HOPS = 6;
const MAX_CHAIN_PATHS = 5;
const MAX_CHAIN_EXPANSIONS = 500;
const MAX_CHAIN_SYMBOLS_PER_NODE = 128;
const OPERATIONS = ['literal_matches', 'direct_callers', 'top_level_directories', 'call_chain'] as const;
type SourceOperation = typeof OPERATIONS[number];

const CALLABLE_LABELS = new Set(['Function', 'Method', 'Route', 'Constructor']);
const COMMON_CALL_NAMES = new Set([
  'add', 'all', 'catch', 'command', 'create', 'filter', 'finally', 'flatMap',
  'forEach', 'get', 'has', 'includes', 'indexOf', 'isFinite', 'join', 'map',
  'max', 'min', 'pop', 'push', 'reduce', 'replace', 'round', 'set', 'shift',
  'slice', 'sort', 'split', 'sqrt', 'stringify', 'then', 'toLocaleString',
  'toString', 'trim', 'unshift', 'values',
]);

interface SourceMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  text_truncated?: true;
}

interface QueryResult {
  query: string;
  matches: SourceMatch[];
  matches_truncated: boolean;
}

interface IncompleteReasons {
  unsafe_paths?: number;
  unreadable_files?: number;
  non_file_paths?: number;
  oversized_files?: number;
  binary_files?: number;
  indexed_file_limit?: number;
  byte_budget?: number;
}

function stablePathCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface ChainEntryMatch extends SourceMatch {
  query: string;
}

interface ChainStart {
  node: CodeNode;
  kind: 'referenced' | 'enclosing';
  entry: ChainEntryMatch;
}

interface ChainPath {
  start: ChainStart;
  nodes: CodeNode[];
}

type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function topLevelDirectoriesFromTrackedPaths(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const rawPath of paths) {
    const normalized = rawPath.replace(/\\/gu, '/').replace(/^\.\//u, '');
    const separator = normalized.indexOf('/');
    if (separator <= 0) continue;
    const directory = normalized.slice(0, separator);
    if (directory !== '.git') directories.add(directory);
  }
  return [...directories].sort(stablePathCompare);
}

function gitTrackedFiles(root: string): Promise<string[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      ['-C', root, 'ls-files', '-z', '--'],
      {
        encoding: 'utf8',
        maxBuffer: MAX_TRACKED_OUTPUT_BYTES,
        timeout: 15_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise(stdout.split('\0').filter(Boolean));
      },
    );
  });
}

function normalizedIndexedPath(filePath: string): string {
  return filePath.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function hasParentTraversal(filePath: string): boolean {
  return filePath.split('/').some((part) => part === '..');
}

function lineStartsFor(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineIndexAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return low;
}

function sourceMatch(
  content: string,
  starts: number[],
  offset: number,
  filePath: string,
): SourceMatch {
  const lineIndex = lineIndexAt(starts, offset);
  const lineStart = starts[lineIndex];
  let lineEnd = content.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = content.length;
  if (lineEnd > lineStart && content.charCodeAt(lineEnd - 1) === 13) lineEnd--;

  const fullLine = content.slice(lineStart, lineEnd);
  const columnOffset = offset - lineStart;
  if (fullLine.length <= MAX_TEXT_LENGTH) {
    return {
      path: filePath,
      line: lineIndex + 1,
      column: columnOffset + 1,
      text: fullLine,
    };
  }

  const excerptStart = Math.max(
    0,
    Math.min(columnOffset - 120, fullLine.length - MAX_TEXT_LENGTH),
  );
  const excerptEnd = Math.min(fullLine.length, excerptStart + MAX_TEXT_LENGTH);
  return {
    path: filePath,
    line: lineIndex + 1,
    column: columnOffset + 1,
    text: `${excerptStart > 0 ? '…' : ''}${fullLine.slice(excerptStart, excerptEnd)}${excerptEnd < fullLine.length ? '…' : ''}`,
    text_truncated: true,
  };
}

function incrementReason(reasons: IncompleteReasons, key: keyof IncompleteReasons): void {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

function isProductionPath(filePath: string): boolean {
  const normalized = normalizedIndexedPath(filePath).toLowerCase();
  return !(
    normalized.startsWith('test/')
    || normalized.startsWith('tests/')
    || normalized.startsWith('__tests__/')
    || normalized.includes('/test/')
    || normalized.includes('/tests/')
    || normalized.includes('/__tests__/')
    || /\.(?:test|spec)\.[^/]+$/u.test(normalized)
  );
}

function isCallableNode(node: CodeNode): boolean {
  return CALLABLE_LABELS.has(node.label) && !/^(?:anonymous#\d+|<anonymous>)$/u.test(node.name);
}

function stableNodeCompare(left: CodeNode, right: CodeNode): number {
  return stablePathCompare(left.name, right.name)
    || stablePathCompare(normalizedIndexedPath(left.file_path), normalizedIndexedPath(right.file_path))
    || left.start_line - right.start_line
    || stablePathCompare(left.qualified_name, right.qualified_name);
}

function entryLabel(entry: string): string {
  const trimmed = entry.trim();
  if (/^[A-Z]{2,10}\s+\/\S+/u.test(trimmed)) return trimmed;
  const commandName = /^([A-Za-z0-9:_-]+)(?:\s|$)/u.exec(trimmed)?.[1];
  if (commandName && (trimmed === commandName || trimmed.includes('[') || trimmed.includes('<'))) {
    return `${commandName} command`;
  }
  return trimmed;
}

function calledSymbolsInRange(content: string, startLine: number, endLine: number): Map<string, number> {
  const result = new Map<string, number>();
  const lines = content.split(/\r?\n/u);
  const first = Math.max(0, startLine - 1);
  const last = Math.min(lines.length, Math.max(first, endLine));
  const callPattern = /\b([A-Za-z_$][\w$]*)\s*(?:<[^>\r\n]{0,200}>)?\s*\(/gu;
  for (let index = first; index < last; index++) {
    callPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = callPattern.exec(lines[index])) !== null) {
      const symbol = match[1];
      if (!result.has(symbol)) result.set(symbol, index + 1);
    }
  }
  return result;
}

function normalizedSemanticWords(value: string): string[] {
  const splitCamel = value.replace(/([a-z0-9])([A-Z])/gu, '$1 $2');
  return [...new Set(splitCamel.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean).map((word) => {
    if (/^(?:execute|executes|executed|executing|execution|executor)$/u.test(word)) return 'run';
    if (word.endsWith('ing') && word.length > 5) {
      const stem = word.slice(0, -3);
      return stem.length >= 2 && stem.at(-1) === stem.at(-2) ? stem.slice(0, -1) : stem;
    }
    if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
    if (word.endsWith('s') && word.length > 3) return word.slice(0, -1);
    return word;
  }))];
}

function semanticNameScore(name: string, hintWords: readonly string[]): number {
  const nameWords = normalizedSemanticWords(name);
  const hintSet = new Set(hintWords);
  const matches = nameWords.filter((word) => hintSet.has(word)).length;
  if (matches === 0) return 0;
  return matches * 100 - (nameWords.length - matches) * 3;
}

export class LookupSourceTextTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'lookup_source_text',
      description: 'Run one bounded exact-source operation. For exhaustive reverse caller impact, call direct_callers once with max_depth set to the requested hop bound, then copy formatted_callers. For any route-to-target or CLI-command-to-target trace, call call_chain first without pre-searching and copy formatted_chain. Other profiles find literals or list Git-tracked directories.',
      annotations: {
        title: 'Look up exact source text',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: 'object',
        properties: {
          project: {
            type: 'string',
            description: 'Optional exact indexed project name. Omit this argument to use the MCP server\'s configured project; do not infer it from the repository name.',
          },
          operation: {
            type: 'string',
            enum: OPERATIONS,
            default: 'literal_matches',
            description: 'Exact operation. Use call_chain immediately for route/CLI entry-to-target questions; do not discover its intermediate symbols first. Existing calls default to literal_matches.',
          },
          queries: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_QUERIES,
            items: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
            description: 'literal_matches only: unique case-sensitive single-line strings.',
          },
          max_results_per_query: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_RESULTS_PER_QUERY,
            default: DEFAULT_RESULTS_PER_QUERY,
          },
          symbol: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_QUERY_LENGTH,
            description: 'direct_callers only: exact callee symbol name.',
          },
          include_tests: {
            type: 'boolean',
            default: false,
            description: 'direct_callers only: include repository test roots and test/spec files. Product directories named src/.../test remain production when false.',
          },
          max_callers: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_CALLERS,
            default: DEFAULT_CALLERS,
            description: 'direct_callers only: maximum direct or transitive caller records returned. Truncation makes complete false.',
          },
          max_depth: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_CHAIN_HOPS,
            default: 1,
            description: 'direct_callers only: reverse caller depth. Keep 1 for the existing direct aggregation; use 2-8 to return identity-aware transitive_callers and copy-ready formatted_callers.',
          },
          inventory_scope: {
            type: 'string',
            enum: ['tracked', 'indexed'],
            default: 'tracked',
            description: 'top_level_directories only: tracked is exact Git inventory; indexed is graph-only and explicitly non-exhaustive.',
          },
          entry: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_QUERY_LENGTH,
            description: 'call_chain only: exact route literal, exact CLI command declaration, or one-word CLI command name (for example GET /api/layout or test).',
          },
          target_symbol: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_QUERY_LENGTH,
            description: 'call_chain only: exact terminal function or method name.',
          },
          target_hint: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_QUERY_LENGTH,
            description: 'call_chain only: required instead of target_symbol when the task describes the terminal semantically (for example graph-packing primitive or shared task executor).',
          },
          max_hops: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_CHAIN_HOPS,
            default: DEFAULT_CHAIN_HOPS,
          },
        },
        additionalProperties: false,
      },
      handler: LookupSourceTextTool,
    };
  }

  async handle(args: Record<string, unknown>): Promise<ToolResponse> {
    try {
      const project = this.optionalString(args, 'project') ?? this.project;
      const operation = (this.optionalString(args, 'operation') ?? 'literal_matches') as SourceOperation;
      if (!OPERATIONS.includes(operation)) {
        throw new Error(`Argument operation must be one of: ${OPERATIONS.join(', ')}.`);
      }
      if (operation === 'direct_callers') return await this.handleDirectCallers(args, project);
      if (operation === 'top_level_directories') return await this.handleTopLevelDirectories(args, project);
      if (operation === 'call_chain') return await this.handleCallChain(args, project);

      const queries = this.validateQueries(args);
      const maxResults = Math.max(1, Math.min(
        MAX_RESULTS_PER_QUERY,
        Math.floor(this.optionalNumber(args, 'max_results_per_query') ?? DEFAULT_RESULTS_PER_QUERY),
      ));
      const codeReader = this.codeReader;
      if (!codeReader) {
        return this.error('Code graph reader not configured. Index the project first.');
      }
      const root = codeReader.getProjectRoot(project);
      if (!root) {
        return this.error(`Indexed repository root is unavailable for project "${project}".`);
      }
      const realRoot = safeRealpathStrict(root);

      const indexedPathProbe = codeReader.listProjectFilePaths(project, MAX_INDEXED_FILES + 1);
      const reasons: IncompleteReasons = {};
      if (indexedPathProbe.length > MAX_INDEXED_FILES) {
        reasons.indexed_file_limit = indexedPathProbe.length - MAX_INDEXED_FILES;
      }
      const indexedPaths = [...new Set(
        indexedPathProbe
          .slice(0, MAX_INDEXED_FILES)
          .map(normalizedIndexedPath),
      )].sort(stablePathCompare);

      const results: QueryResult[] = queries.map((query) => ({
        query,
        matches: [],
        matches_truncated: false,
      }));
      const seenRealPaths = new Set<string>();
      let filesScanned = 0;
      let bytesScanned = 0;

      for (const filePath of indexedPaths) {
        if (
          filePath.length === 0
          || hasParentTraversal(filePath)
          || (!isAbsolute(filePath) && (posix.isAbsolute(filePath) || win32.isAbsolute(filePath)))
        ) {
          incrementReason(reasons, 'unsafe_paths');
          continue;
        }

        let realFilePath: string;
        try {
          realFilePath = isAbsolute(filePath)
            ? safeRealpathStrict(filePath)
            : assertPathInsideRoot(realRoot, filePath);
          if (!isPathInside(realRoot, realFilePath)) {
            incrementReason(reasons, 'unsafe_paths');
            continue;
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes('Path traversal rejected')) {
            incrementReason(reasons, 'unsafe_paths');
          } else {
            incrementReason(reasons, 'unreadable_files');
          }
          continue;
        }

        const realPathKey = process.platform === 'win32'
          ? realFilePath.toLowerCase()
          : realFilePath;
        if (seenRealPaths.has(realPathKey)) continue;
        seenRealPaths.add(realPathKey);

        let fileStat;
        try {
          fileStat = await stat(realFilePath);
        } catch {
          incrementReason(reasons, 'unreadable_files');
          continue;
        }
        if (!fileStat.isFile()) {
          incrementReason(reasons, 'non_file_paths');
          continue;
        }
        if (fileStat.size > MAX_FILE_BYTES) {
          incrementReason(reasons, 'oversized_files');
          continue;
        }
        if (bytesScanned + fileStat.size > MAX_TOTAL_BYTES) {
          incrementReason(reasons, 'byte_budget');
          break;
        }

        let buffer: Buffer;
        try {
          buffer = await readFile(realFilePath);
        } catch {
          incrementReason(reasons, 'unreadable_files');
          continue;
        }
        if (buffer.length > MAX_FILE_BYTES) {
          incrementReason(reasons, 'oversized_files');
          continue;
        }
        if (bytesScanned + buffer.length > MAX_TOTAL_BYTES) {
          incrementReason(reasons, 'byte_budget');
          break;
        }
        filesScanned++;
        bytesScanned += buffer.length;
        if (buffer.includes(0)) {
          incrementReason(reasons, 'binary_files');
          continue;
        }

        const content = buffer.toString('utf8');
        let starts: number[] | undefined;
        for (const result of results) {
          if (result.matches_truncated) continue;
          let offset = content.indexOf(result.query);
          while (offset !== -1) {
            if (result.matches.length >= maxResults) {
              result.matches_truncated = true;
              break;
            }
            starts ??= lineStartsFor(content);
            result.matches.push(sourceMatch(content, starts, offset, filePath));
            offset = content.indexOf(result.query, offset + result.query.length);
          }
        }
      }

      const response: Record<string, unknown> = {
        project,
        results,
        files_scanned: filesScanned,
        bytes_scanned: bytesScanned,
        scan_complete: Object.keys(reasons).length === 0,
      };
      if (Object.keys(reasons).length > 0) response.scan_incomplete_reasons = reasons;
      return this.json(response);
    } catch (error: unknown) {
      return this.error(error instanceof Error ? error.message : String(error));
    }
  }

  private async handleDirectCallers(args: Record<string, unknown>, project: string): Promise<ToolResponse> {
    const symbol = this.requireString(args, 'symbol');
    if (symbol.length > MAX_QUERY_LENGTH || /[\r\n\0]/u.test(symbol)) {
      throw new Error(`Argument symbol must be a single-line string of at most ${MAX_QUERY_LENGTH} characters.`);
    }
    const includeTestsValue = args.include_tests;
    if (includeTestsValue !== undefined && typeof includeTestsValue !== 'boolean') {
      throw new Error('Argument include_tests must be a boolean.');
    }
    const maxCallers = Math.max(1, Math.min(
      MAX_CALLERS,
      Math.floor(this.optionalNumber(args, 'max_callers') ?? DEFAULT_CALLERS),
    ));
    const maxDepth = Math.max(1, Math.min(
      MAX_CHAIN_HOPS,
      Math.floor(this.optionalNumber(args, 'max_depth') ?? 1),
    ));
    const codeReader = this.codeReader;
    if (!codeReader) return this.error('Code graph reader not configured. Index the project first.');
    const direct = codeReader.listDirectCallers(project, symbol, {
      includeTests: includeTestsValue === true,
      limit: maxCallers,
    });
    if (maxDepth === 1) return this.json({
      project,
      operation: 'direct_callers',
      ...direct,
    });

    const root = codeReader.getProjectRoot(project);
    if (!root) return this.error(`Indexed repository root is unavailable for project "${project}".`);
    const indexedPathProbe = codeReader.listProjectFilePaths(project, MAX_INDEXED_FILES + 1);
    const reasons = new Set<string>();
    if (indexedPathProbe.length > MAX_INDEXED_FILES) reasons.add('indexed_file_limit');
    if (direct.target_candidates.length !== 1) {
      reasons.add(direct.target_candidates.length === 0
        ? 'transitive_target_not_found'
        : 'transitive_target_ambiguous');
    }
    const structural = direct.target_candidates.length === 1
      ? (await import('../structural-callers.js')).traceStructuralCallers({
          root,
          indexedPaths: indexedPathProbe.slice(0, MAX_INDEXED_FILES),
          target: {
            name: symbol,
            path: direct.target_candidates[0].path,
            definitionLine: direct.target_candidates[0].definition_line,
          },
          maxDepth,
          includeTests: includeTestsValue === true,
        })
      : {
          callers: [],
          complete: false,
          incomplete_reasons: [],
          source_files_analyzed: 0,
    };
    for (const reason of structural.incomplete_reasons) reasons.add(reason);
    const transitiveCallersTruncated = structural.callers.length > maxCallers;
    if (transitiveCallersTruncated) reasons.add('transitive_callers_truncated');
    const transitiveCallers = structural.callers.slice(0, maxCallers);
    const incompleteReasons = [...reasons].sort(stablePathCompare);
    return this.json({
      project,
      operation: 'direct_callers',
      ...direct,
      max_depth: maxDepth,
      transitive_callers: transitiveCallers,
      formatted_callers: transitiveCallers.map((caller) => (
        `${caller.depth}|${caller.name}@${caller.path}:${caller.definition_line}`
      )),
      transitive_callers_truncated: transitiveCallersTruncated,
      analysis: {
        method: 'typescript_semantic',
        source_files: structural.source_files_analyzed,
      },
      complete: structural.complete && incompleteReasons.length === 0,
      incomplete_reasons: incompleteReasons,
    });
  }

  private async handleTopLevelDirectories(args: Record<string, unknown>, project: string) {
    const inventoryScope = this.optionalString(args, 'inventory_scope') ?? 'tracked';
    if (!['tracked', 'indexed'].includes(inventoryScope)) {
      throw new Error('Argument inventory_scope must be one of: tracked, indexed.');
    }
    const codeReader = this.codeReader;
    if (!codeReader) return this.error('Code graph reader not configured. Index the project first.');

    const indexedPathProbe = codeReader.listProjectFilePaths(project, MAX_INDEXED_FILES + 1);
    const indexedPaths = indexedPathProbe.slice(0, MAX_INDEXED_FILES);
    const indexedDirectories = topLevelDirectoriesFromTrackedPaths(indexedPaths);
    if (inventoryScope === 'indexed') {
      return this.json({
        project,
        operation: 'top_level_directories',
        inventory_scope: 'indexed',
        directories: indexedDirectories.slice(0, MAX_TOP_LEVEL_DIRECTORIES),
        files_observed: indexedPaths.length,
        complete: false,
        incomplete_reasons: [
          ...(indexedPathProbe.length > MAX_INDEXED_FILES ? ['indexed_file_limit'] : []),
          ...(indexedDirectories.length > MAX_TOP_LEVEL_DIRECTORIES ? ['directories_truncated'] : []),
          'indexed_sources_only',
        ].sort(),
      });
    }

    const root = codeReader.getProjectRoot(project);
    if (!root) return this.error(`Indexed repository root is unavailable for project "${project}".`);
    const realRoot = safeRealpathStrict(root);
    try {
      const trackedFiles = await gitTrackedFiles(realRoot);
      const directories = topLevelDirectoriesFromTrackedPaths(trackedFiles);
      const truncated = directories.length > MAX_TOP_LEVEL_DIRECTORIES;
      return this.json({
        project,
        operation: 'top_level_directories',
        inventory_scope: 'tracked',
        directories: directories.slice(0, MAX_TOP_LEVEL_DIRECTORIES),
        tracked_files: trackedFiles.length,
        complete: !truncated,
        ...(truncated ? { incomplete_reasons: ['directories_truncated'] } : {}),
      });
    } catch {
      return this.json({
        project,
        operation: 'top_level_directories',
        inventory_scope: 'indexed_fallback',
        directories: indexedDirectories.slice(0, MAX_TOP_LEVEL_DIRECTORIES),
        files_observed: indexedPaths.length,
        complete: false,
        incomplete_reasons: [
          ...(indexedPathProbe.length > MAX_INDEXED_FILES ? ['indexed_file_limit'] : []),
          ...(indexedDirectories.length > MAX_TOP_LEVEL_DIRECTORIES ? ['directories_truncated'] : []),
          'git_inventory_unavailable',
          'indexed_sources_only',
        ].sort(),
      });
    }
  }

  private async handleCallChain(
    args: Record<string, unknown>,
    project: string,
  ): Promise<ToolResponse> {
    const entry = this.requireString(args, 'entry');
    const targetSymbol = this.optionalString(args, 'target_symbol');
    const targetHint = this.optionalString(args, 'target_hint');
    if (!targetSymbol && !targetHint) {
      throw new Error('call_chain requires target_symbol or target_hint. If the exact symbol is unknown, pass the task\'s terminal description as target_hint.');
    }
    for (const [name, value] of [
      ['entry', entry],
      ['target_symbol', targetSymbol],
      ['target_hint', targetHint],
    ] as const) {
      if (value === undefined) continue;
      if (value.length > MAX_QUERY_LENGTH || /[\r\n\0]/u.test(value)) {
        throw new Error(`Argument ${name} must be a single-line string of at most ${MAX_QUERY_LENGTH} characters.`);
      }
    }
    const maxHops = Math.max(1, Math.min(
      MAX_CHAIN_HOPS,
      Math.floor(this.optionalNumber(args, 'max_hops') ?? DEFAULT_CHAIN_HOPS),
    ));
    const codeReader = this.codeReader;
    if (!codeReader) return this.error('Code graph reader not configured. Index the project first.');
    const root = codeReader.getProjectRoot(project);
    if (!root) return this.error(`Indexed repository root is unavailable for project "${project}".`);
    const realRoot = safeRealpathStrict(root);

    const commandNameOnly = /^[A-Za-z0-9:_-]+$/u.test(entry);
    const entryQueries = commandNameOnly
      ? [
          `command('${entry} `,
          `command('${entry}'`,
          `command("${entry} `,
          `command("${entry}"`,
        ]
      : [entry];
    const lookup = await this.handle({
      project,
      operation: 'literal_matches',
      queries: entryQueries,
      max_results_per_query: MAX_RESULTS_PER_QUERY,
    });
    if (lookup.isError) return lookup;
    const lookupPayload = JSON.parse(lookup.content[0].text) as {
      results: Array<{ query: string; matches: SourceMatch[]; matches_truncated: boolean }>;
      scan_complete: boolean;
      scan_incomplete_reasons?: IncompleteReasons;
    };
    const entryMatches: ChainEntryMatch[] = [];
    const seenEntries = new Set<string>();
    let entryMatchesTruncated = false;
    for (const result of lookupPayload.results) {
      entryMatchesTruncated ||= result.matches_truncated;
      for (const match of result.matches) {
        const key = `${match.path}\0${match.line}\0${match.column}`;
        if (seenEntries.has(key)) continue;
        seenEntries.add(key);
        entryMatches.push({ ...match, query: result.query });
      }
    }
    entryMatches.sort((left, right) => (
      stablePathCompare(left.path, right.path)
      || left.line - right.line
      || left.column - right.column
    ));

    const incompleteReasons = new Set<string>();
    const status = codeReader.getProjectCallSiteStatus(project);
    for (const reason of status.incomplete_reasons) incompleteReasons.add(reason);
    const projectCallSites = codeReader.listProjectCallSites(project, {
      includeTests: false,
      limit: 200_000,
    });
    if (!projectCallSites.available) incompleteReasons.add('call_sites_unavailable');
    if (projectCallSites.truncated) incompleteReasons.add('project_call_sites_truncated');
    const callSitesByOwner = new Map<string, typeof projectCallSites.call_sites>();
    const callersBySymbol = new Map<string, Set<string>>();
    for (const callSite of projectCallSites.call_sites) {
      const ownerSites = callSitesByOwner.get(callSite.owner_qualified_name) ?? [];
      ownerSites.push(callSite);
      callSitesByOwner.set(callSite.owner_qualified_name, ownerSites);
      const owners = callersBySymbol.get(callSite.symbol) ?? new Set<string>();
      owners.add(callSite.owner_qualified_name);
      callersBySymbol.set(callSite.symbol, owners);
    }
    if (!lookupPayload.scan_complete) incompleteReasons.add('entry_scan_incomplete');
    if (entryMatchesTruncated) incompleteReasons.add('entry_matches_truncated');
    if (entryMatches.length === 0) incompleteReasons.add('entry_not_found');

    let resolvedTargetSymbol = targetSymbol ?? '';
    let targetResolution: Record<string, unknown> = { mode: 'exact_symbol' };
    if (!targetSymbol && targetHint) {
      const hintWords = normalizedSemanticWords(targetHint);
      const rankedSymbols = [...callersBySymbol.keys()].map((symbol) => ({
        symbol,
        score: semanticNameScore(symbol, hintWords),
      })).filter((candidate) => candidate.score > 0).sort((left, right) => (
        right.score - left.score || stablePathCompare(left.symbol, right.symbol)
      ));
      const bestScore = rankedSymbols[0]?.score ?? 0;
      const bestSymbols = rankedSymbols
        .filter((candidate) => candidate.score === bestScore)
        .map((candidate) => candidate.symbol);
      if (bestSymbols.length === 0) incompleteReasons.add('target_hint_no_match');
      if (bestSymbols.length > 1) incompleteReasons.add('target_hint_ambiguous');
      resolvedTargetSymbol = bestSymbols[0] ?? '';
      targetResolution = {
        mode: 'semantic_hint',
        hint: targetHint,
        selected_symbol: resolvedTargetSymbol || null,
        lexical_score: bestScore,
        alternatives: rankedSymbols.slice(1, 5),
      };
    }

    const targetCandidates = resolvedTargetSymbol
      ? codeReader.findNodesByName(project, resolvedTargetSymbol, undefined, 21)
      .filter((node) => isCallableNode(node) && isProductionPath(node.file_path))
      .sort(stableNodeCompare)
      : [];
    if (targetCandidates.length === 0) incompleteReasons.add('target_not_found');
    if (targetCandidates.length > 1) incompleteReasons.add('target_ambiguous');
    if (targetCandidates.length > 20) incompleteReasons.add('target_candidates_truncated');
    const boundedTargets = targetCandidates.slice(0, 20);
    const targetQualifiedNames = new Set(boundedTargets.map((node) => node.qualified_name));

    const sourceCache = new Map<string, string | null>();
    const readSource = async (filePath: string): Promise<string | null> => {
      const normalizedPath = normalizedIndexedPath(filePath);
      if (sourceCache.has(normalizedPath)) return sourceCache.get(normalizedPath) ?? null;
      try {
        if (
          normalizedPath.length === 0
          || hasParentTraversal(normalizedPath)
          || isAbsolute(normalizedPath)
          || posix.isAbsolute(normalizedPath)
          || win32.isAbsolute(normalizedPath)
        ) throw new Error('unsafe path');
        const realPath = assertPathInsideRoot(realRoot, normalizedPath);
        if (!isPathInside(realRoot, realPath)) throw new Error('path escape');
        const fileStat = await stat(realPath);
        if (!fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) throw new Error('unsupported source');
        const buffer = await readFile(realPath);
        if (buffer.length > MAX_FILE_BYTES || buffer.includes(0)) throw new Error('unsupported source');
        const content = buffer.toString('utf8');
        sourceCache.set(normalizedPath, content);
        return content;
      } catch {
        sourceCache.set(normalizedPath, null);
        incompleteReasons.add('chain_source_unavailable');
        return null;
      }
    };

    const starts: ChainStart[] = [];
    const seenStarts = new Set<string>();
    for (const match of entryMatches) {
      const content = await readSource(match.path);
      if (!content) continue;
      const referencedSymbols = [...calledSymbolsInRange(content, match.line, match.line).keys()];
      const referenced = codeReader.findNodesByNames(project, referencedSymbols, 200)
        .filter((node) => isCallableNode(node) && isProductionPath(node.file_path))
        .sort(stableNodeCompare);
      const enclosing = codeReader.findNodesContainingLine(project, match.path, match.line, 50)
        .filter((node) => isCallableNode(node) && isProductionPath(node.file_path))
        .sort(stableNodeCompare);
      const candidates: Array<{ node: CodeNode; kind: ChainStart['kind'] }> = referenced.length > 0
        ? referenced.map((node) => ({ node, kind: 'referenced' as const }))
        : enclosing.map((node) => ({ node, kind: 'enclosing' as const }));
      for (const candidate of candidates) {
        const key = `${candidate.kind}\0${candidate.node.qualified_name}\0${match.path}\0${match.line}`;
        if (seenStarts.has(key)) continue;
        seenStarts.add(key);
        starts.push({ ...candidate, entry: match });
      }
    }
    starts.sort((left, right) => (
      (left.kind === right.kind ? 0 : left.kind === 'referenced' ? -1 : 1)
      || stableNodeCompare(left.node, right.node)
      || stablePathCompare(left.entry.path, right.entry.path)
      || left.entry.line - right.entry.line
    ));
    if (starts.length === 0) incompleteReasons.add('entry_start_symbol_not_found');

    // Reverse static callers are used only as a deterministic pruning signal.
    // Every returned forward hop is still verified from a persistent call-site
    // or an exact source call expression in the caller's definition range.
    const reverseQualifiedNames = new Set(targetQualifiedNames);
    const reverseSymbolNames = new Set(boundedTargets.map((node) => node.name));
    let reverseFrontier = [...boundedTargets];
    for (let depth = 0; depth < maxHops && reverseFrontier.length > 0; depth++) {
      const next = new Map<string, CodeNode>();
      for (const node of reverseFrontier) {
        const ownerQualifiedNames = [...(callersBySymbol.get(node.name) ?? [])]
          .sort(stablePathCompare);
        for (const ownerQualifiedName of ownerQualifiedNames) {
          const owner = codeReader.findNodeByQualifiedName(project, ownerQualifiedName);
          if (!owner || !isCallableNode(owner) || !isProductionPath(owner.file_path)) continue;
          reverseQualifiedNames.add(owner.qualified_name);
          reverseSymbolNames.add(owner.name);
          if (!next.has(owner.qualified_name)) next.set(owner.qualified_name, owner);
          if (reverseQualifiedNames.size >= MAX_CHAIN_EXPANSIONS) break;
        }
        if (reverseQualifiedNames.size >= MAX_CHAIN_EXPANSIONS) break;
      }
      reverseFrontier = [...next.values()].sort(stableNodeCompare);
      if (reverseQualifiedNames.size >= MAX_CHAIN_EXPANSIONS) break;
    }

    const outgoing = async (node: CodeNode): Promise<CodeNode[]> => {
      const symbols = new Map<string, number>();
      for (const callSite of callSitesByOwner.get(node.qualified_name) ?? []) {
        if (!symbols.has(callSite.symbol)) {
          symbols.set(callSite.symbol, callSite.line);
        }
      }
      const content = await readSource(node.file_path);
      if (content) {
        for (const [symbol, line] of calledSymbolsInRange(content, node.start_line, node.end_line)) {
          if (!symbols.has(symbol)) symbols.set(symbol, line);
        }
      }
      const orderedSymbols = [...symbols.keys()].sort((left, right) => {
        const leftPriority = reverseSymbolNames.has(left) ? 0 : COMMON_CALL_NAMES.has(left) ? 2 : 1;
        const rightPriority = reverseSymbolNames.has(right) ? 0 : COMMON_CALL_NAMES.has(right) ? 2 : 1;
        return leftPriority - rightPriority || stablePathCompare(left, right);
      });
      if (orderedSymbols.length > MAX_CHAIN_SYMBOLS_PER_NODE) {
        incompleteReasons.add('outgoing_symbols_truncated');
      }
      const candidates = codeReader.findNodesByNames(
        project,
        orderedSymbols.slice(0, MAX_CHAIN_SYMBOLS_PER_NODE),
        2000,
      ).filter((candidate) => (
        candidate.qualified_name !== node.qualified_name
        && isCallableNode(candidate)
        && isProductionPath(candidate.file_path)
      ));
      const preferred = candidates.filter((candidate) => reverseQualifiedNames.has(candidate.qualified_name));
      return (preferred.length > 0 ? preferred : candidates).sort(stableNodeCompare);
    };

    const queue: ChainPath[] = starts.map((start) => ({ start, nodes: [start.node] }));
    const minimumDepth = new Map<string, number>();
    for (const start of starts) minimumDepth.set(start.node.qualified_name, 0);
    const found: ChainPath[] = [];
    let foundDepth: number | null = null;
    let expansions = 0;
    let pathsTruncated = false;
    while (queue.length > 0) {
      const currentPath = queue.shift()!;
      const depth = currentPath.nodes.length - 1;
      if (foundDepth !== null && depth > foundDepth) break;
      const current = currentPath.nodes.at(-1)!;
      if (targetQualifiedNames.has(current.qualified_name)) {
        foundDepth = depth;
        if (found.length < MAX_CHAIN_PATHS) found.push(currentPath);
        else pathsTruncated = true;
        continue;
      }
      if (depth >= maxHops) continue;
      expansions++;
      if (expansions > MAX_CHAIN_EXPANSIONS) {
        incompleteReasons.add('chain_expansion_limit');
        break;
      }
      const pathNames = new Set(currentPath.nodes.map((node) => node.qualified_name));
      for (const neighbor of await outgoing(current)) {
        if (pathNames.has(neighbor.qualified_name)) continue;
        const nextDepth = depth + 1;
        const priorDepth = minimumDepth.get(neighbor.qualified_name);
        if (priorDepth !== undefined && priorDepth < nextDepth) continue;
        minimumDepth.set(neighbor.qualified_name, nextDepth);
        queue.push({ start: currentPath.start, nodes: [...currentPath.nodes, neighbor] });
      }
    }
    found.sort((left, right) => stablePathCompare(
      left.nodes.map((node) => node.name).join('\0'),
      right.nodes.map((node) => node.name).join('\0'),
    ));
    const viableEntries = new Set(found.map((path) => (
      `${path.start.entry.path}\0${path.start.entry.line}\0${path.start.entry.column}`
    )));
    if (viableEntries.size > 1) incompleteReasons.add('entry_ambiguous');
    if (found.length === 0) incompleteReasons.add('chain_not_found');
    if (pathsTruncated) incompleteReasons.add('alternative_chains_truncated');

    const primary = found[0];
    const chainNodes = primary
      ? (primary.start.kind === 'enclosing' ? primary.nodes.slice(1) : primary.nodes)
      : [];
    const formattedChain = primary ? [
      `${entryLabel(entry)}@${normalizedIndexedPath(primary.start.entry.path)}:${primary.start.entry.line}`,
      ...chainNodes.map((node) => (
        `${node.name}@${normalizedIndexedPath(node.file_path)}:${node.start_line}`
      )),
    ].join(' -> ') : null;
    const reasons = [...incompleteReasons].sort(stablePathCompare);
    return this.json({
      project,
      operation: 'call_chain',
      entry: primary ? {
        label: entryLabel(entry),
        literal: entry,
        path: normalizedIndexedPath(primary.start.entry.path),
        line: primary.start.entry.line,
        text: primary.start.entry.text,
      } : null,
      chain: chainNodes.map((node) => ({
        name: node.name,
        path: normalizedIndexedPath(node.file_path),
        definition_line: node.start_line,
      })),
      formatted_chain: formattedChain,
      target_symbol: resolvedTargetSymbol || null,
      target_resolution: targetResolution,
      max_hops: maxHops,
      entry_matches: entryMatches.length,
      shortest_chains_found: found.length,
      alternative_chains_truncated: pathsTruncated,
      complete: reasons.length === 0,
      incomplete_reasons: reasons,
    });
  }

  private validateQueries(args: Record<string, unknown>): string[] {
    const rawQueries = this.optionalArray(args, 'queries');
    if (!rawQueries || rawQueries.length === 0 || rawQueries.length > MAX_QUERIES) {
      throw new Error(`Argument queries must contain 1-${MAX_QUERIES} strings.`);
    }
    const queries = rawQueries.map((query, index) => {
      if (typeof query !== 'string') {
        throw new Error(`Argument queries[${index}] must be a string.`);
      }
      if (query.trim().length === 0 || query.length > MAX_QUERY_LENGTH) {
        throw new Error(`Argument queries[${index}] must contain 1-${MAX_QUERY_LENGTH} non-whitespace characters.`);
      }
      if (query.includes('\n') || query.includes('\r') || query.includes('\0')) {
        throw new Error(`Argument queries[${index}] must be a single-line text literal.`);
      }
      return query;
    });
    if (new Set(queries).size !== queries.length) {
      throw new Error('Argument queries must not contain duplicate literals.');
    }
    return queries;
  }
}
