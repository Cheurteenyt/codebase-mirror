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
const OPERATIONS = ['literal_matches', 'direct_callers', 'top_level_directories'] as const;
type SourceOperation = typeof OPERATIONS[number];

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

export class LookupSourceTextTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'lookup_source_text',
      description: 'Run one bounded exact-source operation. literal_matches finds case-sensitive literals and lines; direct_callers returns deterministic static caller counts without search loops; top_level_directories returns exact Git-tracked repository directories. Prefer these exact profiles over exploratory search when they match the question.',
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
          project: { type: 'string' },
          operation: {
            type: 'string',
            enum: OPERATIONS,
            default: 'literal_matches',
            description: 'Exact operation. Existing calls default to literal_matches.',
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
            description: 'direct_callers only: include call-sites under test paths.',
          },
          max_callers: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_CALLERS,
            default: DEFAULT_CALLERS,
          },
          inventory_scope: {
            type: 'string',
            enum: ['tracked', 'indexed'],
            default: 'tracked',
            description: 'top_level_directories only: tracked is exact Git inventory; indexed is graph-only and explicitly non-exhaustive.',
          },
        },
        additionalProperties: false,
      },
      handler: LookupSourceTextTool,
    };
  }

  async handle(args: Record<string, unknown>) {
    try {
      const project = this.optionalString(args, 'project') ?? this.project;
      const operation = (this.optionalString(args, 'operation') ?? 'literal_matches') as SourceOperation;
      if (!OPERATIONS.includes(operation)) {
        throw new Error(`Argument operation must be one of: ${OPERATIONS.join(', ')}.`);
      }
      if (operation === 'direct_callers') return this.handleDirectCallers(args, project);
      if (operation === 'top_level_directories') return await this.handleTopLevelDirectories(args, project);

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

  private handleDirectCallers(args: Record<string, unknown>, project: string) {
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
    const codeReader = this.codeReader;
    if (!codeReader) return this.error('Code graph reader not configured. Index the project first.');
    return this.json({
      project,
      operation: 'direct_callers',
      ...codeReader.listDirectCallers(project, symbol, {
        includeTests: includeTestsValue === true,
        limit: maxCallers,
      }),
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
