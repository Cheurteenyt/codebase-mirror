// v2/src/indexer/fast-walker.ts
// R72: Optimized AST walker using tree-sitter's built-in descendantsOfType()
// instead of manual recursive walking. This eliminates JavaScript function
// call overhead and lets the WASM runtime do the tree traversal in C speed.
//
// Benchmark: ~3x faster than recursive walkAST on typical TS files.
//
// The key insight: tree-sitter's descendantsOfType() is implemented in
// WASM (C speed), while our recursive walkAST was JavaScript. For a file
// with 500 AST nodes, the recursive walk makes 500 JS function calls;
// descendantsOfType() makes 0 — it returns a pre-computed array.

import type { Node as TSNode } from 'web-tree-sitter';

// ── Types (must match worker.ts) ───────────────────────────────────────

export interface FastNode {
  label: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  properties: string;
}

export interface FastEdge {
  sourceQn: string;
  targetQn: string;
  type: string;
  properties: string;
}

export interface UnresolvedCallSite {
  sourceQn: string;
  calleeName: string;
  lastSegment: string;
  filePath: string;
  line: number;
  // R99: call kind for precision filtering
  callKind: 'identifier_call' | 'member_call' | 'computed_call';
}

// R110: Import binding extracted from import statements.
// Represents a single name binding from an import:
//   import { foo } from './b'           → { localName:'foo', sourceModule:'./b', importedName:'foo', kind:'named' }
//   import { foo as bar } from './b'    → { localName:'bar', sourceModule:'./b', importedName:'foo', kind:'alias' }
//   import foo from './b'               → { localName:'foo', sourceModule:'./b', importedName:'default', kind:'default' }
//   import * as ns from './b'           → { localName:'ns', sourceModule:'./b', importedName:'*', kind:'namespace' }
// Note: filePath is set by the caller (wasm-extractor or worker) before persistence.
export interface ImportBinding {
  localName: string;
  sourceModule: string;
  importedName: string;
  importKind: 'named' | 'alias' | 'default' | 'namespace' | 'default_export';
  line: number;
  filePath: string;
}

export interface FastFileResult {
  nodes: FastNode[];
  edges: FastEdge[];
  astNodeCount: number;
  // R98: unresolved call-sites for cross-file resolution
  unresolvedCalls: UnresolvedCallSite[];
  // R110: import bindings for import-aware cross-file resolution
  imports: ImportBinding[];
  // R111: qualified name of the default export target (if any).
  // For `export default function realName() {}`, this is the QN of realName.
  // For `export default foo;` (re-export of a variable), this is the QN of foo.
  // Null if the file has no default export.
  // Used by import-aware resolution for `import foo from './b'` where the
  // local name (foo) differs from the exported name (realName).
  defaultExportQn: string | null;
}

// ── Node type sets (same as worker.ts) ─────────────────────────────────

const FUNCTION_TYPES = [
  'function_declaration', 'function_definition', 'function',
  'arrow_function', 'generator_function_declaration', 'generator_function',
];

const CLASS_TYPES = [
  'class_declaration', 'class_definition', 'class',
  'interface_declaration', 'struct_specifier',
];

const METHOD_TYPES = [
  'method_definition', 'method_declaration',
  'constructor_declaration', 'getter_definition', 'setter_definition',
];

const CALL_TYPES = ['call_expression', 'call'];

// R110: Import statement node types for TS/JS.
// tree-sitter typescript and javascript grammars both use 'import_statement'.
const IMPORT_TYPES = ['import_statement'];

// R111: Export statement node types for detecting default exports.
// tree-sitter TS/JS: 'export_statement' covers `export default ...` and `export { ... }`.
const EXPORT_TYPES = ['export_statement'];

