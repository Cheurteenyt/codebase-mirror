import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import {
  assertPathInsideRoot,
  isPathInside,
  safeRealpathStrict,
} from '../utils/safe-path.js';

const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;

export interface StructuralCallerTarget {
  name: string;
  path: string;
  definitionLine: number;
}

export interface StructuralCaller {
  depth: number;
  name: string;
  path: string;
  definition_line: number;
}

export interface StructuralCallerResult {
  callers: StructuralCaller[];
  complete: boolean;
  incomplete_reasons: string[];
  source_files_analyzed: number;
}

interface NamedCallable {
  symbol: ts.Symbol;
  name: string;
  declaration: ts.Node;
}

interface AnalysisInputs {
  rootNames: string[];
  repositoryPathByAbsolute: Map<string, string>;
  incompleteReasons: Set<string>;
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedRepositoryPath(filePath: string): string {
  return filePath.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function absolutePathKey(filePath: string): string {
  const absolute = resolve(filePath);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function supportedSourcePath(filePath: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/iu.test(filePath);
}

/**
 * Production filtering intentionally keeps product directories named
 * `src/.../test` (for example Playwright's MCP implementation) while excluding
 * repository test roots and test/spec files.
 */
function productionSourcePath(filePath: string): boolean {
  const normalized = normalizedRepositoryPath(filePath).toLowerCase();
  if (/(^|\/)node_modules(\/|$)/u.test(normalized)) return false;
  if (/(^|\/)(?:tests|__tests__)(\/|$)/u.test(normalized)) return false;
  if (
    /(^|\/)test(\/|$)/u.test(normalized)
    && !/(^|\/)src\/.*\/test(\/|$)/u.test(normalized)
  ) return false;
  return !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(normalized);
}

function collectAnalysisInputs(
  root: string,
  indexedPaths: readonly string[],
): AnalysisInputs {
  const realRoot = safeRealpathStrict(root);
  const rootNames: string[] = [];
  const repositoryPathByAbsolute = new Map<string, string>();
  const incompleteReasons = new Set<string>();
  let totalBytes = 0;

  for (const rawPath of indexedPaths) {
    const repositoryPath = normalizedRepositoryPath(rawPath);
    if (!supportedSourcePath(repositoryPath)) continue;
    if (
      repositoryPath.length === 0
      || isAbsolute(repositoryPath)
      || repositoryPath.split('/').some((part) => part === '..')
    ) {
      incompleteReasons.add('unsafe_source_paths');
      continue;
    }

    let absolutePath: string;
    try {
      absolutePath = assertPathInsideRoot(realRoot, repositoryPath);
      if (!isPathInside(realRoot, absolutePath)) throw new Error('source path escaped root');
      const fileStat = statSync(absolutePath);
      if (!fileStat.isFile()) throw new Error('source path is not a file');
      if (fileStat.size > MAX_SOURCE_FILE_BYTES) {
        incompleteReasons.add('oversized_source_files');
        continue;
      }
      if (totalBytes + fileStat.size > MAX_SOURCE_BYTES) {
        incompleteReasons.add('source_byte_budget');
        break;
      }
      totalBytes += fileStat.size;
    } catch {
      incompleteReasons.add('unreadable_source_files');
      continue;
    }

    const key = absolutePathKey(absolutePath);
    if (repositoryPathByAbsolute.has(key)) continue;
    repositoryPathByAbsolute.set(key, repositoryPath);
    rootNames.push(absolutePath);
  }

  rootNames.sort(stableCompare);
  return { rootNames, repositoryPathByAbsolute, incompleteReasons };
}

function compilerOptions(root: string, incompleteReasons: Set<string>): ts.CompilerOptions {
  let configured: ts.CompilerOptions = {};
  const configPath = join(root, 'tsconfig.json');
  if (existsSync(configPath)) {
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    if (loaded.error) {
      incompleteReasons.add('tsconfig_unreadable');
    } else {
      const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
      if (parsed.errors.length > 0) incompleteReasons.add('tsconfig_invalid');
      configured = parsed.options;
    }
  }
  return {
    ...configured,
    allowImportingTsExtensions: true,
    allowJs: true,
    baseUrl: configured.baseUrl ?? root,
    checkJs: false,
    jsx: configured.jsx ?? ts.JsxEmit.ReactJSX,
    module: configured.module ?? ts.ModuleKind.ESNext,
    moduleResolution: configured.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    target: configured.target ?? ts.ScriptTarget.ESNext,
  };
}

function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while (current && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
}

function symbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  return canonicalSymbol(checker, checker.getSymbolAtLocation(node));
}

function symbolKey(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): string | null {
  const canonical = canonicalSymbol(checker, symbol);
  if (!canonical) return null;
  const roots = checker.getRootSymbols(canonical);
  const identitySymbols = roots.length > 0 ? roots : [canonical];
  const declarations = identitySymbols.flatMap((identity) => (
    identity.declarations ?? (identity.valueDeclaration ? [identity.valueDeclaration] : [])
  ));
  if (declarations.length > 0) {
    return declarations.map((declaration) => {
      const source = declaration.getSourceFile();
      return `${absolutePathKey(source.fileName)}:${declaration.pos}:${declaration.end}`;
    }).sort(stableCompare).join('|');
  }
  return `synthetic:${canonical.flags}:${canonical.getName()}`;
}

function declarationName(node: ts.Node): ts.Identifier | ts.StringLiteral | null {
  if (
    (ts.isFunctionDeclaration(node)
      || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node))
    && node.name
    && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) return node.name;
  return null;
}

function assignedCallableName(
  node: ts.ArrowFunction | ts.FunctionExpression,
): ts.Identifier | ts.StringLiteral | null {
  if (node.name && ts.isIdentifier(node.name)) return node.name;
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name;
  if (
    ts.isPropertyAssignment(parent)
    && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
  ) return parent.name;
  return null;
}

function targetCallable(checker: ts.TypeChecker, node: ts.Node): NamedCallable | null {
  const declaredName = declarationName(node);
  if (declaredName) {
    const symbol = symbolAt(checker, declaredName);
    return symbol ? { symbol, name: declaredName.text, declaration: node } : null;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const assignedName = assignedCallableName(node);
    const symbol = assignedName ? symbolAt(checker, assignedName) : undefined;
    return symbol && assignedName
      ? { symbol, name: assignedName.text, declaration: node }
      : null;
  }
  return null;
}

function namedCallable(checker: ts.TypeChecker, node: ts.Node): NamedCallable | null {
  let current: ts.Node | undefined = node;
  while (current) {
    const callable = targetCallable(checker, current);
    if (callable) return callable;
    current = current.parent;
  }
  return null;
}

function calleeSymbol(checker: ts.TypeChecker, expression: ts.LeftHandSideExpression): ts.Symbol | undefined {
  if (ts.isIdentifier(expression)) return symbolAt(checker, expression);
  if (ts.isPropertyAccessExpression(expression)) return symbolAt(checker, expression.name);
  if (
    ts.isElementAccessExpression(expression)
    && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)
  ) return symbolAt(checker, expression.argumentExpression);
  return undefined;
}

