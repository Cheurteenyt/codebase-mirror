import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const GRAPH_UI_ROOT = resolve(TEST_DIR, "..", "..");
const SOURCE_ROOT = resolve(GRAPH_UI_ROOT, "src");
const EXPECTED_DIRECT_PACKAGES = [
  "@radix-ui/react-checkbox",
  "@radix-ui/react-scroll-area",
  "@radix-ui/react-separator",
  "@radix-ui/react-slot",
];

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    if (![".ts", ".tsx"].includes(extname(entry.name))) return [];
    if (entry.name.includes(".test.") || entry.name.includes(".spec.")) return [];
    return [path];
  });
}

describe("Radix dependency boundary", () => {
  it("declares only the direct primitives used by Ariad components", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(GRAPH_UI_ROOT, "package.json"), "utf8"),
    );
    const directPackages = Object.keys(packageJson.dependencies)
      .filter((name) => name === "radix-ui" || name.startsWith("@radix-ui/"))
      .sort();

    expect(directPackages).toEqual(EXPECTED_DIRECT_PACKAGES);
  });

  it("keeps the aggregate package out of the deterministic lockfile", () => {
    const lockfile = JSON.parse(
      readFileSync(resolve(GRAPH_UI_ROOT, "package-lock.json"), "utf8"),
    );
    const aggregateEntries = Object.keys(lockfile.packages).filter(
      (path) => path === "node_modules/radix-ui"
        || path.endsWith("/node_modules/radix-ui"),
    );

    expect(aggregateEntries).toEqual([]);
    for (const packageName of EXPECTED_DIRECT_PACKAGES) {
      expect(lockfile.packages[`node_modules/${packageName}`]).toBeDefined();
    }
  });

  it("forbids production imports from the aggregate radix-ui entry point", () => {
    const violations = productionTypeScriptFiles(SOURCE_ROOT).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return /["']radix-ui(?:\/[^"']*)?["']/u.test(source)
        ? [path.slice(GRAPH_UI_ROOT.length + 1).replaceAll("\\", "/")]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it.each([
    ["components/ui/badge.tsx", "@radix-ui/react-slot"],
    ["components/ui/button.tsx", "@radix-ui/react-slot"],
    ["components/ui/checkbox.tsx", "@radix-ui/react-checkbox"],
    ["components/ui/scroll-area.tsx", "@radix-ui/react-scroll-area"],
    ["components/ui/separator.tsx", "@radix-ui/react-separator"],
  ])("%s imports its primitive directly", (relativePath, packageName) => {
    const source = readFileSync(resolve(SOURCE_ROOT, relativePath), "utf8");
    expect(source).toContain(`from "${packageName}"`);
  });
});
