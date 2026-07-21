#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const require = createRequire(import.meta.url);
const ts = require(join(repoRoot, 'v2', 'node_modules', 'typescript', 'lib', 'typescript.js'));
const specPath = join(here, 'tasks.json');

function parseArgs(argv) {
  const result = { command: argv[2] ?? 'help' };
  for (let index = 3; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2).replaceAll('-', '_');
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function trackedTypeScript(checkout) {
  return execFileSync(
    'git',
    ['-C', checkout, 'ls-files', '-z', '--', '*.ts', '*.tsx'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).split('\0').filter(Boolean).map((path) => resolve(checkout, path));
}

function repositoryPath(checkout, path) {
  return relative(checkout, path).replaceAll('\\', '/');
}

function isProductionPath(path) {
  const normalized = path.replaceAll('\\', '/');
  return !(
    /(^|\/)(?:tests|__tests__)(\/|$)/.test(normalized)
    || (/(^|\/)test(\/|$)/.test(normalized) && !/(^|\/)src\/.*\/test(\/|$)/.test(normalized))
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized)
    || /(^|\/)node_modules(\/|$)/.test(normalized)
  );
}

function buildAnalysis(target) {
  const rootNames = trackedTypeScript(target.checkout);
  let configured = {};
  const configPath = join(target.checkout, 'tsconfig.json');
  if (existsSync(configPath)) {
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
    configured = ts.parseJsonConfigFileContent(loaded.config, ts.sys, target.checkout).options;
  }
  const paths = { ...(configured.paths ?? {}) };
  if (target.id === 'large') {
    paths['@playwright/experimental-ct-core'] = ['./packages/playwright-ct-core/index.d.ts'];
    paths['playwright/test'] = ['./packages/playwright/types/test.d.ts'];
    paths['playwright/types/*'] = ['./packages/playwright/types/*'];
  }
  const program = ts.createProgram({
    rootNames,
    options: {
      ...configured,
      allowImportingTsExtensions: true,
      allowJs: false,
      baseUrl: configured.baseUrl ?? target.checkout,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
      paths,
    },
  });
  return { target, program, checker: program.getTypeChecker() };
}

function canonicalSymbol(checker, symbol) {
  let current = symbol;
  const seen = new Set();
  while (current && (current.flags & ts.SymbolFlags.Alias) && !seen.has(current)) {
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
}

function symbolAt(checker, node) {
  return canonicalSymbol(checker, checker.getSymbolAtLocation(node));
}

function symbolKey(checker, symbol) {
  const canonical = canonicalSymbol(checker, symbol);
  if (!canonical) return null;
  const roots = typeof checker.getRootSymbols === 'function' ? checker.getRootSymbols(canonical) : [];
  const identitySymbols = roots.length ? roots : [canonical];
  const declarations = identitySymbols.flatMap((identity) => (
    identity.declarations ?? (identity.valueDeclaration ? [identity.valueDeclaration] : [])
  ));
  if (declarations.length) {
    return declarations.map((declaration) => {
      const source = declaration.getSourceFile();
      return `${source.fileName.replaceAll('\\', '/')}:${declaration.pos}:${declaration.end}`;
    }).sort().join('|');
  }
  return `synthetic:${canonical.flags}:${analysisSafeFullyQualifiedName(checker, canonical)}`;
}

function analysisSafeFullyQualifiedName(checker, symbol) {
  try {
    return checker.getFullyQualifiedName(symbol);
  } catch {
    return symbol.getName();
  }
}

function declarationName(node) {
  return node.name && ts.isIdentifier(node.name) ? node.name : null;
}

function matchesDeclarationKind(node, kind) {
  if (!kind) return true;
  if (kind === 'function') return ts.isFunctionDeclaration(node);
  if (kind === 'type') return ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node);
  if (kind === 'class') return ts.isClassDeclaration(node);
  if (kind === 'method') return ts.isMethodDeclaration(node);
  throw new Error(`Unknown declaration kind: ${kind}`);
}

function targetSymbol(analysis, derivation) {
  const absolute = resolve(analysis.target.checkout, derivation.declaration);
  const source = analysis.program.getSourceFile(absolute);
  if (!source) throw new Error(`Declaration source is not in the program: ${derivation.declaration}`);
  const matches = [];
  function visit(node) {
    const name = declarationName(node);
    const location = name ? sourceLocation(analysis.target, name) : null;
    if (
      name?.text === derivation.symbol
      && matchesDeclarationKind(node, derivation.declaration_kind)
      && (!derivation.declaration_line || location.line === derivation.declaration_line)
    ) matches.push(symbolAt(analysis.checker, name));
    ts.forEachChild(node, visit);
  }
  visit(source);
  const unique = [...new Map(matches.filter(Boolean).map((symbol) => [symbolKey(analysis.checker, symbol), symbol])).values()];
  if (unique.length !== 1) {
    throw new Error(`${derivation.declaration}#${derivation.symbol}: expected one symbol, found ${unique.length}`);
  }
  return unique[0];
}

function sourceLocation(target, node) {
  const source = node.getSourceFile();
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return {
    path: repositoryPath(target.checkout, source.fileName),
    line: line + 1,
    column: character + 1,
  };
}

function namedCallableSymbol(checker, node) {
  let current = node;
  while (current) {
    if (
      ts.isFunctionDeclaration(current)
      || ts.isMethodDeclaration(current)
      || ts.isGetAccessorDeclaration(current)
      || ts.isSetAccessorDeclaration(current)
    ) {
      const name = declarationName(current);
      if (name) return { symbol: symbolAt(checker, name), name: name.text, declaration: current };
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (current.name && ts.isIdentifier(current.name)) {
        return { symbol: symbolAt(checker, current.name), name: current.name.text, declaration: current };
      }
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return { symbol: symbolAt(checker, parent.name), name: parent.name.text, declaration: current };
      }
      if (ts.isPropertyAssignment(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))) {
        return { symbol: symbolAt(checker, parent.name), name: parent.name.text, declaration: current };
      }
    }
    current = current.parent;
  }
  return null;
}