function sourceLine(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function repositoryPathForSource(
  root: string,
  source: ts.SourceFile,
  repositoryPathByAbsolute: ReadonlyMap<string, string>,
): string | null {
  const direct = repositoryPathByAbsolute.get(absolutePathKey(source.fileName));
  if (direct) return direct;
  const relativePath = normalizedRepositoryPath(relative(root, source.fileName));
  if (relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) return null;
  return repositoryPathByAbsolute.has(absolutePathKey(resolve(root, relativePath)))
    ? relativePath
    : null;
}

function findTarget(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  target: StructuralCallerTarget,
): NamedCallable[] {
  const matches = new Map<string, NamedCallable>();
  const visit = (node: ts.Node): void => {
    const callable = targetCallable(checker, node);
    if (
      callable?.name === target.name
      && sourceLine(source, callable.declaration) === target.definitionLine
    ) {
      const key = symbolKey(checker, callable.symbol);
      if (key) matches.set(key, callable);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...matches.values()];
}

export function traceStructuralCallers(options: {
  root: string;
  indexedPaths: readonly string[];
  target: StructuralCallerTarget;
  maxDepth: number;
  includeTests: boolean;
}): StructuralCallerResult {
  const root = safeRealpathStrict(options.root);
  const inputs = collectAnalysisInputs(root, options.indexedPaths);
  const reasons = inputs.incompleteReasons;
  if (inputs.rootNames.length === 0) reasons.add('no_supported_source_files');

  let program: ts.Program;
  try {
    program = ts.createProgram({
      rootNames: inputs.rootNames,
      options: compilerOptions(root, reasons),
    });
  } catch {
    reasons.add('typescript_program_failed');
    return {
      callers: [],
      complete: false,
      incomplete_reasons: [...reasons].sort(stableCompare),
      source_files_analyzed: 0,
    };
  }

  const checker = program.getTypeChecker();
  const targetPath = normalizedRepositoryPath(options.target.path);
  const targetSource = program.getSourceFiles().find((source) => (
    repositoryPathForSource(root, source, inputs.repositoryPathByAbsolute) === targetPath
  ));
  if (!targetSource) reasons.add('target_source_not_found');
  const targets = targetSource ? findTarget(checker, targetSource, options.target) : [];
  if (targets.length === 0) reasons.add('target_symbol_not_found');
  if (targets.length > 1) reasons.add('target_symbol_ambiguous');
  const targetKey = targets.length === 1 ? symbolKey(checker, targets[0].symbol) : null;

  const reverse = new Map<string, Map<string, NamedCallable>>();
  let sourceFilesAnalyzed = 0;
  if (targetKey) {
    for (const source of program.getSourceFiles()) {
      const repositoryPath = repositoryPathForSource(root, source, inputs.repositoryPathByAbsolute);
      if (!repositoryPath) continue;
      if (!options.includeTests && !productionSourcePath(repositoryPath)) continue;
      sourceFilesAnalyzed++;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const calleeKey = symbolKey(checker, calleeSymbol(checker, node.expression));
          const caller = namedCallable(checker, node);
          const callerKey = caller ? symbolKey(checker, caller.symbol) : null;
          if (calleeKey && callerKey && caller) {
            const callers = reverse.get(calleeKey) ?? new Map<string, NamedCallable>();
            callers.set(callerKey, caller);
            reverse.set(calleeKey, callers);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }

  const depths = new Map<string, number>();
  const details = new Map<string, NamedCallable>();
  const queue: string[] = [];
  if (targetKey) {
    depths.set(targetKey, 0);
    queue.push(targetKey);
  }
  while (queue.length > 0) {
    const calleeKey = queue.shift()!;
    const nextDepth = (depths.get(calleeKey) ?? 0) + 1;
    if (nextDepth > options.maxDepth) continue;
    for (const [callerKey, caller] of reverse.get(calleeKey) ?? []) {
      const priorDepth = depths.get(callerKey);
      if (priorDepth !== undefined && priorDepth <= nextDepth) continue;
      depths.set(callerKey, nextDepth);
      details.set(callerKey, caller);
      queue.push(callerKey);
    }
  }

  const callers = [...details.entries()].map(([key, detail]): StructuralCaller | null => {
    const source = detail.declaration.getSourceFile();
    const path = repositoryPathForSource(root, source, inputs.repositoryPathByAbsolute);
    if (!path) return null;
    return {
      depth: depths.get(key)!,
      name: detail.name,
      path,
      definition_line: sourceLine(source, detail.declaration),
    };
  }).filter((caller): caller is StructuralCaller => caller !== null)
    .sort((left, right) => (
      left.depth - right.depth
      || stableCompare(left.path, right.path)
      || left.definition_line - right.definition_line
      || stableCompare(left.name, right.name)
    ));

  return {
    callers,
    complete: reasons.size === 0,
    incomplete_reasons: [...reasons].sort(stableCompare),
    source_files_analyzed: sourceFilesAnalyzed,
  };
}
