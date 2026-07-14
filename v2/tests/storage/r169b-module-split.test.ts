/**
 * R169B-STEP1 — Module split regression tests.
 *
 * STATUS: FOUNDATION / INACTIVE
 *
 * These tests verify the R169B-STEP1 module-cycle break:
 *   1. The dependency graph among the five generation-store modules is
 *      acyclic (types -> paths/validation -> internal I/O -> public
 *      facade).
 *   2. All R169A exports from `generation-store.ts` are still present
 *      (backward compatibility).
 *   3. The generated `.d.ts` surface for `generation-store.ts` is
 *      unchanged for R169A public API symbols.
 *   4. The new R169B types and warning taxonomy are present in
 *      `generation-types.ts`.
 *
 * The static-analysis cycle check parses the import statements of each
 * module with a simple regex (no TypeScript AST parser needed) and
 * builds a directed graph. A depth-first search verifies there is no
 * cycle that includes the public facade or the internal I/O module.
 *
 * These tests do NOT exercise the runtime behavior of the generation
 * store — that is covered by `r169a-generation-store.test.ts`. They
 * only verify the module structure.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// ─── Helpers ────────────────────────────────────────────────────────────

const STORAGE_DIR = resolve(__dirname, "..", "..", "src", "storage");
// Compiled JS output (created by `npm run build`, the pretest hook).
// The node --input-type=module smoke test imports from here because
// Node.js cannot import .ts files directly.
const DIST_STORAGE_DIR = resolve(__dirname, "..", "..", "dist", "storage");

/**
 * Read the source of a storage module.
 */
function readStorageSource(relativePath: string): string {
  return readFileSync(join(STORAGE_DIR, relativePath), "utf-8");
}

/**
 * Parse the relative import paths from a module's source.
 *
 * Matches `from "./foo.js"` and `from "../bar/foo.js"` (single or
 * double quoted). Returns the paths WITHOUT the `.js` extension so
 * they can be matched against module names.
 *
 * Only relative imports are considered — `node:fs`, `node:path`, etc.
 * are not relevant to the internal module graph.
 */
function parseRelativeImports(source: string): string[] {
  const imports: string[] = [];
  // Match `from "..."` or `from '...'` where the path starts with `./` or `../`.
  const re = /from\s+["'](\.\.?\/[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    imports.push(m[1]);
  }
  return imports;
}

/**
 * Resolve a relative import path to a canonical module name (the file
 * path relative to the storage directory, without extension).
 *
 * For example, from `generation-store.ts`:
 *   "./generation-types.js"  -> "generation-types"
 *   "./generation-paths.js"   -> "generation-paths"
 *   "./internal/generation-store-io.js" -> "internal/generation-store-io"
 *
 * From `internal/generation-store-io.ts`:
 *   "../generation-types.js"  -> "generation-types"
 *   "../generation-paths.js"  -> "generation-paths"
 *   "../generation-validation.js" -> "generation-validation"
 */
function resolveImportToModule(
  importerModule: string,
  importPath: string,
): string {
  // importerModule is a path relative to STORAGE_DIR, e.g.
  // "generation-store" or "internal/generation-store-io".
  const importerFilePath = importerModule + ".ts";
  const importerDir = importerFilePath.includes("/")
    ? importerFilePath.slice(0, importerFilePath.lastIndexOf("/"))
    : "";
  // Resolve the import path relative to the importer's directory.
  const resolved = resolve(STORAGE_DIR, importerDir, importPath);
  // Strip the STORAGE_DIR prefix and the .js extension.
  let rel = resolved.slice(STORAGE_DIR.length + 1);
  if (rel.endsWith(".js")) rel = rel.slice(0, -3);
  return rel;
}

/**
 * The five modules in the generation-store dependency graph.
 *
 * The expected acyclic dependency direction is:
 *   types -> paths/validation -> internal I/O -> public facade
 */
const MODULES = [
  "generation-types",
  "generation-paths",
  "generation-validation",
  "internal/generation-store-io",
  "generation-store",
] as const;

type ModuleName = (typeof MODULES)[number];

/**
 * Build the import graph: for each module, the list of modules it
 * imports (filtered to the five generation-store modules).
 *
 * Both `import { ... } from "..."` and `export { ... } from "..."` are
 * counted as edges — both create a load-time dependency. Duplicate
 * edges (e.g. a module that both imports AND re-exports from the same
 * dependency) are de-duplicated so the per-module list is a set.
 */
function buildImportGraph(): Record<ModuleName, ModuleName[]> {
  const graph = {} as Record<ModuleName, ModuleName[]>;
  for (const mod of MODULES) {
    const relativePath = mod + ".ts";
    const src = readStorageSource(relativePath);
    const imports = parseRelativeImports(src);
    const resolved = imports
      .map((p) => resolveImportToModule(mod, p))
      .filter((m): m is ModuleName =>
        (MODULES as readonly string[]).includes(m),
      );
    // De-duplicate while preserving first-seen order.
    const seen = new Set<ModuleName>();
    const unique: ModuleName[] = [];
    for (const m of resolved) {
      if (!seen.has(m)) {
        seen.add(m);
        unique.push(m);
      }
    }
    graph[mod] = unique;
  }
  return graph;
}

/**
 * Detect a cycle in the import graph using DFS. Returns the cycle path
 * if one exists, or null if the graph is acyclic.
 */
