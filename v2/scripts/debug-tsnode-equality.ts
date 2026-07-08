// Debug: verify TSNode reference equality issue.
// If TSNode objects from descendantsOfType() and .parent are NOT reference-equal,
// then Map<TSNode, string> lookups always fail, breaking findParentQnFast and
// findEnclosingDeclQnFast.

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
  const tree = parser.parse(source);
  if (!tree) { console.log('parse failed'); return; }

  const root = tree.rootNode;

  // Get all function_declaration nodes
  const FUNCTION_TYPES = ['function_declaration', 'function_definition', 'function', 'arrow_function', 'generator_function_declaration', 'generator_function'];
  const allFunctions = root.descendantsOfType(FUNCTION_TYPES);

  console.log(`Found ${allFunctions.length} function nodes via descendantsOfType()`);

  // Pick the extractFast function_declaration (it has many calls inside)
  const funcFromDescendants = allFunctions.find(f => 
    f.type === 'function_declaration' && f.childForFieldName('name')?.text === 'extractFast'
  );
  if (!funcFromDescendants) { console.log('No extractFast function_declaration found'); return; }

  console.log(`\nTest function: ${funcFromDescendants.childForFieldName('name')?.text}`);
  console.log(`  TSNode from descendantsOfType(): id=${funcFromDescendants.id}`);

  // Now walk down into this function and find a call_expression inside it,
  // then walk back up with .parent to see if we reach the same TSNode
  const calls = funcFromDescendants.descendantsOfType(['call_expression']);
  if (calls.length === 0) { console.log('No calls inside function'); return; }

  const call = calls[0];
  console.log(`\nCall inside function: "${call.childForFieldName('function')?.text}" at line ${call.startPosition.row + 1}`);

  // Walk up from call to find function_declaration
  let parent = call.parent;
  let foundViaParent = null;
  while (parent) {
    if (FUNCTION_TYPES.includes(parent.type)) {
      foundViaParent = parent;
      break;
    }
    parent = parent.parent;
  }

  if (!foundViaParent) {
    console.log('  ✗ Walking up via .parent found NO function ancestor!');
  } else {
    console.log(`  Found function via .parent: ${foundViaParent.childForFieldName('name')?.text}`);
    console.log(`  TSNode from .parent: id=${foundViaParent.id}`);

    // Check reference equality
    const sameReference = funcFromDescendants === foundViaParent;
    console.log(`\n  Reference equality (===): ${sameReference}`);

    // Check if Map lookup works
    const testMap = new Map();
    testMap.set(funcFromDescendants, 'QN_VALUE');
    const lookup = testMap.get(foundViaParent);
    console.log(`  Map.get() returns: ${lookup ?? '(undefined — BUG!)'}`);

    // Check .equals() method if available
    if (typeof funcFromDescendants.equals === 'function') {
      console.log(`  .equals() method: ${funcFromDescendants.equals(foundViaParent)}`);
    } else {
      console.log('  TSNode has no .equals() method');
    }

    // Check if id is the same
    console.log(`  Same .id? ${funcFromDescendants.id === foundViaParent.id}`);
  }

  tree.delete();
}

main().catch(console.error);
