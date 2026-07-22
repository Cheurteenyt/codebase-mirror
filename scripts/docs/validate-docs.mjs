#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const PORTAL = "docs/README.md";
const FROZEN_EXTERNAL_DOCS = new Set(["v1-reference/README-V1.md"]);
const ACTIVE_PREFIXES = [
  "docs/architecture/",
  "docs/operations/",
  "docs/performance/",
  "docs/reference/",
];
const ACTIVE_EXCLUSIONS = ["docs/performance/benchmarks/"];
const ALLOWED_DOCS_ROOTS = new Set([
  "README.md",
  "ai",
  "architecture",
  "assets",
  "history",
  "operations",
  "performance",
  "reference",
  "templates",
]);

function trackedAndUntrackedFiles(root = REPO_ROOT) {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  ).split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll("\\", "/"));
}

function isWithinRoot(root, candidate) {
  const candidateRelative = relative(root, candidate);
  return candidateRelative === ""
    || (!isAbsolute(candidateRelative)
      && candidateRelative !== ".."
      && !candidateRelative.startsWith(`..${sep}`));
}

export function stripLinkTitle(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  return /^(\S+)/.exec(trimmed)?.[1] ?? trimmed;
}

export function extractMarkdownLinks(markdown) {
  const links = [];
  let fenced = false;
  const lines = markdown.replaceAll("\r", "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    for (const match of line.matchAll(/!?\[[^\]]*\]\(([^)]*)\)/g)) {
      links.push({ destination: stripLinkTitle(match[1]), line: index + 1 });
    }
    const reference = /^\s*\[[^\]]+\]:\s*(\S+(?:\s+.*)?)$/.exec(line);
    if (reference) links.push({ destination: stripLinkTitle(reference[1]), line: index + 1 });
  }
  return links;
}

function stripHeadingMarkup(value) {
  let current = value;
  let previous;
  do {
    previous = current;
    current = current
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "");
  } while (current !== previous);
  return current;
}