function detectCycle(
  graph: Record<ModuleName, ModuleName[]>,
): ModuleName[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color: Record<ModuleName, number> = {} as Record<ModuleName, number>;
  for (const m of MODULES) color[m] = WHITE;
  const stack: ModuleName[] = [];

  function dfs(node: ModuleName): boolean {
    color[node] = GRAY;
    stack.push(node);
    for (const neighbor of graph[node]) {
      if (color[neighbor] === GRAY) {
        // Found a back edge — cycle. Trim the stack to the cycle.
        const cycleStart = stack.indexOf(neighbor);
        stack.push(neighbor); // close the cycle for reporting
        // Overwrite stack with the cycle slice.
        const cycle = stack.slice(cycleStart);
        stack.length = 0;
        stack.push(...cycle);
        return true;
      }
      if (color[neighbor] === WHITE && dfs(neighbor)) {
        return true;
      }
    }
    color[node] = BLACK;
    stack.pop();
    return false;
  }

  for (const m of MODULES) {
    if (color[m] === WHITE) {
      if (dfs(m)) return stack;
    }
  }
  return null;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("R169B-STEP1 — Module cycle break (§4.1)", () => {
  it("the dependency graph among the five generation-store modules is acyclic", () => {
    const graph = buildImportGraph();
    const cycle = detectCycle(graph);
    if (cycle !== null) {
      expect.fail(
        `Circular import detected: ${cycle.join(" -> ")}. ` +
          `Expected acyclic graph: types -> paths/validation -> internal I/O -> public facade.`,
      );
    }
    // If we get here, the graph is acyclic.
    expect(cycle).toBeNull();
  });

  it("generation-types is a leaf module (imports no other generation-store module)", () => {
    const graph = buildImportGraph();
    expect(graph["generation-types"]).toEqual([]);
  });

  it("generation-paths imports only generation-types", () => {
    const graph = buildImportGraph();
    expect(graph["generation-paths"]).toEqual(["generation-types"]);
  });

  it("generation-validation imports only generation-types and generation-paths", () => {
    const graph = buildImportGraph();
    const imports = graph["generation-validation"].slice().sort();
    expect(imports).toEqual(["generation-paths", "generation-types"]);
  });

  it("internal/generation-store-io imports generation-types, generation-paths, and generation-validation (NOT generation-store)", () => {
    const graph = buildImportGraph();
    const imports = graph["internal/generation-store-io"].slice().sort();
    expect(imports).toEqual([
      "generation-paths",
      "generation-types",
      "generation-validation",
    ]);
    // The R169A cycle was: internal -> public facade -> internal.
    // The internal module MUST NOT import from the public facade.
    expect(imports).not.toContain("generation-store");
  });

  it("generation-store (public facade) imports generation-types, generation-paths, generation-validation, and internal/generation-store-io", () => {
    const graph = buildImportGraph();
    const imports = graph["generation-store"].slice().sort();
    expect(imports).toEqual([
      "generation-paths",
      "generation-types",
      "generation-validation",
      "internal/generation-store-io",
    ]);
  });

  it("node --input-type=module loads all five modules without error", () => {
    // Spawn a Node.js subprocess that imports all five modules (compiled
    // to JS in dist/) and prints "OK" if all imports succeed. This is
    // a runtime smoke test of the static-analysis cycle check above:
    // ES modules with circular dependencies can load successfully but
    // have undefined bindings if accessed before initialization; this
    // test verifies that all expected exports are defined (not
    // undefined) after loading.
    const script = `
import * as types from "${resolve(DIST_STORAGE_DIR, "generation-types.js")}";
import * as paths from "${resolve(DIST_STORAGE_DIR, "generation-paths.js")}";
import * as validation from "${resolve(DIST_STORAGE_DIR, "generation-validation.js")}";
import * as io from "${resolve(DIST_STORAGE_DIR, "internal", "generation-store-io.js")}";
import * as facade from "${resolve(DIST_STORAGE_DIR, "generation-store.js")}";

const checks = [];
function check(label, cond) { checks.push({ label, ok: !!cond }); }

// types module — leaf
check("types.GenerationManifestV1 exists (type-only, runtime undefined is OK)", true);
check("types.GenerationStoreError exists", typeof types.GenerationStoreError === "function");
check("types.MANIFEST_V1_KEYS exists", Array.isArray(types.MANIFEST_V1_KEYS));
check("types.INDEX_STATE_V1_KEYS exists", Array.isArray(types.INDEX_STATE_V1_KEYS));
check("types.isManifestV1Key exists", typeof types.isManifestV1Key === "function");
check("types.isIndexStateV1Key exists", typeof types.isIndexStateV1Key === "function");

// paths module — leaf-ish (imports types)
check("paths.getCacheRoot exists", typeof paths.getCacheRoot === "function");
check("paths.cbmCacheDir exists", typeof paths.cbmCacheDir === "function");
check("paths.generationStoreRoot exists", typeof paths.generationStoreRoot === "function");
check("paths.projectStorageKey exists", typeof paths.projectStorageKey === "function");
check("paths.projectStoreDir exists", typeof paths.projectStoreDir === "function");
check("paths.generationsDir exists", typeof paths.generationsDir === "function");
check("paths.tmpDir exists", typeof paths.tmpDir === "function");
check("paths.activeManifestPath exists", typeof paths.activeManifestPath === "function");
check("paths.indexStatePath exists", typeof paths.indexStatePath === "function");
check("paths.legacyCodeDbPath exists", typeof paths.legacyCodeDbPath === "function");
check("paths.isLexicallyInside exists", typeof paths.isLexicallyInside === "function");
check("paths.isPathInside exists", typeof paths.isPathInside === "function");

// validation module
check("validation.validateGenerationManifest exists", typeof validation.validateGenerationManifest === "function");
check("validation.validateIndexAttemptState exists", typeof validation.validateIndexAttemptState === "function");
check("validation.parseGenerationManifest exists", typeof validation.parseGenerationManifest === "function");
check("validation.assertPathInsideNoSymlinks exists", typeof validation.assertPathInsideNoSymlinks === "function");
check("validation.assertNotSymlink exists", typeof validation.assertNotSymlink === "function");
check("validation.assertTrustedRootNoSymlinks exists", typeof validation.assertTrustedRootNoSymlinks === "function");
check("validation.assertGenerationStoreRootTrusted exists", typeof validation.assertGenerationStoreRootTrusted === "function");
check("validation.assertLayoutDirPermissions exists", typeof validation.assertLayoutDirPermissions === "function");
check("validation.MAX_GENERATION_MANIFEST_BYTES exists", typeof validation.MAX_GENERATION_MANIFEST_BYTES === "number");
check("validation.O_NOFOLLOW exists", typeof validation.O_NOFOLLOW === "number");
check("validation.O_DIRECTORY exists", typeof validation.O_DIRECTORY === "number");

// internal I/O module
check("io.AtomicFileOps exists (interface, runtime undefined is OK)", true);
check("io.WriterTestHook exists (interface, runtime undefined is OK)", true);
check("io.PROD_OPS exists", typeof io.PROD_OPS === "object" && io.PROD_OPS !== null);
check("io.writeIndexStateAtomicallyInternal exists", typeof io.writeIndexStateAtomicallyInternal === "function");
check("io.ensureGenerationStoreLayoutDurableInternal exists", typeof io.ensureGenerationStoreLayoutDurableInternal === "function");
check("io.writeProjectJsonAtomicallyInternal exists", typeof io.writeProjectJsonAtomicallyInternal === "function");
check("io.writeJsonAtomically exists", typeof io.writeJsonAtomically === "function");
check("io.prepareGenerationManifestForWrite exists", typeof io.prepareGenerationManifestForWrite === "function");
check("io.prepareIndexStateForWrite exists", typeof io.prepareIndexStateForWrite === "function");
check("io.openDirectoryNoFollow exists", typeof io.openDirectoryNoFollow === "function");

// public facade
check("facade.writeIndexStateAtomically exists", typeof facade.writeIndexStateAtomically === "function");
check("facade.ensureGenerationStoreLayoutDurable exists", typeof facade.ensureGenerationStoreLayoutDurable === "function");
check("facade.listProjectStoreKeys exists", typeof facade.listProjectStoreKeys === "function");
check("facade.resolveActiveCodeDb exists", typeof facade.resolveActiveCodeDb === "function");

const failed = checks.filter(c => !c.ok);
if (failed.length > 0) {
  console.error("FAILED CHECKS:");
  for (const c of failed) console.error("  - " + c.label);
  process.exit(1);
}
console.log("OK");
`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { encoding: "utf-8", cwd: resolve(STORAGE_DIR, "..", "..") },
    );
    if (result.status !== 0) {
      expect.fail(
        `Node module load failed (status=${result.status}):\n` +
          `stdout: ${result.stdout}\n` +
          `stderr: ${result.stderr}`,
      );
    }
    expect(result.stdout.trim()).toContain("OK");
  });
});

