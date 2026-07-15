import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const V2_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("cross-platform update verification commands", () => {
  const packageJson = JSON.parse(
    readFileSync(join(V2_ROOT, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };

  for (const scriptName of [
    "bench:incremental:smoke",
    "bench:publication:smoke",
  ]) {
    it(`${scriptName} does not require POSIX environment assignment syntax`, () => {
      const command = packageJson.scripts[scriptName];

      expect(command).toContain("--smoke");
      expect(command).not.toMatch(/(?:^|\s)[A-Z_][A-Z0-9_]*=\S+\s/);
    });
  }
});
