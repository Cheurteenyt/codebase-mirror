import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(TEST_DIR, "..", "..", "scripts", "check-bundle-budget.mjs");
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDistFixture(): string {
  const dist = mkdtempSync(join(tmpdir(), "cbm-bundle-budget-"));
  tempDirectories.push(dist);
  mkdirSync(join(dist, "assets"));
  mkdirSync(join(dist, ".vite"));
  writeFileSync(
    join(dist, "index.html"),
    '<script type="module" src="/assets/entry-real.js"></script>\n'
      + '<link rel="stylesheet" href="/assets/theme-real.css">\n',
  );
  writeFileSync(join(dist, "assets", "entry-real.js"), "console.log('entry');");
  writeFileSync(join(dist, "assets", "lazy-real.js"), "console.log('graph');");
  writeFileSync(
    join(dist, "assets", "lazy-real.js.map"),
    JSON.stringify({ version: 3, sources: [], names: [], mappings: "" }),
  );
  writeFileSync(join(dist, "assets", "control-real.js"), "console.log('control');");
  writeFileSync(
    join(dist, "assets", "theme-real.css"),
    ".text-foreground,.text-primary,.border-border{color:#fff}",
  );
  // These plausible names are deliberately absent from the manifest. A
  // readdir().find() implementation would select or total them by accident.
  writeFileSync(join(dist, "assets", "GraphTab-000-decoy.js"), "x".repeat(200_000));
  writeFileSync(join(dist, "assets", "index-000-decoy.js"), "x".repeat(200_000));
  writeFileSync(join(dist, "assets", "index-000-decoy.css"), "x".repeat(50_000));
  writeFileSync(join(dist, ".vite", "manifest.json"), JSON.stringify({
    "index.html": {
      file: "assets/entry-real.js",
      isEntry: true,
      css: ["assets/theme-real.css"],
      dynamicImports: ["_GraphTab-runtime.js", "src/components/ControlTab.tsx"],
    },
    "_GraphTab-runtime.js": {
      file: "assets/lazy-real.js",
      name: "GraphTab",
      isDynamicEntry: true,
      dynamicImports: ["src/components/NodeDetailPanel.tsx"],
    },
    "src/components/ControlTab.tsx": {
      file: "assets/control-real.js",
      src: "src/components/ControlTab.tsx",
      isDynamicEntry: true,
    },
  }));
  return dist;
}

describe("bundle budget asset resolution", () => {
  it("uses the HTML and Vite manifest entries instead of directory order or names", () => {
    const dist = createDistFixture();
    const result = spawnSync(process.execPath, [SCRIPT, dist], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Graph assets/lazy-real.js");
    expect(result.stdout).toContain("main assets/entry-real.js");
    expect(result.stdout).toContain("CSS assets/theme-real.css");
    expect(result.stdout).toContain("manifest CSS");
    expect(result.stdout).toContain("Radix packages 0");
    expect(result.stdout).not.toContain("decoy");
  });

  it("fails closed when index.html does not identify the manifest entry", () => {
    const dist = createDistFixture();
    writeFileSync(
      join(dist, "index.html"),
      '<script type="module" src="/assets/not-in-manifest.js"></script>\n'
        + '<link rel="stylesheet" href="/assets/theme-real.css">\n',
    );

    const result = spawnSync(process.execPath, [SCRIPT, dist], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Expected exactly one manifest entry referenced by dist/index.html, found 0");
  });

  it("fails closed when the production semantic palette is absent", () => {
    const dist = createDistFixture();
    writeFileSync(join(dist, "assets", "theme-real.css"), "body{color:#fff}");

    const result = spawnSync(process.execPath, [SCRIPT, dist], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("semantic selector .text-foreground is missing");
  });

  it("rejects the aggregate radix-ui entry point even when byte budgets pass", () => {
    const dist = createDistFixture();
    writeFileSync(
      join(dist, "assets", "lazy-real.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["../../node_modules/radix-ui/dist/index.mjs"],
        names: [],
        mappings: "",
      }),
    );

    const result = spawnSync(process.execPath, [SCRIPT, dist], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("forbidden aggregate package radix-ui");
  });

  it("rejects Radix primitives outside GraphTab's dependency closure", () => {
    const dist = createDistFixture();
    writeFileSync(
      join(dist, "assets", "lazy-real.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["../../node_modules/@radix-ui/react-dialog/dist/index.mjs"],
        names: [],
        mappings: "",
      }),
    );

    const result = spawnSync(process.execPath, [SCRIPT, dist], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "contains unexpected Radix packages: @radix-ui/react-dialog",
    );
  });
});