function calleeSymbol(checker, expression) {
  if (ts.isIdentifier(expression)) return symbolAt(checker, expression);
  if (ts.isPropertyAccessExpression(expression)) return symbolAt(checker, expression.name);
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
    return symbolAt(checker, expression.argumentExpression);
  }
  return null;
}

function includePath(path, derivation) {
  if (!isProductionPath(path)) return false;
  if (derivation.include_prefixes?.length && !derivation.include_prefixes.some((prefix) => path.startsWith(prefix))) return false;
  if (derivation.exclude_prefixes?.some((prefix) => path.startsWith(prefix))) return false;
  return true;
}

function analyzeCalls(analysis, derivation) {
  const reverse = new Map();
  const callSites = new Map();
  for (const source of analysis.program.getSourceFiles()) {
    const path = repositoryPath(analysis.target.checkout, source.fileName);
    if (!includePath(path, derivation)) continue;
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const callee = calleeSymbol(analysis.checker, node.expression);
        const caller = namedCallableSymbol(analysis.checker, node);
        if (callee) {
          const calleeKey = symbolKey(analysis.checker, callee);
          if (caller?.symbol) {
            const callerKey = symbolKey(analysis.checker, caller.symbol);
            if (!reverse.has(calleeKey)) reverse.set(calleeKey, new Map());
            reverse.get(calleeKey).set(callerKey, caller);
          }
          if (!callSites.has(calleeKey)) callSites.set(calleeKey, []);
          callSites.get(calleeKey).push({ caller, call: node });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { reverse, callSites };
}

function transitiveCallers(analysis, derivation) {
  const origin = targetSymbol(analysis, derivation);
  const originKey = symbolKey(analysis.checker, origin);
  const { reverse } = analyzeCalls(analysis, derivation);
  const depths = new Map([[originKey, 0]]);
  const details = new Map();
  const queue = [originKey];
  while (queue.length) {
    const callee = queue.shift();
    const nextDepth = depths.get(callee) + 1;
    for (const [callerKey, caller] of reverse.get(callee)?.entries() ?? []) {
      if (!depths.has(callerKey) || nextDepth < depths.get(callerKey)) {
        depths.set(callerKey, nextDepth);
        details.set(callerKey, caller);
        queue.push(callerKey);
      }
    }
  }
  const rows = [...details.entries()].map(([key, detail]) => {
    const location = sourceLocation(analysis.target, detail.declaration);
    return { depth: depths.get(key), name: detail.name, ...location };
  }).filter((row) => row.depth <= (derivation.max_depth ?? Number.POSITIVE_INFINITY));
  rows.sort((left, right) => left.depth - right.depth
    || left.path.localeCompare(right.path)
    || left.line - right.line
    || left.name.localeCompare(right.name));
  return rows.map((row) => `${row.depth}|${row.name}@${row.path}:${row.line}`);
}

function directCallerSites(analysis, derivation) {
  const origin = targetSymbol(analysis, derivation);
  const { callSites } = analyzeCalls(analysis, derivation);
  const rows = (callSites.get(symbolKey(analysis.checker, origin)) ?? []).map(({ call }) => {
    const location = sourceLocation(analysis.target, call);
    if (derivation.location_format === 'path_line') return `${location.path}:${location.line}`;
    return `${location.path}:${location.line}:${location.column}`;
  });
  return rows.sort();
}

function symbolReferenceFiles(analysis, derivation) {
  const origin = targetSymbol(analysis, derivation);
  const originKey = symbolKey(analysis.checker, origin);
  const files = new Set();
  for (const source of analysis.program.getSourceFiles()) {
    const path = repositoryPath(analysis.target.checkout, source.fileName);
    if (!includePath(path, derivation)) continue;
    function visit(node) {
      if (ts.isIdentifier(node) && symbolKey(analysis.checker, symbolAt(analysis.checker, node)) === originKey) files.add(path);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return [...files].sort();
}

function namedTypeDeclaration(node) {
  return (
    ts.isTypeAliasDeclaration(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isEnumDeclaration(node)
  ) && declarationName(node);
}

function transitiveTypeReferenceFiles(analysis, derivation) {
  const origin = targetSymbol(analysis, derivation);
  const originKey = symbolKey(analysis.checker, origin);
  const reverseDependencies = new Map();

  for (const source of analysis.program.getSourceFiles()) {
    const path = repositoryPath(analysis.target.checkout, source.fileName);
    if (!includePath(path, derivation)) continue;
    function visitDeclaration(node) {
      const name = namedTypeDeclaration(node);
      if (name) {
        const dependent = symbolKey(analysis.checker, symbolAt(analysis.checker, name));
        const dependencies = new Set();
        function visitType(nodeWithinDeclaration) {
          if (nodeWithinDeclaration !== name && ts.isIdentifier(nodeWithinDeclaration)) {
            const referenced = symbolKey(analysis.checker, symbolAt(analysis.checker, nodeWithinDeclaration));
            if (referenced && referenced !== dependent) dependencies.add(referenced);
          }
          ts.forEachChild(nodeWithinDeclaration, visitType);
        }
        visitType(node);
        for (const dependency of dependencies) {
          if (!reverseDependencies.has(dependency)) reverseDependencies.set(dependency, new Set());
          reverseDependencies.get(dependency).add(dependent);
        }
      }
      ts.forEachChild(node, visitDeclaration);
    }
    visitDeclaration(source);
  }

  const impacted = new Set([originKey]);
  const queue = [originKey];
  while (queue.length) {
    const dependency = queue.shift();
    for (const dependent of reverseDependencies.get(dependency) ?? []) {
      if (impacted.has(dependent)) continue;
      impacted.add(dependent);
      queue.push(dependent);
    }
  }

  const files = new Set();
  for (const source of analysis.program.getSourceFiles()) {
    const path = repositoryPath(analysis.target.checkout, source.fileName);
    if (!includePath(path, derivation)) continue;
    function visitReference(node) {
      if (ts.isIdentifier(node) && impacted.has(symbolKey(analysis.checker, symbolAt(analysis.checker, node)))) files.add(path);
      ts.forEachChild(node, visitReference);
    }
    visitReference(source);

    function visitStarExports(node) {
      if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier) {
        const moduleSymbol = analysis.checker.getSymbolAtLocation(node.moduleSpecifier);
        if (moduleSymbol) {
          const exported = analysis.checker.getExportsOfModule(moduleSymbol);
          if (exported.some((symbol) => impacted.has(symbolKey(analysis.checker, symbol)))) files.add(path);
        }
      }
      ts.forEachChild(node, visitStarExports);
    }
    visitStarExports(source);
  }
  return [...files].sort();
}

function derive(analysis, derivation) {
  if (derivation.kind === 'transitive_callers') return transitiveCallers(analysis, derivation);
  if (derivation.kind === 'direct_caller_sites') return directCallerSites(analysis, derivation);
  if (derivation.kind === 'symbol_reference_files') return symbolReferenceFiles(analysis, derivation);
  if (derivation.kind === 'transitive_type_reference_files') return transitiveTypeReferenceFiles(analysis, derivation);
  throw new Error(`Unknown derivation kind: ${derivation.kind}`);
}

function selectedTasks(spec, options) {
  const tasks = [];
  for (const target of spec.targets) {
    if (options.target && options.target !== 'all' && options.target !== target.id) continue;
    for (const task of target.tasks) {
      if (options.task && options.task !== task.id) continue;
      if (task.derivation) tasks.push({ target, task });
    }
  }
  return tasks;
}

function main() {
  const options = parseArgs(process.argv);
  if (!['inspect', 'derive', 'verify'].includes(options.command)) {
    console.log('Usage: node derive-structural-references.mjs inspect --target small|large --kind <kind> --declaration <path> --symbol <name> [--include-prefixes a,b]');
    console.log('       node derive-structural-references.mjs derive|verify [--target small|large|all] [--task T01]');
    return;
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  if (options.command === 'inspect') {
    const target = spec.targets.find((item) => item.id === options.target);
    if (!target) throw new Error('--target must identify one configured target.');
    if (!options.kind || !options.declaration || !options.symbol) {
      throw new Error('inspect requires --kind, --declaration, and --symbol.');
    }
    const derivation = {
      kind: options.kind,
      declaration: options.declaration,
      symbol: options.symbol,
      declaration_kind: options.declaration_kind,
      declaration_line: options.declaration_line ? Number(options.declaration_line) : undefined,
      include_prefixes: options.include_prefixes?.split(',').filter(Boolean),
      exclude_prefixes: options.exclude_prefixes?.split(',').filter(Boolean),
      max_depth: options.max_depth ? Number(options.max_depth) : undefined,
      location_format: options.location_format,
    };
    const answer = derive(buildAnalysis(target), derivation);
    console.log(JSON.stringify({ target: target.id, derivation, answer }, null, 2));
    return;
  }
  const analyses = new Map();
  const results = [];
  for (const { target, task } of selectedTasks(spec, options)) {
    if (!analyses.has(target.id)) analyses.set(target.id, buildAnalysis(target));
    const answer = derive(analyses.get(target.id), task.derivation);
    const matches = JSON.stringify(answer) === JSON.stringify(task.answer);
    results.push({ target: target.id, task: task.id, answer, matches });
    if (options.command === 'verify' && !matches) process.exitCode = 1;
  }
  console.log(JSON.stringify({ method: 'typescript-compiler-api-symbol-identity', results }, null, 2));
  if (results.length === 0) throw new Error('No tasks with derivation metadata matched the selection.');
}

export { buildAnalysis, derive, isProductionPath };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