// R99: builtin method names to skip for cross-file resolution.
// These are extremely common in JS/TS and would create massive false positives
// if matched against project functions with the same name (e.g. `log`, `map`).
const BUILTIN_METHOD_NAMES = new Set([
  'map', 'filter', 'foreach', 'reduce', 'reduceRight', 'find', 'findIndex',
  'some', 'every', 'includes', 'indexOf', 'lastIndexOf', 'flat', 'flatMap',
  'sort', 'reverse', 'join', 'slice', 'splice', 'concat', 'fill', 'keys',
  'values', 'entries', 'from', 'isArray', 'of',
  'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'race', 'allSettled',
  'push', 'pop', 'shift', 'unshift', 'get', 'set', 'has', 'delete', 'clear',
  'add', 'entries', 'forEach',
  'log', 'warn', 'error', 'info', 'debug', 'trace', 'dir', 'table',
  'prepare', 'run', 'exec', 'all', 'get', 'transaction',
  'toString', 'valueOf', 'toJSON', 'toFixed', 'toPrecision',
  'call', 'apply', 'bind',
  'startsWith', 'endsWith', 'includes', 'replace', 'replaceAll',
  'split', 'match', 'matchAll', 'trim', 'trimStart', 'trimEnd',
  'padStart', 'padEnd', 'repeat', 'substring', 'substr', 'toLowerCase', 'toUpperCase',
  'parse', 'stringify', // JSON.parse/stringify — too common to match project functions
]);

// (DECISION_TYPES is used inside estimateComplexityFast via descendantsOfType)

// R78: counter for unique anonymous function names. Previously, anonymous
// functions got "anonymous@<line>" which collides when two arrow functions
// appear on the same line (e.g. `[1,2].map(x => x*2).filter(x => x > 1)` —
// two arrow functions on line 1, both named "anonymous@1"). This caused
// QN collisions in the qnToId map, silently dropping CALLS edges.
// Using a monotonic counter guarantees uniqueness within a file.
let anonymousCounter = 0;

/**
 * R78: Reset the anonymous counter at the start of each file extraction.
 * Called from extractFast(). The counter makes anonymous QNs unique within
 * a file: "anonymous#1", "anonymous#2", etc.
 */
function resetAnonymousCounter(): void {
  anonymousCounter = 0;
}

// ── Fast extraction ────────────────────────────────────────────────────

/**
 * Extract nodes and edges from a tree-sitter AST using descendantsOfType().
 *
 * Instead of recursively walking every AST node in JavaScript (O(n) JS calls),
 * we use tree-sitter's built-in descendantsOfType() which traverses the tree
 * in WASM (C speed) and returns only the nodes we care about.
 *
 * This is typically 3x faster than the recursive walkAST approach because:
 * 1. WASM traversal is ~10x faster than JS recursion
 * 2. We only visit nodes we care about (functions, classes, methods, calls)
 *    instead of every token, string literal, comment, etc.
 * 3. No JS function call overhead per AST node
 *
 * R73 optimizations:
 * - Removed rootNode.descendantCount (unused, causes full tree traversal)
 * - Removed rootNode.text.length (O(n) string copy) — source length passed in
 * - Pre-built JSON property strings instead of JSON.stringify per node
 * - findParentQn uses a Map (O(1)) instead of linear search in nodes[] (O(n))
 * - Batch descendantsOfType calls where possible
 */