export function githubSlug(value) {
  return stripHeadingMarkup(value)
    .replace(/[`*_~]/g, "")
    .replace(/&[a-z0-9#]+;/gi, "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

export function markdownAnchors(markdown) {
  const anchors = new Set();
  const counts = new Map();
  let fenced = false;
  for (const line of markdown.replaceAll("\r", "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const base = githubSlug(heading[1]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function decodePath(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function asRepositoryDestination(destination) {
  const internal = /^https:\/\/github\.com\/Cheurteenyt\/Ariad\/(?:blob|tree)\/main\/([^#?]+)(#[^?]*)?$/i.exec(destination);
  if (internal) return {
    repositoryPath: decodePath(internal[1]),
    fragment: internal[2]?.slice(1) ?? "",
    repositoryAbsolute: true,
  };
  if (/^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith("//")) return null;

  const hashIndex = destination.indexOf("#");
  const queryIndex = destination.indexOf("?");
  const boundaries = [hashIndex, queryIndex].filter((value) => value >= 0);
  const boundary = boundaries.length > 0 ? Math.min(...boundaries) : destination.length;
  const path = decodePath(destination.slice(0, boundary));
  const fragment = hashIndex >= 0
    ? destination.slice(hashIndex + 1, queryIndex > hashIndex ? queryIndex : undefined)
    : "";
  return { repositoryPath: path, fragment, repositoryAbsolute: path.startsWith("/") };
}

export function resolveMarkdownDestination(sourcePath, destination) {
  const parsed = asRepositoryDestination(destination);
  if (!parsed) return null;
  const repositoryPath = parsed.repositoryAbsolute
    ? posix.normalize(parsed.repositoryPath.replace(/^\/+/, ""))
    : parsed.repositoryPath === ""
    ? sourcePath
    : posix.normalize(posix.join(posix.dirname(sourcePath), parsed.repositoryPath));
  return {
    repositoryPath,
    fragment: decodePath(parsed.fragment).toLocaleLowerCase("en-US"),
  };
}

function metadataErrors(path, markdown) {
  const header = markdown.replaceAll("\r", "").split("\n").slice(0, 16).join("\n");
  const missing = [];
  if (!/\*\*Status:\*\*/i.test(header)) missing.push("Status");
  if (!/\*\*Audience:\*\*/i.test(header)) missing.push("Audience");
  if (!/\*\*Last verified:\*\*/i.test(header)) missing.push("Last verified");
  return missing.map((field) => `${path}: missing '${field}' metadata in the first 16 lines`);
}

function isActiveDocument(path) {
  if (path === PORTAL || path === "graph-ui/README.md" || path === "docs/ai/README.md") return true;
  return ACTIVE_PREFIXES.some((prefix) => path.startsWith(prefix))
    && !ACTIVE_EXCLUSIONS.some((prefix) => path.startsWith(prefix));
}

export function validateDocumentation({ root = REPO_ROOT } = {}) {
  const errors = [];
  const files = trackedAndUntrackedFiles(root);
  const markdownPaths = files.filter((path) => path.endsWith(".md") && !FROZEN_EXTERNAL_DOCS.has(path));
  const markdownSet = new Set(markdownPaths);
  const markdownByPath = new Map(markdownPaths.map((path) => [path, readFileSync(resolve(root, path), "utf8")]));
  const anchorsByPath = new Map();
  const graph = new Map(markdownPaths.map((path) => [path, new Set()]));

  for (const path of markdownPaths) {
    const markdown = markdownByPath.get(path);
    if (isActiveDocument(path)) errors.push(...metadataErrors(path, markdown));

    for (const { destination, line } of extractMarkdownLinks(markdown)) {
      if (!destination) continue;
      const resolved = resolveMarkdownDestination(path, destination);
      if (!resolved) continue;
      const target = resolved.repositoryPath;
      const absoluteTarget = resolve(root, target);
      if (!isWithinRoot(root, absoluteTarget)) {
        errors.push(`${path}:${line}: local link escapes the repository '${destination}'`);
        continue;
      }
      if (!existsSync(absoluteTarget)) {
        errors.push(`${path}:${line}: broken local link '${destination}' -> '${target}'`);
        continue;
      }
      if (statSync(absoluteTarget).isDirectory()) {
        const readme = posix.join(target, "README.md");
        if (markdownSet.has(readme)) graph.get(path).add(readme);
        if (resolved.fragment) errors.push(`${path}:${line}: directory link cannot target anchor '#${resolved.fragment}'`);
        continue;
      }
      if (markdownSet.has(target)) graph.get(path).add(target);
      if (resolved.fragment && target.endsWith(".md")) {
        if (!anchorsByPath.has(target)) anchorsByPath.set(target, markdownAnchors(markdownByPath.get(target)));
        if (!anchorsByPath.get(target).has(resolved.fragment)) {
          errors.push(`${path}:${line}: missing anchor '#${resolved.fragment}' in '${target}'`);
        }
      }
    }
  }

  const docsTopLevel = files
    .filter((path) => path.startsWith("docs/"))
    .map((path) => path.slice("docs/".length).split("/")[0]);
  for (const entry of new Set(docsTopLevel)) {
    if (!ALLOWED_DOCS_ROOTS.has(entry)) errors.push(`docs/${entry}: unclassified top-level documentation entry`);
  }
  for (const path of markdownPaths.filter((item) => item.startsWith("docs/") && !item.slice(5).includes("/"))) {
    if (path !== PORTAL) errors.push(`${path}: only docs/README.md may live at the documentation root`);
  }

  const reachable = new Set();
  const queue = [PORTAL];
  while (queue.length > 0) {
    const path = queue.shift();
    if (reachable.has(path) || !graph.has(path)) continue;
    reachable.add(path);
    for (const target of graph.get(path)) queue.push(target);
  }
  for (const path of markdownPaths.filter((item) => item.startsWith("docs/"))) {
    if (!reachable.has(path)) errors.push(`${path}: unreachable from ${PORTAL}`);
  }

  return {
    errors,
    markdownCount: markdownPaths.length,
    activeCount: markdownPaths.filter(isActiveDocument).length,
    reachableCount: [...reachable].filter((path) => path.startsWith("docs/")).length,
  };
}

function main() {
  const result = validateDocumentation();
  if (result.errors.length > 0) {
    console.error(`Documentation validation failed with ${result.errors.length} error(s):`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Documentation valid: ${result.markdownCount} Markdown files, ${result.activeCount} active, ${result.reachableCount} docs reachable from ${PORTAL}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
