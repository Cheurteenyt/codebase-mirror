/**
 * CONF-R169-007 — canonical R169 documentation authority.
 *
 * Locks the product/primitives/roadmap boundary against the stale claims
 * that survived the R169B merge.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const R169B_MERGE_SHA = "15a732d91984e5b4ffa29b4e129ac0d6316c9fca";

const CANONICAL_PATHS = [
  "docs/ATOMIC_GENERATION_PUBLICATION.md",
  "docs/V2_ARCHITECTURE.md",
  "docs/V2_CURRENT_STATE.md",
  "v2/CHANGELOG.md",
] as const;

function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

const docs = Object.fromEntries(
  CANONICAL_PATHS.map((path) => [
    path,
    readRepoFile(path),
  ]),
) as Record<(typeof CANONICAL_PATHS)[number], string>;

const canonicalCorpus = CANONICAL_PATHS.map((path) => docs[path]).join("\n");

describe("CONF-R169-007 — canonical R169 status", () => {
  it("records the exact R169B merge in every canonical document", () => {
    for (const path of CANONICAL_PATHS) {
      expect(docs[path], path).toContain(R169B_MERGE_SHA);
    }
  });

  it("has no historical R169B step heading in a canonical document", () => {
    expect(canonicalCorpus).not.toMatch(/^#{1,6} .*R169B-STEP\d+.*$/gim);
  });

  it("does not regress to pre-merge or planned R169B status", () => {
    expect(canonicalCorpus).not.toMatch(/R169B[^\n]{0,120}\bNOT merged\b/i);
    expect(canonicalCorpus).not.toMatch(/\|\s*R169B\s*\|[^\n]*\|\s*planned\s*\|/i);
    expect(canonicalCorpus).not.toMatch(/current behavior[^\n]*unchanged from R168\.1/i);
  });

  it("documents the actual fd-copy and no-clobber-link promotion", () => {
    const publication = docs["docs/ATOMIC_GENERATION_PUBLICATION.md"];
    expect(publication).toMatch(/fd-based copy\+hash/i);
    expect(publication).toMatch(/no-clobber `link`/i);
    expect(canonicalCorpus).not.toMatch(
      /rename the staging DB from `?tmp\/?`? (?:in)?to `?generations\/?`?/i,
    );
    expect(canonicalCorpus).not.toMatch(
      /staging DB (?:is )?(?:atomically )?renamed? (?:in)?to `?generations\/?`?/i,
    );
  });

  it("separates merged inactive primitives from the active legacy product", () => {
    for (const path of CANONICAL_PATHS) {
      expect(docs[path], path).toMatch(/MERGED \/ INACTIVE/i);
      expect(docs[path], path).toContain("defaultCodeDbPath");
    }

    const currentDocs = [
      docs["docs/ATOMIC_GENERATION_PUBLICATION.md"],
      docs["docs/V2_ARCHITECTURE.md"],
      docs["docs/V2_CURRENT_STATE.md"],
    ].join("\n");
    expect(currentDocs).toMatch(/R169C[^\n]*(?:future|integration)/i);
    expect(currentDocs).toMatch(/legacy `<project>\.db`/i);
  });

  it("states the current bounded weekly Dependabot policy", () => {
    const architecture = docs["docs/V2_ARCHITECTURE.md"];
    const dependabot = readRepoFile(".github/dependabot.yml");
    expect(architecture).toMatch(/grouped weekly minor\/patch updates/i);
    expect(architecture).toMatch(/GitHub\s+Actions, backend, Graph UI, and Docker/i);
    expect(dependabot).toContain('package-ecosystem: "docker"');
    expect(dependabot.match(/open-pull-requests-limit:\s*[1-9]\d*/g)).toHaveLength(4);
    expect(dependabot).not.toMatch(/open-pull-requests-limit:\s*0/);
  });

  it("keeps the documented active/inactive boundary backed by source", () => {
    const indexer = readRepoFile("v2/src/indexer/indexer.ts");
    const publisher = readRepoFile("v2/src/storage/generation-publisher.ts");
    const gc = readRepoFile("v2/src/storage/generation-gc.ts");

    expect(indexer).toContain("defaultCodeDbPath(opts.project)");
    expect(indexer).not.toMatch(/publishPreparedGeneration|resolveActiveCodeDb/);

    expect(publisher).toMatch(/export function reserveGenerationStaging/);
    expect(publisher).toMatch(/export function prepareGenerationForPublication/);
    expect(publisher).toMatch(/export function publishPreparedGeneration/);
    expect(publisher).toContain("readSync(sourceFd");
    expect(publisher).toContain("writeSync(tempFd");
    expect(publisher).toContain("_ops().linkSync(tempPath, finalPath)");
    expect(gc).toMatch(/export function planGenerationGc/);
    expect(gc).toMatch(/export function applyGenerationGcPlan/);
  });
});
