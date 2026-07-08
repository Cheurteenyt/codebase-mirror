// Debug script: investigate why V2 extracts 0 CALLS edges on TS code.
// Run: npx tsx scripts/debug-calls.ts

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

  // Use fast-walker.ts as test case (it has function calls)
  const source = readFileSync('src/indexer/fast-walker.ts', 'utf-8');
  const tree = parser.parse(source);
  if (!tree) { console.log('parse failed'); return; }

  const root = tree.rootNode;

  // Count call_expressions
  const CALL_TYPES = ['call_expression', 'call'];
  const allCalls = root.descendantsOfType(CALL_TYPES);
  console.log(`Total call_expressions: ${allCalls.length}`);

  // Show first 10 calls
  console.log('\nFirst 10 calls:');
  for (let i = 0; i < Math.min(10, allCalls.length); i++) {
    const call = allCalls[i];
    const funcNode = call.childForFieldName('function');
    const calleeName = funcNode ? funcNode.text : '(no function field)';
    console.log(`  [${i}] type=${call.type}  callee="${calleeName}"  line=${call.startPosition.row + 1}`);
    // Check if funcNode exists and its type
    if (funcNode) {
      console.log(`       funcNode.type=${funcNode.type}  funcNode.text="${funcNode.text}"`);
    }
  }

  // Count function declarations
  const FUNCTION_TYPES = ['function_declaration', 'function_definition', 'function', 'arrow_function', 'generator_function_declaration', 'generator_function'];
  const allFunctions = root.descendantsOfType(FUNCTION_TYPES);
  console.log(`\nTotal function declarations: ${allFunctions.length}`);

  // Build name→QN map
  const nameToQns = new Map<string, string[]>();
  for (const func of allFunctions) {
    const nameNode = func.childForFieldName('name');
    let name: string;
    if (nameNode) {
      name = nameNode.text;
    } else {
      // Try identifier child
      let found = false;
      for (let i = 0; i < func.childCount; i++) {
        const child = func.child(i);
        if (child && child.type === 'identifier') { name = child.text; found = true; break; }
      }
      if (!found) name = `anonymous@${func.startPosition.row + 1}`;
    }
    const existing = nameToQns.get(name);
    if (existing) existing.push(`qn::${name}`);
    else nameToQns.set(name, [`qn::${name}`]);
  }

  // Check how many calls match a function name
  let matched = 0;
  let unmatched = 0;
  const unmatchedNames = new Set<string>();
  for (const call of allCalls) {
    const funcNode = call.childForFieldName('function');
    if (!funcNode) continue;
    const calleeName = funcNode.text;
    const lastSegment = calleeName.split('.').pop() || calleeName;
    const candidates = nameToQns.get(calleeName) || nameToQns.get(lastSegment);
    if (candidates && candidates.length > 0) {
      matched++;
    } else {
      unmatched++;
      unmatchedNames.add(calleeName);
    }
  }

  console.log(`\nCalls matched to a function: ${matched}`);
  console.log(`Calls unmatched: ${unmatched}`);
  console.log(`\nTop 20 unmatched callee names:`);
  const sorted = [...unmatchedNames].sort();
  for (let i = 0; i < Math.min(20, sorted.length); i++) {
    console.log(`  "${sorted[i]}"`);
  }

  // Check: are there ANY calls that should match?
  console.log(`\nFunction names in nameToQns:`);
  for (const [name, qns] of nameToQns) {
    if (!name.startsWith('anonymous')) {
      console.log(`  ${name} (${qns.length} candidates)`);
    }
  }

  tree.delete();
}

main().catch(console.error);