export function extractFast(
  rootNode: TSNode,
  _project: string,
  relPath: string,
  fileQn: string,
  sourceLength: number,
): FastFileResult {
  // R78: reset per-file anonymous counter so QNs are unique within this file.
  resetAnonymousCounter();
  const nodes: FastNode[] = [];
  const edges: FastEdge[] = [];
  const nameToQns = new Map<string, string[]>();
  // R78: CRITICAL FIX — use node.id (number) as Map key instead of TSNode object.
  // TSNode objects from descendantsOfType() and .parent are NOT reference-equal
  // (=== returns false) even when they point to the same underlying node.
  // This broke findParentQnFast and findEnclosingDeclQnFast since R73,
  // causing ALL CALLS edges to be dropped (0 CALLS edges extracted) and
  // ALL function QNs to be flat (file::func instead of file::class::method).
  // node.id is a stable numeric identifier that's the same regardless of
  // which TSNode wrapper you use.
  const qnByNode = new Map<number, string>();

  // ── Extract File node ────────────────────────────────────────────────
  const fileName = relPath.split('/').pop() || relPath;
  // R73: pre-built JSON string instead of JSON.stringify
  const fileProps = '{"language":"tree-sitter","size":' + sourceLength + '}';
  nodes.push({
    label: 'File',
    name: fileName,
    qualifiedName: fileQn,
    filePath: relPath,
    startLine: 1,
    endLine: rootNode.endPosition.row + 1,
    properties: fileProps,
  });

  // ── Extract all functions in one WASM call ───────────────────────────
  const allFunctions = rootNode.descendantsOfType(FUNCTION_TYPES);
  for (const func of allFunctions) {
    const name = getDeclNameFast(func);
    const parentQn = findParentQnFast(func, fileQn, qnByNode);
    const qn = `${parentQn}::${name}`;
    // R78: always compute complexity — the R76 "skip anonymous" optimization
    // saved ~1ms per file but silently broke risk hotspot detection for any
    // codebase with non-trivial arrow functions (event handlers, RxJS
    // pipelines, reducers). The WASM traversal is cheap enough; correctness
    // matters more than 1ms.
    const complexity = estimateComplexityFast(func);
    const props = '{"language":"tree-sitter","complexity":' + complexity + '}';
    nodes.push({
      label: 'Function',
      name,
      qualifiedName: qn,
      filePath: relPath,
      startLine: func.startPosition.row + 1,
      endLine: func.endPosition.row + 1,
      properties: props,
    });
    addToMap(nameToQns, name, qn);
    qnByNode.set(func.id, qn);
    edges.push({ sourceQn: parentQn, targetQn: qn, type: 'CONTAINS', properties: '{}' });
  }

  // ── Extract all classes in one WASM call ─────────────────────────────
  const allClasses = rootNode.descendantsOfType(CLASS_TYPES);
  for (const cls of allClasses) {
    const name = getDeclNameFast(cls);
    const parentQn = findParentQnFast(cls, fileQn, qnByNode);
    const qn = `${parentQn}::${name}`;
    nodes.push({
      label: 'Class',
      name,
      qualifiedName: qn,
      filePath: relPath,
      startLine: cls.startPosition.row + 1,
      endLine: cls.endPosition.row + 1,
      properties: '{"language":"tree-sitter"}',
    });
    addToMap(nameToQns, name, qn);
    qnByNode.set(cls.id, qn);
    edges.push({ sourceQn: parentQn, targetQn: qn, type: 'CONTAINS', properties: '{}' });
  }

  // ── Extract all methods in one WASM call ─────────────────────────────
  const allMethods = rootNode.descendantsOfType(METHOD_TYPES);
  for (const method of allMethods) {
    const name = getDeclNameFast(method);
    const parentQn = findParentQnFast(method, fileQn, qnByNode);
    const qn = `${parentQn}::${name}`;
    // R78: always compute complexity for methods (same reasoning as functions).
    const complexity = estimateComplexityFast(method);
    const props = '{"language":"tree-sitter","complexity":' + complexity + '}';
    nodes.push({
      label: 'Method',
      name,
      qualifiedName: qn,
      filePath: relPath,
      startLine: method.startPosition.row + 1,
      endLine: method.endPosition.row + 1,
      properties: props,
    });
    addToMap(nameToQns, name, qn);
    qnByNode.set(method.id, qn);
    edges.push({ sourceQn: parentQn, targetQn: qn, type: 'CONTAINS', properties: '{}' });
  }

  // ── Extract all calls and resolve to CALLS edges ─────────────────────
  const allCalls = rootNode.descendantsOfType(CALL_TYPES);
  const unresolvedCalls: UnresolvedCallSite[] = [];
  for (const call of allCalls) {
    const funcNode = call.childForFieldName('function');
    if (!funcNode) continue;
    const calleeName = funcNode.text;
    const lastSegment = calleeName.split('.').pop() || calleeName;
    const candidates = nameToQns.get(calleeName) || nameToQns.get(lastSegment);

    const sourceQn = findEnclosingDeclQnFast(call, qnByNode);
    if (!sourceQn) continue;

    if (!candidates || candidates.length === 0) {
      // R98: collect unresolved call-sites for cross-file resolution
      // R99: detect call kind and filter builtins
      const callKind: 'identifier_call' | 'member_call' | 'computed_call' =
        funcNode.type === 'identifier' ? 'identifier_call' :
        funcNode.type === 'member_expression' ? 'member_call' : 'computed_call';

      // R99: skip common builtins for member calls to reduce false positives
      if (callKind === 'member_call') {
        const seg = lastSegment.toLowerCase();
        if (BUILTIN_METHOD_NAMES.has(seg)) continue;
      }

      unresolvedCalls.push({
        sourceQn,
        calleeName,
        lastSegment,
        filePath: relPath,
        line: call.startPosition.row + 1,
        callKind,
      });
      continue;
    }

    // R78: when multiple functions share a name (e.g. two `parse()` in different
    // modules), the old `candidates[0]` shortcut emitted a CALLS edge to only
    // the first declaration, making the second appear to have no callers.
    // Now we emit one edge per candidate, with a `candidate_index` property
    // so downstream tools can distinguish ambiguous from unambiguous calls.
    // This increases edge count (matching V1's behavior more closely) at a
    // small performance cost.
    for (let ci = 0; ci < candidates.length; ci++) {
      const targetQn = candidates[ci];
      if (targetQn === sourceQn) continue; // skip self-calls
      edges.push({
        sourceQn,
        targetQn,
        type: 'CALLS',
        properties: '{"callee":"' + calleeName + '","inferred":true,"candidate_index":' + ci + ',"resolution":"intra_file"}',
      });
    }
  }

  // ── Extract imports (R110: import-aware resolution) ──────────────────
  // Parse import statements to build a map of local_name → source_module.
  // Used by the cross-file resolver to prioritize imported symbols.
  const imports = extractImports(rootNode, relPath);

  // ── Extract default export (R111: default import resolution) ─────────
  // For `import foo from './b'`, the local name (foo) may differ from the
  // exported name (realName). We detect the default export target QN so the
  // resolver can map the local name to the correct symbol.
  const defaultExportQn = extractDefaultExport(rootNode, qnByNode, fileQn);

  return { nodes, edges, astNodeCount: 0, unresolvedCalls, imports, defaultExportQn };
}