describe("R169B-STEP1 — R169A exports still work from generation-store.ts (backward compat)", () => {
  // Import the public facade as a namespace and verify every R169A export
  // is present. The list below is the complete set of R169A exports from
  // generation-store.ts (as of the R169A squash-merge commit
  // 955133e). R169B-STEP1 must not remove any of these.
  it("all R169A function exports are present", async () => {
    const mod = await import("../../src/storage/generation-store.js");
    const functionExports = [
      "getCacheRoot",
      "cbmCacheDir",
      "generationStoreRoot",
      "projectStorageKey",
      "projectStoreDir",
      "generationsDir",
      "tmpDir",
      "activeManifestPath",
      "indexStatePath",
      "legacyCodeDbPath",
      "isLexicallyInside",
      "isPathInside",
      "assertPathInsideNoSymlinks",
      "assertNotSymlink",
      "assertTrustedRootNoSymlinks",
      "assertGenerationStoreRootTrusted",
      "validateGenerationManifest",
      "validateIndexAttemptState",
      "parseGenerationManifest",
      "resolveActiveCodeDb",
      "ensureGenerationStoreLayoutDurable",
      "writeIndexStateAtomically",
      "listProjectStoreKeys",
    ];
    for (const name of functionExports) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("all R169A const exports are present", async () => {
    const mod = await import("../../src/storage/generation-store.js");
    const constExports = [
      "CBM_CACHE_SUBDIR",
      "PROJECTS_SUBDIR",
      "MANIFEST_FILENAME",
      "INDEX_STATE_FILENAME",
      "GENERATIONS_SUBDIR",
      "TMP_SUBDIR",
      "MAX_GENERATION_MANIFEST_BYTES",
      "O_NOFOLLOW",
      "O_DIRECTORY",
      "MANIFEST_V1_KEYS",
      "INDEX_STATE_V1_KEYS",
      "isManifestV1Key",
      "isIndexStateV1Key",
      "GenerationStoreError",
    ];
    for (const name of constExports) {
      expect((mod as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it("the R169A internal symbols are still NOT exported from generation-store.ts", async () => {
    const mod = await import("../../src/storage/generation-store.js");
    const internalSymbols = [
      "AtomicFileOps",
      "WriterTestHook",
      "PROD_OPS",
      "writeIndexStateAtomicallyInternal",
      "ensureGenerationStoreLayoutDurableInternal",
      "writeProjectJsonAtomicallyInternal",
      "writeJsonAtomically",
      "prepareGenerationManifestForWrite",
      "prepareIndexStateForWrite",
      "openDirectoryNoFollow",
      "assertLayoutDirPermissions",
      "defaultSerializeJson",
      "writeGenerationManifestAtomically",
      "__test__",
    ];
    for (const name of internalSymbols) {
      expect((mod as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});

describe("R169B-STEP1 — .d.ts surface unchanged for R169A public API", () => {
  const dtsPath = resolve(STORAGE_DIR, "..", "..", "dist", "storage", "generation-store.d.ts");

  it("generated .d.ts exists (build ran)", () => {
    let exists = false;
    try {
      readFileSync(dtsPath, "utf-8");
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      expect.fail(`Generated .d.ts not found at ${dtsPath}. Run 'npm run build' first.`);
    }
    expect(exists).toBe(true);
  });

  it("the R169A public facade functions are present in the .d.ts", () => {
    const dts = readFileSync(dtsPath, "utf-8");
    // Locally-defined facade functions appear as `export declare function`.
    expect(dts).toMatch(/declare\s+function\s+writeIndexStateAtomically\b/);
    expect(dts).toMatch(/declare\s+function\s+ensureGenerationStoreLayoutDurable\b/);
    expect(dts).toMatch(/declare\s+function\s+listProjectStoreKeys\b/);
    expect(dts).toMatch(/declare\s+function\s+resolveActiveCodeDb\b/);
    // Re-exported functions appear in `export { ... } from "..."` blocks.
    // They are NOT re-declared with `declare function` in this .d.ts;
    // they come from `./generation-paths.js` or `./generation-validation.js`.
    expect(dts).toMatch(/\bparseGenerationManifest\b/);
    expect(dts).toMatch(/\bvalidateGenerationManifest\b/);
    expect(dts).toMatch(/\bvalidateIndexAttemptState\b/);
    expect(dts).toMatch(/\bassertPathInsideNoSymlinks\b/);
    expect(dts).toMatch(/\bassertNotSymlink\b/);
    expect(dts).toMatch(/\bassertTrustedRootNoSymlinks\b/);
    expect(dts).toMatch(/\bassertGenerationStoreRootTrusted\b/);
    expect(dts).toMatch(/\bgetCacheRoot\b/);
    expect(dts).toMatch(/\bcbmCacheDir\b/);
    expect(dts).toMatch(/\bgenerationStoreRoot\b/);
    expect(dts).toMatch(/\bprojectStorageKey\b/);
    expect(dts).toMatch(/\bprojectStoreDir\b/);
    expect(dts).toMatch(/\bgenerationsDir\b/);
    expect(dts).toMatch(/\btmpDir\b/);
    expect(dts).toMatch(/\bactiveManifestPath\b/);
    expect(dts).toMatch(/\bindexStatePath\b/);
    expect(dts).toMatch(/\blegacyCodeDbPath\b/);
    expect(dts).toMatch(/\bisLexicallyInside\b/);
    // Re-export of the path helpers MUST be from `./generation-paths.js`.
    expect(dts).toMatch(/from\s+["']\.\/generation-paths\.js["']/);
    // Re-export of the validators MUST be from `./generation-validation.js`.
    expect(dts).toMatch(/from\s+["']\.\/generation-validation\.js["']/);
  });

  it("the R169A public const exports are present in the .d.ts", () => {
    const dts = readFileSync(dtsPath, "utf-8");
    // Re-exported consts appear in `export { ... } from "..."` blocks.
    // They are NOT re-declared with `declare const` in this .d.ts.
    for (const name of [
      "CBM_CACHE_SUBDIR",
      "PROJECTS_SUBDIR",
      "MANIFEST_FILENAME",
      "INDEX_STATE_FILENAME",
      "GENERATIONS_SUBDIR",
      "TMP_SUBDIR",
      "MAX_GENERATION_MANIFEST_BYTES",
      "O_NOFOLLOW",
      "O_DIRECTORY",
      "MANIFEST_V1_KEYS",
      "INDEX_STATE_V1_KEYS",
      "isManifestV1Key",
      "isIndexStateV1Key",
      "isPathInside",
    ]) {
      expect(dts).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it("the R169A public types are present in the .d.ts", () => {
    const dts = readFileSync(dtsPath, "utf-8");
    // Re-exported types appear in `export type { ... } from "..."` blocks.
    // They are NOT re-declared with `declare interface` / `declare type`
    // in this .d.ts.
    for (const name of [
      "GenerationManifestV1",
      "IndexAttemptStateV1",
      "IndexAttemptStaleReasonV1",
      "IndexAttemptFailureV1",
      "IndexAttemptOutcome",
      "IndexRecoveryAction",
      "IndexPublicationState",
      "ResolvedCodeDb",
      "GenerationStoreError",
      "GenerationStoreOptions",
    ]) {
      expect(dts).toMatch(new RegExp(`\\b${name}\\b`));
    }
    // The re-export of types MUST come from `./generation-types.js`.
    expect(dts).toMatch(/from\s+["']\.\/generation-types\.js["']/);
  });

  it("the R169A internal symbols are NOT declared in the .d.ts (R169A-FIX-R8 surface)", () => {
    const dts = readFileSync(dtsPath, "utf-8");
    const internalSymbols = [
      "AtomicFileOps",
      "WriterTestHook",
      "PROD_OPS",
      "writeIndexStateAtomicallyInternal",
      "ensureGenerationStoreLayoutDurableInternal",
      "writeProjectJsonAtomicallyInternal",
      "writeJsonAtomically",
      "prepareGenerationManifestForWrite",
      "prepareIndexStateForWrite",
      "openDirectoryNoFollow",
      "assertLayoutDirPermissions",
      "defaultSerializeJson",
      "writeGenerationManifestAtomically",
      "__test__",
    ];
    for (const symbol of internalSymbols) {
      const patterns = [
        new RegExp(`declare\\s+interface\\s+${symbol}\\b`),
        new RegExp(`declare\\s+type\\s+${symbol}\\b`),
        new RegExp(`declare\\s+const\\s+${symbol}\\b`),
        new RegExp(`declare\\s+function\\s+${symbol}\\b`),
        new RegExp(`export\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}`),
      ];
      for (const p of patterns) {
        expect(dts).not.toMatch(p);
      }
    }
  });

  it("writeIndexStateAtomically has EXACTLY 3 parameters in the .d.ts (R169A-FIX-R6 API-R169A-R6-01)", () => {
    const dts = readFileSync(dtsPath, "utf-8");
    // Match `declare function writeIndexStateAtomically(project: ..., state: ..., options?: ...): void;`
    // and verify there are exactly 3 parameters.
    const m = dts.match(
      /declare\s+function\s+writeIndexStateAtomically\s*\(([^)]*)\)\s*:\s*void\s*;/,
    );
    expect(m).not.toBeNull();
    if (m) {
      const params = m[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      expect(params.length).toBe(3);
      expect(params[0]).toMatch(/^project\s*:/);
      expect(params[1]).toMatch(/^state\s*:/);
      expect(params[2]).toMatch(/^options\s*\?\s*:/);
    }
  });
});

describe("R169B-STEP1 — New R169B types and warning taxonomy (§10)", () => {
  it("GenerationStoreWarningCode type is defined in generation-types.ts source", () => {
    const src = readStorageSource("generation-types.ts");
    expect(src).toMatch(/export\s+type\s+GenerationStoreWarningCode\b/);
    // The three R169B-STEP1 warning codes.
    expect(src).toMatch(/"ATOMIC_TEMP_ORPHANED"/);
    expect(src).toMatch(/"STAGING_ALIAS_CLEANUP_DEFERRED"/);
    expect(src).toMatch(/"GC_DELETE_FAILED"/);
  });

  it("GenerationStoreWarning interface is defined in generation-types.ts source", () => {
    const src = readStorageSource("generation-types.ts");
    expect(src).toMatch(/export\s+interface\s+GenerationStoreWarning\b/);
    expect(src).toMatch(/code\s*:\s*GenerationStoreWarningCode/);
    expect(src).toMatch(/message\s*:\s*string/);
  });

  it("the R169B-STEP1 error codes are present in GenerationStoreErrorCode", () => {
    const src = readStorageSource("generation-types.ts");
    const r169bCodes = [
      "STAGING_CREATE_FAILED",
      "STAGING_TARGET_INVALID",
      "STAGING_DB_BUSY",
      "STAGING_DB_INTEGRITY_FAILED",
      "STAGING_DB_SCHEMA_INVALID",
      "STAGING_DB_PROJECT_MISMATCH",
      "STAGING_DB_STATE_INVALID",
      "STAGING_DB_WAL_DIRTY",
      "GENERATION_HASH_FAILED",
      "GENERATION_PROMOTION_CONFLICT",
      "GENERATION_PROMOTION_FAILED",
      "GENERATION_PROMOTION_DURABILITY_UNKNOWN",
      "GENERATION_METADATA_INVALID",
      "PUBLICATION_TOKEN_INVALID",
      "PUBLICATION_TOKEN_CONSUMED",
      "PUBLICATION_CAS_BUSY",
      "PUBLICATION_CAS_MISMATCH",
      "PUBLICATION_CAS_STATE_CORRUPT",
      "PUBLICATION_VERIFY_FAILED",
      "GC_PLAN_STALE",
      "GC_SAFETY_REFUSAL",
    ];
    for (const code of r169bCodes) {
      expect(src).toMatch(new RegExp(`"${code}"`));
    }
  });

  it("GenerationStoreError optionally carries generationId", () => {
    const src = readStorageSource("generation-types.ts");
    expect(src).toMatch(/readonly\s+generationId\?\s*:\s*string/);
    // The constructor accepts an optional 5th parameter.
    expect(src).toMatch(/generationId\?\s*:\s*string/);
  });

  it("GenerationStoreError can be constructed with and without generationId", async () => {
    const { GenerationStoreError } = await import(
      "../../src/storage/generation-types.js"
    );
    // Without generationId (R169A behavior — backward compat).
    const err1 = new GenerationStoreError(
      "MANIFEST_PARSE_ERROR",
      "test-phase",
      "test-project",
      "test message",
    );
    expect(err1.generationId).toBeUndefined();
    expect(err1.message).not.toMatch(/generationId=/);
    expect(err1.project).toBe("test-project");
    expect(err1.code).toBe("MANIFEST_PARSE_ERROR");

    // With generationId (R169B-STEP1 — new behavior).
    const err2 = new GenerationStoreError(
      "GENERATION_PROMOTION_FAILED",
      "test-phase",
      "test-project",
      "test message",
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(err2.generationId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(err2.message).toMatch(/generationId=550e8400-e29b-41d4-a716-446655440000/);
    expect(err2.project).toBe("test-project");
    expect(err2.code).toBe("GENERATION_PROMOTION_FAILED");
  });

  it("the R169B warning codes are valid GenerationStoreWarningCode values", async () => {
    // The warning type is a string-literal union; at runtime it has no
    // representation, but we can verify the source declares the three
    // codes in the union.
    const src = readStorageSource("generation-types.ts");
    // The union should declare ATOMIC_TEMP_ORPHANED,
    // STAGING_ALIAS_CLEANUP_DEFERRED, and GC_DELETE_FAILED as members.
    expect(src).toMatch(
      /\|\s*"ATOMIC_TEMP_ORPHANED"\s*\|\s*"STAGING_ALIAS_CLEANUP_DEFERRED"\s*\|\s*"GC_DELETE_FAILED"/,
    );
  });
});

describe("R169B-STEP1 — Module split source inspection (additional)", () => {
  it("generation-store.ts re-exports paths from generation-paths.js", () => {
    const src = readStorageSource("generation-store.ts");
    expect(src).toMatch(/export\s*\{[^}]*getCacheRoot[^}]*\}\s*from\s*["']\.\/generation-paths\.js["']/);
  });

  it("generation-store.ts re-exports validators from generation-validation.js", () => {
    const src = readStorageSource("generation-store.ts");
    expect(src).toMatch(/export\s*\{[^}]*validateGenerationManifest[^}]*\}\s*from\s*["']\.\/generation-validation\.js["']/);
  });

  it("generation-store.ts does NOT define path helpers locally (they live in generation-paths.ts)", () => {
    const src = readStorageSource("generation-store.ts");
    // The public facade MUST NOT define `export function getCacheRoot`,
    // `export function cbmCacheDir`, etc. — they live in
    // `generation-paths.ts` and are re-exported here.
    expect(src).not.toMatch(/export\s+function\s+getCacheRoot\b/);
    expect(src).not.toMatch(/export\s+function\s+cbmCacheDir\b/);
    expect(src).not.toMatch(/export\s+function\s+projectStorageKey\b/);
    expect(src).not.toMatch(/export\s+function\s+projectStoreDir\b/);
    expect(src).not.toMatch(/export\s+function\s+legacyCodeDbPath\b/);
  });

  it("generation-store.ts does NOT define validators locally (they live in generation-validation.ts)", () => {
    const src = readStorageSource("generation-store.ts");
    expect(src).not.toMatch(/export\s+function\s+validateGenerationManifest\b/);
    expect(src).not.toMatch(/export\s+function\s+validateIndexAttemptState\b/);
    expect(src).not.toMatch(/export\s+function\s+parseGenerationManifest\b/);
    expect(src).not.toMatch(/export\s+function\s+assertPathInsideNoSymlinks\b/);
    expect(src).not.toMatch(/export\s+function\s+assertNotSymlink\b/);
    expect(src).not.toMatch(/export\s+function\s+assertTrustedRootNoSymlinks\b/);
    expect(src).not.toMatch(/export\s+function\s+assertGenerationStoreRootTrusted\b/);
  });

  it("generation-store.ts does NOT define assertLayoutDirPermissions locally (it lives in generation-validation.ts)", () => {
    const src = readStorageSource("generation-store.ts");
    expect(src).not.toMatch(/export\s+function\s+assertLayoutDirPermissions\b/);
    expect(src).not.toMatch(/^function\s+assertLayoutDirPermissions\b/m);
  });

  it("generation-validation.ts DOES define assertLayoutDirPermissions", () => {
    const src = readStorageSource("generation-validation.ts");
    expect(src).toMatch(/export\s+function\s+assertLayoutDirPermissions\b/);
  });

  it("internal/generation-store-io.ts imports assertLayoutDirPermissions from generation-validation.js", () => {
    const src = readStorageSource("internal/generation-store-io.ts");
    expect(src).toMatch(/from\s+["']\.\.\/generation-validation\.js["']/);
    expect(src).toMatch(/\bassertLayoutDirPermissions\b/);
    // And it does NOT define it locally.
    expect(src).not.toMatch(/export\s+function\s+assertLayoutDirPermissions\b/);
  });

  it("internal/generation-store-io.ts imports O_NOFOLLOW and O_DIRECTORY from generation-validation.js", () => {
    const src = readStorageSource("internal/generation-store-io.ts");
    // The internal module MUST import these constants from validation
    // (they were duplicated locally in R169A; the deduplication is part
    // of the cycle break).
    expect(src).toMatch(/\bO_NOFOLLOW\b/);
    expect(src).toMatch(/\bO_DIRECTORY\b/);
    // And it does NOT define them locally.
    expect(src).not.toMatch(/export\s+const\s+O_NOFOLLOW\b/);
    expect(src).not.toMatch(/export\s+const\s+O_DIRECTORY\b/);
  });

  it("internal/generation-store-io.ts does NOT import from generation-store.js (cycle broken)", () => {
    const src = readStorageSource("internal/generation-store-io.ts");
    expect(src).not.toMatch(/from\s+["']\.\.\/generation-store\.js["']/);
  });

  it("generation-paths.ts does NOT import from generation-validation.js or generation-store.js (leaf)", () => {
    const src = readStorageSource("generation-paths.ts");
    expect(src).not.toMatch(/from\s+["']\.\/generation-validation\.js["']/);
    expect(src).not.toMatch(/from\s+["']\.\/generation-store\.js["']/);
    expect(src).not.toMatch(/from\s+["']\.\/internal\/generation-store-io\.js["']/);
  });

  it("generation-validation.ts does NOT import from generation-store.js or internal/ (leaf-ish)", () => {
    const src = readStorageSource("generation-validation.ts");
    expect(src).not.toMatch(/from\s+["']\.\/generation-store\.js["']/);
    expect(src).not.toMatch(/from\s+["']\.\/internal\/generation-store-io\.js["']/);
  });
});

// ─── R169B-STEP2 — Publisher / CAS / GC module structure ──────────────────
//
// R169B-STEP2 adds three new modules to the generation-store dependency
// graph:
//   - `internal/generation-cas-store.ts` — CAS SQLite store (internal,
//     same level as `internal/generation-store-io.ts`).
//   - `generation-publisher.ts` — public facade (publisher primitives).
//   - `generation-gc.ts` — public facade (GC planner + applier).
//
// Expected acyclic dependency direction (extended from STEP1):
//   types -> paths/validation -> internal I/O + CAS store -> public facades
//
// The new modules MUST NOT introduce a cycle. The publisher and GC
// MUST NOT import from each other (they are independent public facades
// that share the CAS store + internal I/O).

describe("R169B-STEP2 — Publisher / CAS / GC module structure", () => {
  const STEP2_MODULES = [
    ...MODULES,
    "internal/generation-cas-store",
    "generation-publisher",
    "generation-gc",
  ] as const;

  type Step2Module = (typeof STEP2_MODULES)[number];

  function buildStep2ImportGraph(): Record<Step2Module, Step2Module[]> {
    const graph = {} as Record<Step2Module, Step2Module[]>;
    for (const mod of STEP2_MODULES) {
      const relativePath = mod + ".ts";
      const src = readStorageSource(relativePath);
      const imports = parseRelativeImports(src);
      const resolved = imports
        .map((p) => resolveImportToModule(mod, p))
        .filter((m): m is Step2Module =>
          (STEP2_MODULES as readonly string[]).includes(m),
        );
      const seen = new Set<Step2Module>();
      const unique: Step2Module[] = [];
      for (const m of resolved) {
        if (!seen.has(m)) {
          seen.add(m);
          unique.push(m);
        }
      }
      graph[mod] = unique;
    }
    return graph;
  }

  function detectStep2Cycle(
    graph: Record<Step2Module, Step2Module[]>,
  ): Step2Module[] | null {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color: Record<string, number> = {};
    for (const m of STEP2_MODULES) color[m] = WHITE;
    const stack: Step2Module[] = [];

    function dfs(node: Step2Module): boolean {
      color[node] = GRAY;
      stack.push(node);
      for (const neighbor of graph[node]) {
        if (color[neighbor] === GRAY) {
          const cycleStart = stack.indexOf(neighbor);
          stack.push(neighbor);
          const cycle = stack.slice(cycleStart);
          stack.length = 0;
          stack.push(...cycle);
          return true;
        }
        if (color[neighbor] === WHITE && dfs(neighbor)) {
          return true;
        }
      }
      color[node] = BLACK;
      stack.pop();
      return false;
    }

    for (const m of STEP2_MODULES) {
      if (color[m] === WHITE) {
        if (dfs(m)) return stack;
      }
    }
    return null;
  }

  it("the extended dependency graph (8 modules) is acyclic", () => {
    const graph = buildStep2ImportGraph();
    const cycle = detectStep2Cycle(graph);
    if (cycle !== null) {
      expect.fail(
        `Circular import detected: ${cycle.join(" -> ")}. ` +
          `Expected acyclic graph: types -> paths/validation -> internal I/O + CAS -> public facades.`,
      );
    }
    expect(cycle).toBeNull();
  });

  it("internal/generation-cas-store imports types, paths, validation (NOT publisher / GC / public facade / internal I/O)", () => {
    const graph = buildStep2ImportGraph();
    const imports = graph["internal/generation-cas-store"].slice().sort();
    // The CAS store is a leaf-ish internal module (like internal I/O).
    // It imports the leaf modules (types, paths, validation) but NOT
    // the public facades or the internal I/O module.
    expect(imports).toEqual([
      "generation-paths",
      "generation-types",
      "generation-validation",
    ]);
    expect(imports).not.toContain("generation-store");
    expect(imports).not.toContain("generation-publisher");
    expect(imports).not.toContain("generation-gc");
    expect(imports).not.toContain("internal/generation-store-io");
  });

  it("generation-publisher imports types, paths, validation, internal I/O, internal CAS (NOT GC or public facade)", () => {
    const graph = buildStep2ImportGraph();
    const imports = graph["generation-publisher"].slice().sort();
    expect(imports).toEqual([
      "generation-paths",
      "generation-types",
      "generation-validation",
      "internal/generation-cas-store",
      "internal/generation-store-io",
    ]);
    expect(imports).not.toContain("generation-store");
    expect(imports).not.toContain("generation-gc");
  });

  it("generation-gc imports types, paths, validation, internal I/O, internal CAS (NOT publisher or public facade)", () => {
    const graph = buildStep2ImportGraph();
    const imports = graph["generation-gc"].slice().sort();
    expect(imports).toEqual([
      "generation-paths",
      "generation-types",
      "generation-validation",
      "internal/generation-cas-store",
      "internal/generation-store-io",
    ]);
    expect(imports).not.toContain("generation-store");
    expect(imports).not.toContain("generation-publisher");
  });

  it("the publisher and GC do NOT import from each other (independent facades)", () => {
    const graph = buildStep2ImportGraph();
    expect(graph["generation-publisher"]).not.toContain("generation-gc");
    expect(graph["generation-gc"]).not.toContain("generation-publisher");
  });

  it("R169B-STEP2 public types are defined in generation-types.ts", () => {
    const src = readStorageSource("generation-types.ts");
    // Publisher / GC / CAS public types.
    expect(src).toMatch(/export\s+interface\s+GenerationStagingReservation\b/);
    expect(src).toMatch(/export\s+interface\s+PreparedGenerationInput\b/);
    expect(src).toMatch(/export\s+interface\s+PreparedGeneration\b/);
    expect(src).toMatch(/export\s+interface\s+PublishPreparedGenerationOptions\b/);
    expect(src).toMatch(/export\s+interface\s+PublicationResult\b/);
    expect(src).toMatch(/export\s+interface\s+DiscardResult\b/);
    expect(src).toMatch(/export\s+interface\s+GenerationGcOptions\b/);
    expect(src).toMatch(/export\s+interface\s+GenerationGcPlanEntry\b/);
    expect(src).toMatch(/export\s+interface\s+GenerationGcTmpEntry\b/);
    expect(src).toMatch(/export\s+interface\s+GenerationGcPlan\b/);
    expect(src).toMatch(/export\s+interface\s+GenerationGcResult\b/);
    // CAS types.
    expect(src).toMatch(/export\s+interface\s+CasGenerationCatalogEntry\b/);
    expect(src).toMatch(/export\s+interface\s+CasPublicationHistoryEntry\b/);
    expect(src).toMatch(/export\s+interface\s+CasReconcileResult\b/);
    expect(src).toMatch(/export\s+interface\s+CasDedupCandidate\b/);
  });

  it("the publisher exports the four public primitives", () => {
    const src = readStorageSource("generation-publisher.ts");
    expect(src).toMatch(/export\s+function\s+reserveGenerationStaging\b/);
    expect(src).toMatch(/export\s+function\s+prepareGenerationForPublication\b/);
    expect(src).toMatch(/export\s+function\s+publishPreparedGeneration\b/);
    expect(src).toMatch(/export\s+function\s+discardPreparedGeneration\b/);
  });

  it("the GC module exports the plan + apply primitives", () => {
    const src = readStorageSource("generation-gc.ts");
    expect(src).toMatch(/export\s+function\s+planGenerationGc\b/);
    expect(src).toMatch(/export\s+function\s+applyGenerationGcPlan\b/);
  });

  it("the CAS store exports openCasStore + CAS_DB_FILENAME", () => {
    const src = readStorageSource("internal/generation-cas-store.ts");
    expect(src).toMatch(/export\s+function\s+openCasStore\b/);
    expect(src).toMatch(/export\s+const\s+CAS_DB_FILENAME\b/);
  });

  it("the publisher uses link() (not rename()) for promotion", () => {
    const src = readStorageSource("generation-publisher.ts");
    expect(src).toMatch(/\blinkSync\b/);
    // R169B-STEP8: the publisher now uses link(tempPath, finalPath) for
    // no-clobber promotion (was link(stagingPath, finalPath) in STEP4).
    // The temp file approach ensures identity-safe cleanup.
    expect(src).toMatch(/linkSync\(tempPath,\s*finalPath\)/);
  });

  it("the publisher computes SHA-256 in streaming chunks (not readFileSync)", () => {
    const src = readStorageSource("generation-publisher.ts");
    expect(src).toMatch(/createHash\(["']sha256["']\)/);
    // The publisher MUST NOT use readFileSync to read the staging DB
    // for hashing (it must stream in chunks).
    expect(src).not.toMatch(/readFileSync\(stagingPath/);
    // R169B-STEP4 (HASH-R169B-A2-04): the publisher now uses the
    // unified secure hash primitive (computeSha256WithIdentityChecks)
    // for BOTH prepare and publish. The chunk-based read is inside
    // that primitive.
    expect(src).toMatch(/HASH_CHUNK_BYTES/);
    expect(src).toMatch(/computeSha256WithIdentityChecks/);
  });

  it("the publisher uses a WeakMap for PreparedGeneration tokens (forge-resistant)", () => {
    const src = readStorageSource("generation-publisher.ts");
    expect(src).toMatch(/WeakMap<PreparedGeneration/);
    expect(src).toMatch(/preparedTokens/);
  });

  it("the CAS store uses BEGIN IMMEDIATE for write serialization", () => {
    const src = readStorageSource("internal/generation-cas-store.ts");
    expect(src).toMatch(/BEGIN\s+IMMEDIATE/);
  });

  it("the GC plan never uses mtime for retain/delete (only publication_history order)", () => {
    const src = readStorageSource("generation-gc.ts");
    // The planner MUST NOT consult mtime for the retain/delete decision.
    // mtime is ONLY used for the tmp/ age sweep (which is explicitly
    // age-based).
    // Verify the retain-N logic uses publication_history (listPublicationHistory).
    expect(src).toMatch(/listPublicationHistory/);
    expect(src).toMatch(/distinctPrevious/);
  });

  it("the GC applier never promotes from tmp/", () => {
    const src = readStorageSource("generation-gc.ts");
    // The applier unlinks tmp/ artifacts; it MUST NOT link/rename them
    // into generations/.
    expect(src).toMatch(/unlinkSync/);
    // The GC module MUST NOT use linkSync (no promotion).
    expect(src).not.toMatch(/\blinkSync\b/);
  });
});
