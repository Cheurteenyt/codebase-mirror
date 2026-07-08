// Benchmark node.id overhead vs TSNode Map key
import { Parser, Language } from 'web-tree-sitter';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';

const require2 = createRequire(import.meta.url);
function getWasmPath(lang: string): string {
  const pkgPath = require2.resolve('tree-sitter-wasm/manifest.json');
  return join(dirname(pkgPath), 'out', lang, `tree-sitter-${lang}.wasm`);
}

async function main() {
  await Parser.init();
  const parser = new Parser();
  const language = await Language.load(getWasmPath('typescript'));
  parser.setLanguage(language);

  const source = readFileSync('src/indexer/fast-walker.ts', 'utf-8');
  const tree = parser.parse(source)!;
  const root = tree.rootNode;

  const FUNCTION_TYPES = ['function_declaration', 'function_definition', 'function', 'arrow_function', 'generator_function_declaration', 'generator_function'];
  const allFunctions = root.descendantsOfType(FUNCTION_TYPES);

  // Test 1: Map<TSNode, string> (old broken approach — works when same reference)
  const mapByRef = new Map<object, string>();
  const t1Start = process.hrtime.bigint();
  for (let iter = 0; iter < 10000; iter++) {
    for (const func of allFunctions) {
      mapByRef.set(func, 'qn');
    }
    for (const func of allFunctions) {
      mapByRef.get(func);
    }
  }
  const t1End = process.hrtime.bigint();
  console.log(`Map<TSNode> (same reference): ${Number(t1End - t1Start) / 1e6}ms for 10000 iterations`);

  // Test 2: Map<number, string> keyed by node.id (new approach)
  const mapById = new Map<number, string>();
  const t2Start = process.hrtime.bigint();
  for (let iter = 0; iter < 10000; iter++) {
    for (const func of allFunctions) {
      mapById.set(func.id, 'qn');
    }
    for (const func of allFunctions) {
      mapById.get(func.id);
    }
  }
  const t2End = process.hrtime.bigint();
  console.log(`Map<number> (by node.id): ${Number(t2End - t2Start) / 1e6}ms for 10000 iterations`);

  const overhead = (Number(t2End - t2Start) - Number(t1End - t1Start)) / 10000 / allFunctions.length;
  console.log(`Overhead of node.id per lookup: ${overhead.toFixed(2)}ns`);
  console.log(`(14 functions × 10000 iters × 2 ops = ${14 * 10000 * 2} operations)`);

  tree.delete();
}

main();