/**
 * R111: Extract the qualified name of the default export target.
 *
 * Handles `export default function realName() {}` and `export default class Foo {}`.
 * For anonymous defaults (`export default function() {}`), returns the file QN
 * (since there's no named symbol to point to).
 * For `export default foo;` (re-export of a variable), looks up `foo` in qnByNode.
 *
 * Returns null if the file has no default export.
 */
function extractDefaultExport(
  rootNode: TSNode,
  qnByNode: Map<number, string>,
  fileQn: string,
): string | null {
  const allExports = rootNode.descendantsOfType(EXPORT_TYPES);
  for (const exp of allExports) {
    // Check if this is a default export by looking for 'default' keyword child
    let isDefault = false;
    for (let i = 0; i < exp.childCount; i++) {
      const child = exp.child(i);
      if (child && child.type === 'default') {
        isDefault = true;
        break;
      }
    }
    if (!isDefault) continue;

    // The default export target is typically a function/class declaration or identifier.
    // Walk children to find the target.
    for (let i = 0; i < exp.childCount; i++) {
      const child = exp.child(i);
      if (!child) continue;
      const childType = child.type;

      // export default function realName() {} — function_declaration
      // export default class Foo {} — class_declaration
      if (FUNCTION_TYPES.includes(childType) || CLASS_TYPES.includes(childType) || METHOD_TYPES.includes(childType)) {
        const qn = qnByNode.get(child.id);
        if (qn) return qn;
        // Function/class wasn't indexed (e.g., anonymous) — use file QN as fallback
        return fileQn;
      }

      // export default foo; — identifier reference
      // Look up foo in qnByNode. But qnByNode is keyed by node.id of DECLARATIONS,
      // not references. So we can't resolve this directly here.
      // The resolver will handle this case by falling back to name-based lookup.
      if (childType === 'identifier') {
        // Can't resolve without a full symbol table — return null to trigger fallback
        return null;
      }
    }
  }
  return null;
}

