import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const defaultDistDir = fileURLToPath(new URL("../dist/", import.meta.url));
const distDir = resolve(process.argv[2] ?? defaultDistDir);
const html = readFileSync(resolve(distDir, "index.html"), "utf8");
const manifest = JSON.parse(
  readFileSync(resolve(distDir, ".vite", "manifest.json"), "utf8"),
);

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "iu"));
  return match?.[1] ?? null;
}

function normalizeHtmlAsset(reference) {
  const parsed = new URL(reference, "https://codebase-memory.invalid/");
  if (parsed.origin !== "https://codebase-memory.invalid") {
    throw new Error(`External entry asset is not supported: ${reference}`);
  }
  return decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
}

function exactlyOne(values, description) {
  if (values.length !== 1) {
    throw new Error(`Expected exactly one ${description}, found ${values.length}`);
  }
  return values[0];
}

const htmlModuleScripts = new Set(
  [...html.matchAll(/<script\b[^>]*>/giu)]
    .filter(([tag]) => attribute(tag, "type")?.toLowerCase() === "module")
    .map(([tag]) => attribute(tag, "src"))
    .filter((value) => value != null)
    .map(normalizeHtmlAsset),
);
const htmlStyleSheets = new Set(
  [...html.matchAll(/<link\b[^>]*>/giu)]
    .filter(([tag]) => attribute(tag, "rel")?.toLowerCase().split(/\s+/u).includes("stylesheet"))
    .map(([tag]) => attribute(tag, "href"))
    .filter((value) => value != null)
    .map(normalizeHtmlAsset),
);

const manifestEntries = Object.entries(manifest);
const [mainKey, mainChunk] = exactlyOne(
  manifestEntries.filter(([, chunk]) => chunk.isEntry === true && htmlModuleScripts.has(chunk.file)),
  "manifest entry referenced by dist/index.html",
);
const mainCssPath = exactlyOne(
  (mainChunk.css ?? []).filter((file) => htmlStyleSheets.has(file)),
  `stylesheet shared by HTML and manifest entry ${mainKey}`,
);

const [graphKey, graphChunk] = exactlyOne(
  manifestEntries.filter(([key, chunk]) => (
    key === "src/components/GraphTab.tsx" || chunk.name === "GraphTab"
  ) && chunk.isDynamicEntry === true),
  "GraphTab dynamic entry",
);
if (!(mainChunk.dynamicImports ?? []).includes(graphKey)) {
  throw new Error(`Manifest entry ${mainKey} does not dynamically import ${graphKey}`);
}

function readAsset(file) {
  const absolutePath = resolve(distDir, file);
  const relativePath = relative(distDir, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Manifest asset escapes dist: ${file}`);
  }
  const bytes = readFileSync(absolutePath);
  return {
    name: file,
    raw: bytes.byteLength,
    gzip: gzipSync(bytes, { level: 9 }).byteLength,
  };
}

const graphAsset = readAsset(graphChunk.file);
const mainAsset = readAsset(mainChunk.file);
const cssAsset = readAsset(mainCssPath);
const javascriptAssets = [...new Set(
  manifestEntries
    .map(([, chunk]) => chunk.file)
    .filter((file) => typeof file === "string" && file.endsWith(".js")),
)].sort().map(readAsset);
const stylesheetAssets = [...new Set(
  manifestEntries.flatMap(([, chunk]) => chunk.css ?? []),
)].sort().map(readAsset);

const kib = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`;
const fail = (message) => {
  console.error(`Bundle budget exceeded: ${message}`);
  process.exitCode = 1;
};

const budgets = {
  graphGzip: 40 * 1024,
  mainGzip: 80 * 1024,
  cssGzip: 15 * 1024,
  totalCssGzip: 18 * 1024,
  totalJsGzip: 125 * 1024,
};
const totalJsGzip = javascriptAssets.reduce((sum, asset) => sum + asset.gzip, 0);
const totalCssGzip = stylesheetAssets.reduce((sum, asset) => sum + asset.gzip, 0);

if (graphAsset.gzip > budgets.graphGzip) {
  fail(`${graphAsset.name} is ${kib(graphAsset.gzip)} (limit ${kib(budgets.graphGzip)})`);
}
if (mainAsset.gzip > budgets.mainGzip) {
  fail(`${mainAsset.name} is ${kib(mainAsset.gzip)} (limit ${kib(budgets.mainGzip)})`);
}
if (cssAsset.gzip > budgets.cssGzip) {
  fail(`${cssAsset.name} is ${kib(cssAsset.gzip)} (limit ${kib(budgets.cssGzip)})`);
}
if (totalCssGzip > budgets.totalCssGzip) {
  fail(`manifest CSS is ${kib(totalCssGzip)} (limit ${kib(budgets.totalCssGzip)})`);
}
if (totalJsGzip > budgets.totalJsGzip) {
  fail(`manifest JavaScript is ${kib(totalJsGzip)} (limit ${kib(budgets.totalJsGzip)})`);
}

console.log(
  `Bundle budgets: Graph ${graphAsset.name} ${kib(graphAsset.gzip)}, `
  + `main ${mainAsset.name} ${kib(mainAsset.gzip)}, `
  + `CSS ${cssAsset.name} ${kib(cssAsset.gzip)}, `
  + `manifest CSS ${kib(totalCssGzip)}, `
  + `manifest JS ${kib(totalJsGzip)}`,
);
