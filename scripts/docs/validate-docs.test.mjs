import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  extractMarkdownLinks,
  githubSlug,
  markdownAnchors,
  resolveMarkdownDestination,
  stripLinkTitle,
  validateDocumentation,
} from "./validate-docs.mjs";

test("extracts inline and reference links but ignores fenced examples", () => {
  const markdown = [
    "[Current](reference/CURRENT.md#state)",
    "[ref]: history/README.md \"History\"",
    "```md",
    "[ignored](missing.md)",
    "```",
  ].join("\n");
  assert.deepEqual(extractMarkdownLinks(markdown), [
    { destination: "reference/CURRENT.md#state", line: 1 },
    { destination: "history/README.md", line: 2 },
  ]);
});

test("normalizes GitHub-style headings and duplicate anchors", () => {
  assert.equal(githubSlug("15.5.2 Trust root (R169A)"), "1552-trust-root-r169a");
  assert.equal(githubSlug("[<scr[ipt](target)>](outer) Alert"), "outer-alert");
  assert.deepEqual(
    [...markdownAnchors("# Title\n\n## Same\n\n## Same\n")],
    ["title", "same", "same-1"],
  );
});

test("resolves relative, fragment-only, and repository GitHub links", () => {
  assert.deepEqual(resolveMarkdownDestination("docs/reference/A.md", "../README.md#start"), {
    repositoryPath: "docs/README.md",
    fragment: "start",
  });
  assert.deepEqual(resolveMarkdownDestination("docs/reference/A.md", "#local"), {
    repositoryPath: "docs/reference/A.md",
    fragment: "local",
  });
  assert.deepEqual(
    resolveMarkdownDestination(
      "v2/README.md",
      "https://github.com/Cheurteenyt/Ariad/blob/main/docs/README.md#start-here",
    ),
    { repositoryPath: "docs/README.md", fragment: "start-here" },
  );
});

test("removes optional Markdown link titles", () => {
  assert.equal(stripLinkTitle("docs/README.md \"Portal\""), "docs/README.md");
  assert.equal(stripLinkTitle("<docs/My Guide.md> 'Portal'"), "docs/My Guide.md");
});

test("validates a repository and rejects metadata, link, boundary, and reachability regressions", () => {
  const parent = mkdtempSync(join(tmpdir(), "cbm-docs-validator-"));
  const root = join(parent, "repository");
  const metadata = [
    "**Status:** Canonical",
    "**Audience:** Contributors",
    "**Last verified:** 2026-07-20",
    "",
  ].join("\n");

  try {
    mkdirSync(join(root, "docs", "reference"), { recursive: true });
    mkdirSync(join(root, "docs", "history"), { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeFileSync(
      join(root, "docs", "README.md"),
      `${metadata}# Documentation\n\n[Current](reference/CURRENT.md)\n[History](history/README.md)\n`,
    );
    writeFileSync(join(root, "docs", "reference", "CURRENT.md"), `${metadata}# Current\n`);
    writeFileSync(join(root, "docs", "history", "README.md"), "# History\n");
    assert.deepEqual(validateDocumentation({ root }).errors, []);

    writeFileSync(join(root, "docs", "reference", "CURRENT.md"), "# Current\n\n[Missing](MISSING.md)\n");
    let errors = validateDocumentation({ root }).errors;
    assert(errors.some((error) => error.includes("missing 'Status' metadata")));
    assert(errors.some((error) => error.includes("broken local link")));

    writeFileSync(join(parent, "outside.md"), "# Outside\n");
    writeFileSync(
      join(root, "docs", "reference", "CURRENT.md"),
      `${metadata}# Current\n\n[Outside](../../../outside.md)\n`,
    );
    errors = validateDocumentation({ root }).errors;
    assert(errors.some((error) => error.includes("local link escapes the repository")));

    writeFileSync(join(root, "docs", "reference", "CURRENT.md"), `${metadata}# Current\n`);
    writeFileSync(join(root, "docs", "history", "ORPHAN.md"), "# Orphan\n");
    errors = validateDocumentation({ root }).errors;
    assert(errors.some((error) => error.includes("ORPHAN.md: unreachable")));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