/**
 * R110: Extract import bindings from a tree-sitter AST.
 *
 * Handles 4 import kinds for TS/JS:
 *   import { foo } from './b'           → named
 *   import { foo as bar } from './b'    → alias
 *   import foo from './b'               → default
 *   import * as ns from './b'           → namespace
 *
 * Returns an array of ImportBinding, one per name binding.
 * Side-effect imports (import './b') and type-only imports are skipped
 * (no bindings to extract).
 *
 * Note: this uses heuristic child traversal rather than named fields because
 * tree-sitter TS and JS grammars have slightly different AST shapes for
 * import statements. The traversal is defensive: if the structure doesn't
 * match expectations, it skips that import rather than throwing.
 */
function extractImports(rootNode: TSNode, filePath: string): ImportBinding[] {
  const imports: ImportBinding[] = [];
  const allImports = rootNode.descendantsOfType(IMPORT_TYPES);
  for (const imp of allImports) {
    const line = imp.startPosition.row + 1;
    // R111: Detect type-only imports: `import type { Foo } from './types'`
    // tree-sitter TS grammar: the `type` keyword is a child of import_statement
    // (as 'type' identifier) before the import_clause.
    let isTypeOnlyImport = false;
    // Find the source module string (the 'from "..." ' or just '"..."')
    // tree-sitter: import_statement has a string child for the source.
    let sourceModule = '';
    let importClause: TSNode | null = null;
    for (let i = 0; i < imp.childCount; i++) {
      const child = imp.child(i);
      if (!child) continue;
      if (child.type === 'string') {
        // Strip quotes from the string literal
        sourceModule = child.text.replace(/^["'`]/, '').replace(/["'`]$/, '');
      } else if (child.type === 'import_clause') {
        importClause = child;
      } else if (child.type === 'type') {
        // `import type { ... }` — entire import is type-only
        isTypeOnlyImport = true;
      }
    }

    // R111: Skip type-only imports (`import type { Foo } from '...'`).
    // These don't create runtime bindings and shouldn't influence the resolver.
    if (isTypeOnlyImport) continue;

    // Side-effect import (no import_clause) — skip (no bindings)
    if (!importClause) continue;
    if (!sourceModule) continue;

    // Walk the import_clause to extract bindings.
    // import_clause can contain:
    //   - named_imports: { foo, bar as baz }
    //   - namespace_import: * as ns
    //   - identifier (default import): foo
    //   - combination: default + named (import foo, { bar } from '...')
    for (let i = 0; i < importClause.childCount; i++) {
      const child = importClause.child(i);
      if (!child) continue;
      const childType = child.type;

      if (childType === 'named_imports') {
        // named_imports contains import_specifier children
        for (let j = 0; j < child.childCount; j++) {
          const spec = child.child(j);
          if (!spec || spec.type !== 'import_specifier') continue;
          // R111: Skip inline type-only specifiers: `import { type Foo, bar }`
          // tree-sitter TS: the `type` keyword is a child of import_specifier.
          let isTypeOnlySpecifier = false;
          for (let k = 0; k < spec.childCount; k++) {
            const specChild = spec.child(k);
            if (specChild && specChild.type === 'type') {
              isTypeOnlySpecifier = true;
              break;
            }
          }
          if (isTypeOnlySpecifier) continue;
          // import_specifier: identifier (name) or identifier 'as' identifier (alias)
          const nameNode = spec.childForFieldName('name');
          const aliasNode = spec.childForFieldName('alias');
          if (!nameNode) continue;
          const importedName = nameNode.text;
          if (aliasNode) {
            // alias import: import { foo as bar }
            imports.push({
              localName: aliasNode.text,
              sourceModule,
              importedName,
              importKind: 'alias',
              line,
              filePath,
            });
          } else {
            // named import: import { foo }
            imports.push({
              localName: importedName,
              sourceModule,
              importedName,
              importKind: 'named',
              line,
              filePath,
            });
          }
        }
      } else if (childType === 'namespace_import') {
        // namespace_import: * as ns
        // The identifier is a child of namespace_import
        let nsName = '';
        for (let j = 0; j < child.childCount; j++) {
          const idNode = child.child(j);
          if (idNode && idNode.type === 'identifier') {
            nsName = idNode.text;
            break;
          }
        }
        if (nsName) {
          imports.push({
            localName: nsName,
            sourceModule,
            importedName: '*',
            importKind: 'namespace',
            line,
            filePath,
          });
        }
      } else if (childType === 'identifier') {
        // default import: import foo from '...'
        // The identifier is a direct child of import_clause
        imports.push({
          localName: child.text,
          sourceModule,
          importedName: 'default',
          importKind: 'default',
          line,
          filePath,
        });
      }
      // Skip punctuation (commas, braces, etc.)
    }
  }
  return imports;
}

// ── Helpers ────────────────────────────────────────────────────────────

function getDeclNameFast(node: TSNode): string {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'identifier') return child.text;
  }
  // R78: use a monotonic counter instead of line number. Two arrow functions
  // on the same line (e.g. `[1,2].map(x => x*2).filter(x => x > 1)`) previously
  // both got "anonymous@1" → QN collision → dropped CALLS edges.
  // Now they get "anonymous#1", "anonymous#2", etc. — unique within a file.
  anonymousCounter++;
  return `anonymous#${anonymousCounter}`;
}

