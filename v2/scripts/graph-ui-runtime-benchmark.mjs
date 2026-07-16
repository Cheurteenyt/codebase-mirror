import { performance } from "node:perf_hooks";

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? "" : fallback;
}

const baseUrl = String(option("base-url", "http://127.0.0.1:9749")).replace(/\/$/u, "");
const project = option("project");
const query = option("query");
const runs = Number(option("runs", "5"));
if (!project || !query || !Number.isSafeInteger(runs) || runs < 1 || runs > 50) {
  console.error(
    "Usage: npm run bench:graph-ui -- --project <name> --query <known-symbol> "
    + "[--base-url http://127.0.0.1:9749] [--runs 5]",
  );
  process.exit(2);
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function timingSummary(values) {
  return {
    runs: values.length,
    p50_ms: Number(percentile(values, 0.5).toFixed(3)),
    p95_ms: Number(percentile(values, 0.95).toFixed(3)),
    min_ms: Number(Math.min(...values).toFixed(3)),
    max_ms: Number(Math.max(...values).toFixed(3)),
  };
}

async function requestJson(path, acceptEncoding = "gzip") {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "Accept-Encoding": acceptEncoding },
  });
  const wireBytes = Number(response.headers.get("content-length"));
  const body = await response.arrayBuffer();
  const elapsedMs = performance.now() - started;
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${Buffer.from(body).toString("utf8").slice(0, 500)}`);
  }
  return {
    json: JSON.parse(Buffer.from(body).toString("utf8")),
    elapsedMs,
    wireBytes: Number.isFinite(wireBytes) ? wireBytes : null,
    decodedBytes: body.byteLength,
    etag: response.headers.get("etag"),
  };
}

async function measure(path, acceptEncoding = "gzip") {
  const samples = [];
  let last;
  for (let index = 0; index < runs; index += 1) {
    last = await requestJson(path, acceptEncoding);
    samples.push(last.elapsedMs);
  }
  return { last, timing: timingSummary(samples) };
}

const encodedProject = encodeURIComponent(project);
const layoutPath = `/api/layout?project=${encodedProject}&max_nodes=1000`;
// Prime SQLite/page/compression caches separately from the measured samples.
await requestJson(layoutPath, "identity");
const identityLayout = await measure(layoutPath, "identity");
const gzipLayout = await measure(layoutPath, "gzip");
const layout = identityLayout.last.json;
if (layout.contract_version !== 1 || layout.layout?.domain_catalog?.exact !== true) {
  throw new Error("Layout did not expose contract_version=1 and an exact domain catalog");
}
const catalogTotal = layout.layout.domain_catalog.domains
  .reduce((sum, domain) => sum + domain.node_count, 0);
if (catalogTotal !== layout.total_nodes) {
  throw new Error(`Exact domain catalog covers ${catalogTotal} of ${layout.total_nodes} nodes`);
}

const searchPath = `/api/node-search?project=${encodedProject}&q=${encodeURIComponent(query)}&limit=50`;
const searchResult = await measure(searchPath);
const search = searchResult.last.json;
if (
  search.contract_version !== 1
  || search.exact !== true
  || search.total_matches < 1
  || !/^graph-reader-v1:[A-Za-z0-9_-]{22}$/u.test(search.graph_revision)
  || search.graph_revision !== layout.graph_revision
) {
  throw new Error(`Exact search did not find the known query: ${query}`);
}

const anchorId = search.nodes[0]?.id;
if (!Number.isSafeInteger(anchorId)) throw new Error("Exact search returned no valid anchor node id");
const neighborhoodPath = `/api/neighborhood?project=${encodedProject}&node_id=${anchorId}&limit=100`;
const neighborhoodResult = await measure(neighborhoodPath);
const neighborhood = neighborhoodResult.last.json;
if (
  neighborhood.contract_version !== 1
  || neighborhood.exact !== true
  || neighborhood.graph_revision !== search.graph_revision
) {
  throw new Error("Neighborhood response is not exact or versioned");
}

const scopeKey = layout.layout.domain_catalog.domains[0]?.key;
if (typeof scopeKey !== "string" || scopeKey.length === 0) {
  throw new Error("Exact domain catalog returned no benchmarkable scope");
}
const scopePath = `/api/scope?project=${encodedProject}&kind=domain&key=${encodeURIComponent(scopeKey)}&limit=125`;
const scopeResult = await measure(scopePath);
const scope = scopeResult.last.json;
if (
  scope.contract_version !== 1
  || scope.exact !== true
  || scope.graph_revision !== search.graph_revision
  || scope.scope?.kind !== "domain"
  || scope.scope?.key !== scopeKey
  || scope.page?.returned_nodes !== scope.nodes?.length
  || scope.page?.returned_edges !== scope.edges?.length
) {
  throw new Error("Scope response is not exact, bounded, or versioned");
}

const rawBytes = identityLayout.last.wireBytes ?? identityLayout.last.decodedBytes;
const gzipBytes = gzipLayout.last.wireBytes;
const report = {
  benchmark_version: 1,
  base_url: baseUrl,
  project,
  query,
  graph: {
    total_nodes: layout.total_nodes,
    returned_nodes: layout.returned_nodes,
    returned_edges: layout.edges?.length ?? 0,
    exact_domains: layout.layout.domain_catalog.total_domains,
    represented_communities: layout.layout.clusters?.length ?? 0,
    graph_revision: search.graph_revision,
  },
  layout_identity: {
    ...identityLayout.timing,
    bytes: rawBytes,
  },
  layout_gzip: {
    ...gzipLayout.timing,
    bytes: gzipBytes,
    saved_percent: gzipBytes == null ? null : Number(((1 - gzipBytes / rawBytes) * 100).toFixed(2)),
  },
  exact_search: {
    ...searchResult.timing,
    total_matches: search.total_matches,
    returned_nodes: search.returned_nodes,
    wire_bytes: searchResult.last.wireBytes,
  },
  exact_neighborhood: {
    ...neighborhoodResult.timing,
    anchor_id: anchorId,
    total_connections: neighborhood.anchor.total_unique_edges,
    returned_edges: neighborhood.edges.length,
    wire_bytes: neighborhoodResult.last.wireBytes,
  },
  exact_scope: {
    ...scopeResult.timing,
    kind: "domain",
    key: scopeKey,
    total_nodes: scope.scope.total_nodes,
    total_internal_edges: scope.scope.total_internal_edges,
    returned_nodes: scope.nodes.length,
    returned_edges: scope.edges.length,
    complete: scope.complete,
    wire_bytes: scopeResult.last.wireBytes,
  },
};

console.log(JSON.stringify(report, null, 2));