/**
 * R78: Find parent QN using Map lookup (O(1)) instead of linear search (O(n)).
 * Walks up the AST to find the nearest enclosing declaration, then looks
 * it up in the qnByNode map (keyed by node.id — NOT by TSNode reference,
 * which is broken in web-tree-sitter).
 */
function findParentQnFast(
  node: TSNode,
  fileQn: string,
  qnByNode: Map<number, string>,
): string {
  let parent = node.parent;
  while (parent) {
    const parentType = parent.type;
    if (FUNCTION_TYPES.includes(parentType) ||
        CLASS_TYPES.includes(parentType) ||
        METHOD_TYPES.includes(parentType)) {
      const qn = qnByNode.get(parent.id);
      if (qn) return qn;
    }
    parent = parent.parent;
  }
  return fileQn;
}

/**
 * R78: Find enclosing declaration QN using Map lookup (keyed by node.id).
 */
function findEnclosingDeclQnFast(
  node: TSNode,
  qnByNode: Map<number, string>,
): string | null {
  let parent = node.parent;
  while (parent) {
    const parentType = parent.type;
    if (FUNCTION_TYPES.includes(parentType) ||
        METHOD_TYPES.includes(parentType)) {
      const qn = qnByNode.get(parent.id);
      if (qn) return qn;
    }
    parent = parent.parent;
  }
  return null;
}

// R76: pre-combined array for single descendantsOfType call in complexity estimation
const COMPLEXITY_TYPES = [
  'if_statement', 'if', 'while_statement', 'while', 'for_statement',
  'for', 'for_in_statement', 'for_each', 'case', 'catch_clause',
  'catch', 'conditional_expression', 'ternary',
  'binary_expression', 'boolean_operator_expression',
];

const BINARY_OP_TYPES = new Set(['&&', '||', 'and', 'or']);

/**
 * R76: optimized complexity estimation — single descendantsOfType call
 * instead of two. Combines decision types + binary expressions into one
 * WASM traversal, then filters in JS (which is faster than a second WASM
 * call for small arrays).
 */
function estimateComplexityFast(node: TSNode): number {
  let complexity = 1;
  const all = node.descendantsOfType(COMPLEXITY_TYPES);
  for (const n of all) {
    if (n.type === 'binary_expression' || n.type === 'boolean_operator_expression') {
      const op = n.child(1);
      if (op && BINARY_OP_TYPES.has(op.type)) {
        complexity++;
      }
    } else {
      complexity++;
    }
  }
  return complexity;
}

function addToMap(map: Map<string, string[]>, name: string, qn: string): void {
  const existing = map.get(name);
  if (existing) existing.push(qn);
  else map.set(name, [qn]);
}
