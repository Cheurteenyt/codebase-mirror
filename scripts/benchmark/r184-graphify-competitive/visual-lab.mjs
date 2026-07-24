#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

import { sha256File, writeJsonExclusive } from './core.mjs';
import {
  blindAssignment,
  evaluateTask,
  frameSummary,
  percentile,
  summarizeVisualSamples,
} from './visual-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const requireFromV2 = createRequire(join(repoRoot, 'v2', 'package.json'));
const { chromium } = requireFromV2('playwright-core');
const Database = requireFromV2('better-sqlite3');
const tasksSpec = JSON.parse(readFileSync(join(here, 'visual-tasks.json'), 'utf8'));

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2).replaceAll('-', '_');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function integer(value, fallback, minimum, maximum, role) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${role} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function assertExternal(path) {
  const rel = relative(repoRoot, path);
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`))) {
    throw new Error(`Visual results must stay outside the checkout: ${path}`);
  }
}

function runtime(labRoot, phase, target, repetition = 4) {
  const graphifyRun = join(
    labRoot, 'state', 'index-runs', phase, 'graphify', target, `r${repetition}`,
  );
  const ariadRun = join(
    labRoot, 'state', 'index-runs', phase, 'ariad', target, `r${repetition}`,
  );
  return {
    target,
    source: join(labRoot, 'targets', target),
    graphifyGraph: join(graphifyRun, 'source', 'graphify-out', 'graph.json'),
    graphifyHtml: join(graphifyRun, 'source', 'graphify-out', 'graph.html'),
    ariadCache: join(ariadRun, 'cache'),
    ariadDb: join(
      ariadRun,
      'cache',
      'codebase-memory-mcp',
      `r184-${phase}-${target}-r${repetition}.db`,
    ),
    ariadProject: `r184-${phase}-${target}-r${repetition}`,
  };
}

function graphifyTopology(graphPath, htmlPath) {
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  const edges = Array.isArray(graph.links) ? graph.links : graph.edges;
  if (!Array.isArray(graph.nodes) || !Array.isArray(edges)) {
    throw new Error(`Invalid Graphify graph: ${graphPath}`);
  }
  const html = readFileSync(htmlPath, 'utf8');
  const embedded = html.match(
    /const RAW_NODES = (\[[\s\S]*?\]);\r?\nconst RAW_EDGES = (\[[\s\S]*?\]);\r?\nconst LEGEND =/u,
  );
  if (!embedded) throw new Error(`Unable to parse Graphify's shipped HTML payload: ${htmlPath}`);
  const renderedNodes = JSON.parse(embedded[1]);
  const renderedEdges = JSON.parse(embedded[2]);
  return {
    artifact_total_nodes: graph.nodes.length,
    artifact_total_edges: edges.length,
    returned_nodes: renderedNodes.length,
    returned_edges: renderedEdges.length,
    artifact_sha256: sha256File(graphPath),
    html_sha256: sha256File(htmlPath),
  };
}

function ariadTopology(dbPath) {
  const database = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return {
      total_nodes: database.prepare('SELECT COUNT(*) AS count FROM nodes').get().count,
      total_edges: database.prepare('SELECT COUNT(*) AS count FROM edges').get().count,
      artifact_bytes: statSync(dbPath).size,
      artifact_sha256: sha256File(dbPath),
    };
  } finally {
    database.close();
  }
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a loopback port');
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return address.port;
}

async function startStaticGraphify(htmlPath) {
  const graphPath = join(dirname(htmlPath), 'graph.json');
  const html = readFileSync(htmlPath);
  const graph = readFileSync(graphPath);
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/' || path === '/graph.html') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(html.byteLength),
        'Cache-Control': 'public, max-age=3600',
      });
      response.end(html);
      return;
    }
    if (path === '/graph.json') {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(graph.byteLength),
        'Cache-Control': 'public, max-age=3600',
      });
      response.end(graph);
      return;
    }
    if (path === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Graphify server has no TCP address');
  return {
    url: `http://127.0.0.1:${address.port}/graph.html`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    }),
  };
}

async function waitForHttp(url, process, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (process.exitCode != null) {
      throw new Error(`Ariad UI exited before readiness with code ${process.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Expected while the server binds.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startAriad(state, outputDir) {
  const port = await freePort();
  const stdoutPath = join(outputDir, `${state.target}.ariad-server.stdout.txt`);
  const stderrPath = join(outputDir, `${state.target}.ariad-server.stderr.txt`);
  const stdout = createWriteStream(stdoutPath, { flags: 'wx' });
  const stderr = createWriteStream(stderrPath, { flags: 'wx' });
  const child = spawn(
    process.execPath,
    [
      join(repoRoot, 'v2', 'dist', 'cli', 'index.js'),
      'ui',
      '--project', state.ariadProject,
      '--port', String(port),
      '--graph-ui-path', join(repoRoot, 'graph-ui', 'dist'),
      '--allowed-root', state.source,
    ],
    {
      cwd: state.source,
      env: { ...process.env, XDG_CACHE_HOME: state.ariadCache },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${baseUrl}/?tab=graph&project=${encodeURIComponent(state.ariadProject)}`, child);
  } catch (error) {
    child.kill();
    throw error;
  }
  return {
    url: `${baseUrl}/?tab=graph&project=${encodeURIComponent(state.ariadProject)}`,
    baseUrl,
    stdoutPath,
    stderrPath,
    async close() {
      if (child.exitCode == null) {
        child.kill();
        if (child.exitCode == null) {
          await Promise.race([
            once(child, 'exit'),
            new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
          ]);
        }
      }
      if (!stdout.closed) stdout.end();
      if (!stderr.closed) stderr.end();
      await Promise.all([
        finished(stdout).catch(() => undefined),
        finished(stderr).catch(() => undefined),
      ]);
    },
  };
}

async function launchBrowser(executable) {
  const common = {
    headless: true,
    args: [
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
    ],
  };
  if (executable) return chromium.launch({ ...common, executablePath: resolve(executable) });
  if (process.platform === 'win32') return chromium.launch({ ...common, channel: 'msedge' });
  throw new Error('Pass --browser-executable outside Windows');
}

async function instrument(page, product) {
  await page.addInitScript(({ variant }) => {
    const state = {
      variant,
      firstUsableRenderMs: null,
      longTasks: [],
      activeFrames: null,
      beginFrames() {
        if (this.activeFrames) return;
        this.activeFrames = [];
        const collect = (timestamp) => {
          if (!this.activeFrames) return;
          this.activeFrames.push(timestamp);
          requestAnimationFrame(collect);
        };
        requestAnimationFrame(collect);
      },
      endFrames() {
        const frames = this.activeFrames ?? [];
        this.activeFrames = null;
        return frames;
      },
    };
    window.__R184_VISUAL_LAB__ = state;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({ start: entry.startTime, duration: entry.duration });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      // Long task entries are an optional native browser capability.
    }
    let readyFrames = 0;
    const observe = (timestamp) => {
      const canvas = document.querySelector('canvas');
      const canvasReady = canvas && canvas.width > 0 && canvas.height > 0;
      const productReady = variant === 'graphify'
        ? document.querySelector('#search') != null
        : performance.getEntriesByType('resource').some((entry) => entry.name.includes('/api/layout?'));
      readyFrames = canvasReady && productReady ? readyFrames + 1 : 0;
      if (readyFrames >= 2) {
        state.firstUsableRenderMs = timestamp;
        return;
      }
      requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
  }, { variant: product });
  if (product === 'ariad') {
    await page.addInitScript(() => {
      localStorage.setItem('cbm-graph-visual-mode', 'architecture');
    });
  }
}

function metric(metrics, name) {
  return metrics.find((entry) => entry.name === name)?.value ?? 0;
}

async function performanceMetrics(session) {
  const result = await session.send('Performance.getMetrics');
  return {
    taskDuration: metric(result.metrics, 'TaskDuration'),
    heap: metric(result.metrics, 'JSHeapUsedSize'),
  };
}

async function measureIdle(session, milliseconds) {
  const before = await performanceMetrics(session);
  const started = Date.now();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
  const after = await performanceMetrics(session);
  const seconds = Math.max(0.001, (Date.now() - started) / 1000);
  await session.send('HeapProfiler.collectGarbage');
  const retained = await performanceMetrics(session);
  return {
    idle_cpu_percent: Number((((after.taskDuration - before.taskDuration) / seconds) * 100).toFixed(3)),
    heap_before_gc_mib: Number((after.heap / 1024 / 1024).toFixed(3)),
    heap_mib: Number((retained.heap / 1024 / 1024).toFixed(3)),
  };
}

async function exerciseCanvas(page, durationMs) {
  const canvas = page.locator('canvas').first();
  await canvas.waitFor({ state: 'visible' });
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Rendered graph canvas has no bounding box');
  await page.evaluate(() => window.__R184_VISUAL_LAB__.beginFrames());
  const x = box.x + (box.width / 2);
  const y = box.y + (box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -360);
  await page.mouse.down();
  await page.mouse.move(x + Math.min(140, box.width / 4), y + Math.min(80, box.height / 5), {
    steps: 10,
  });
  await page.mouse.up();
  await page.mouse.wheel(0, 220);
  await page.waitForTimeout(durationMs);
  const timestamps = await page.evaluate(() => window.__R184_VISUAL_LAB__.endFrames());
  return frameSummary(timestamps);
}

async function openAriadSearch(page, viewport, actions) {
  const input = page.getByRole('textbox', { name: 'Search paths or symbols' });
  if (await input.isVisible().catch(() => false)) return input;
  if (viewport.id === 'narrow') {
    await page.getByRole('button', { name: 'Open graph filters' }).click();
    actions.push('open-graph-filters');
    await input.waitFor({ state: 'visible' });
    return input;
  }
  throw new Error('Ariad search control is not visible');
}

async function searchGraphify(page, query, actions) {
  const input = page.locator('#search');
  await input.fill(query);
  actions.push(`search:${query}`);
  const results = page.locator('.search-item');
  await page.waitForTimeout(100);
  const count = await results.count();
  if (count === 0) return { found: false, evidence: '' };
  let selected = results.filter({ hasText: query }).first();
  if (await selected.count() === 0) selected = results.first();
  const resultText = (await selected.textContent())?.trim() ?? '';
  await selected.click();
  actions.push(`open:${resultText}`);
  await page.waitForTimeout(250);
  const evidence = (await page.locator('#info-content').textContent())?.trim() ?? '';
  return {
    found: evidence.toLowerCase().includes(query.toLowerCase()),
    evidence,
  };
}

async function searchAriad(page, query, viewport, actions) {
  const input = await openAriadSearch(page, viewport, actions);
  await input.fill(query);
  actions.push(`search:${query}`);
  const exactStatus = page.getByText(/Exact project search/u).first();
  await exactStatus.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
  const exact = page.getByRole('button', { name: new RegExp(`^Open ${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`, 'iu') }).first();
  const fallback = page.getByRole('button', { name: new RegExp(`Open .*${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu') }).first();
  const selected = await exact.count() > 0 ? exact : fallback;
  if (await selected.count() === 0) return { found: false, evidence: '' };
  const resultName = await selected.getAttribute('aria-label') ?? query;
  await selected.click();
  actions.push(`open:${resultName}`);
  await page.locator('.nd-close').waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
  const detail = page.locator('.nd-panel');
  const evidence = await detail.count() > 0
    ? (await detail.textContent())?.trim() ?? ''
    : (await page.locator('body').textContent())?.trim() ?? '';
  return {
    found: evidence.toLowerCase().includes(query.toLowerCase()),
    evidence,
  };
}

async function nativeRestore(page, product, actions) {
  if (product === 'graphify') {
    const graph = page.locator('#graph');
    const box = await graph.boundingBox();
    if (!box) return { restored: false, contextLoss: 1, evidence: 'graph has no bounding box' };
    await page.mouse.click(box.x + 8, box.y + 8);
    actions.push('click-graph-background');
    await page.waitForTimeout(100);
    const text = (await page.locator('#info-content').textContent())?.trim() ?? '';
    return {
      restored: /Click a node to inspect it/iu.test(text),
      contextLoss: 0,
      evidence: text,
    };
  }
  const close = page.locator('.nd-close');
  if (await close.isVisible().catch(() => false)) {
    await close.click();
    actions.push('close-node-details');
  }
  const structure = page.getByRole('button', { name: 'Structure', exact: true });
  if (await structure.isVisible().catch(() => false)) {
    await structure.click();
    actions.push('return-structure');
  }
  const fit = page.getByRole('button', { name: 'Fit', exact: true });
  if (await fit.isVisible().catch(() => false)) {
    await fit.click();
    actions.push('fit-overview');
  }
  const detailStillVisible = await page.locator('.nd-panel').isVisible().catch(() => false);
  return {
    restored: !detailStillVisible && await page.locator('canvas').isVisible(),
    contextLoss: 0,
    evidence: detailStillVisible ? 'node detail remained visible' : 'detail closed and graph visible',
  };
}

async function largestAreas(page, product, viewport, actions) {
  if (product === 'graphify') {
    const labels = (await page.locator('.legend-item .legend-label').allTextContents())
      .map((value) => value.trim())
      .filter(Boolean);
    return { visible: labels.length >= 3, evidence: labels.slice(0, 5) };
  }
  const tree = page.getByRole('tree', { name: 'Structure tree' });
  let visible = await tree.isVisible().catch(() => false);
  if (!visible && viewport.id === 'narrow') {
    const open = page.getByRole('button', { name: 'Open graph filters' });
    if (await open.isVisible().catch(() => false)) {
      await open.click();
      actions.push('open-graph-filters-for-architecture');
      visible = await tree.isVisible().catch(() => false);
    }
  }
  const text = visible ? (await tree.textContent())?.trim() ?? '' : '';
  const topLevel = visible ? await tree.locator(':scope > button, :scope > div').count() : 0;
  return {
    visible: visible && (topLevel >= 3 || text.split(/\s+/u).filter(Boolean).length >= 3),
    evidence: text.slice(0, 600),
  };
}

async function runTask(page, product, target, viewport, preTaskAudit) {
  const actions = [];
  const started = performance.now();
  if (target === 'fixture') {
    const areas = await largestAreas(page, product, viewport, actions);
    const commit = product === 'graphify'
      ? await searchGraphify(page, 'commitDelivery', actions)
      : await searchAriad(page, 'commitDelivery', viewport, actions);
    const run = product === 'graphify'
      ? await searchGraphify(page, 'runPipeline', actions)
      : await searchAriad(page, 'runPipeline', viewport, actions);
    const directional = product === 'ariad'
      && /\bReferences\b/iu.test(run.evidence)
      && /\bcommitDelivery\b/iu.test(run.evidence);
    const restore = await nativeRestore(page, product, actions);
    const observations = {
      largest_areas_visible: areas.visible,
      commit_delivery_located: commit.found,
      run_pipeline_direction_visible: directional,
      architecture_context_restored: restore.restored,
    };
    return {
      task_id: 'T09',
      task: evaluateTask(
        tasksSpec.tasks.find((task) => task.id === 'T09').mechanical_signals,
        observations,
      ),
      task_time_ms: Number((performance.now() - started).toFixed(3)),
      actions,
      context_loss_events: restore.contextLoss,
      evidence: {
        largest_areas: areas.evidence,
        commit_delivery: commit.evidence.slice(0, 2_000),
        run_pipeline: run.evidence.slice(0, 2_000),
        restore: restore.evidence,
      },
    };
  }

  const bench = product === 'graphify'
    ? await searchGraphify(page, 'packages/bench', actions)
    : await searchAriad(page, 'packages/bench', viewport, actions);
  const dependencyDirection = product === 'ariad'
    && /\bpackages[\\/]zod\b/iu.test(bench.evidence)
    && /\bReferences\b/iu.test(bench.evidence);
  const zodNext = product === 'graphify'
    ? await searchGraphify(page, 'zodNext', actions)
    : await searchAriad(page, 'zodNext', viewport, actions);
  const restore = await nativeRestore(page, product, actions);
  const observations = {
    packages_bench_located: bench.found,
    packages_bench_to_zod_direction_visible: dependencyDirection,
    zod_next_exact_evidence_located: zodNext.found && /packages[\\/].*bench/iu.test(zodNext.evidence),
    selection_cleared: restore.restored,
    overview_restored: restore.restored,
    narrow_viewport_unclipped: viewport.id !== 'narrow'
      || preTaskAudit.clippingFailures.length === 0,
  };
  return {
    task_id: 'T10',
    task: evaluateTask(
      tasksSpec.tasks.find((task) => task.id === 'T10').mechanical_signals,
      observations,
    ),
    task_time_ms: Number((performance.now() - started).toFixed(3)),
    actions,
    context_loss_events: restore.contextLoss,
    evidence: {
      packages_bench: bench.evidence.slice(0, 2_000),
      zod_next: zodNext.evidence.slice(0, 2_000),
      restore: restore.evidence,
    },
  };
}

async function auditDom(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number(style.opacity) !== 0
        && rect.width > 0
        && rect.height > 0
        && rect.right > 0
        && rect.bottom > 0
        && rect.left < innerWidth
        && rect.top < innerHeight;
    };
    const label = (element) => (
      element.getAttribute('aria-label')
      || element.getAttribute('title')
      || element.textContent?.trim()
      || element.getAttribute('placeholder')
      || element.tagName.toLowerCase()
    ).slice(0, 120);
    const interactives = [...document.querySelectorAll('button,input,a[href],[role="button"]')]
      .filter(visible);
    const clippingFailures = interactives.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.top < -1
        || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1
        ? [{ element: label(element), rect: {
            left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          } }]
        : [];
    });
    const overlapFailures = [];
    for (let leftIndex = 0; leftIndex < interactives.length; leftIndex += 1) {
      const left = interactives[leftIndex];
      const leftRect = left.getBoundingClientRect();
      for (let rightIndex = leftIndex + 1; rightIndex < interactives.length; rightIndex += 1) {
        const right = interactives[rightIndex];
        if (left.contains(right) || right.contains(left)) continue;
        const rightRect = right.getBoundingClientRect();
        const width = Math.max(0, Math.min(leftRect.right, rightRect.right) - Math.max(leftRect.left, rightRect.left));
        const height = Math.max(0, Math.min(leftRect.bottom, rightRect.bottom) - Math.max(leftRect.top, rightRect.top));
        const intersection = width * height;
        const smaller = Math.min(leftRect.width * leftRect.height, rightRect.width * rightRect.height);
        if (smaller > 0 && intersection / smaller >= 0.35) {
          overlapFailures.push({ left: label(left), right: label(right), overlap_ratio: intersection / smaller });
        }
      }
    }
    const accessibilityFailures = [];
    for (const element of interactives) {
      const name = element.getAttribute('aria-label')
        || element.getAttribute('title')
        || element.textContent?.trim()
        || (element instanceof HTMLInputElement ? element.labels?.[0]?.textContent?.trim() : '');
      if (!name) accessibilityFailures.push({ element: element.outerHTML.slice(0, 240), issue: 'missing accessible name' });
    }
    for (const canvas of [...document.querySelectorAll('canvas')].filter(visible)) {
      if (!canvas.getAttribute('aria-label')) {
        accessibilityFailures.push({ element: '<canvas>', issue: 'missing accessible name' });
      }
    }
    for (const image of [...document.querySelectorAll('img')].filter(visible)) {
      if (!image.hasAttribute('alt')) {
        accessibilityFailures.push({ element: image.outerHTML.slice(0, 240), issue: 'missing alt' });
      }
    }
    return {
      clippingFailures,
      overlapFailures,
      accessibilityFailures,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
}

async function measurePage({
  browser,
  context,
  product,
  url,
  state,
  phase,
  run,
  viewport,
  screenshot,
  interactionMs,
  idleMs,
  expected,
  prime = false,
}) {
  const ownsContext = context == null;
  const activeContext = context ?? await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    locale: 'en-US',
    serviceWorkers: 'block',
  });
  const page = await activeContext.newPage();
  const session = await activeContext.newCDPSession(page);
  const consoleErrors = [];
  const pageErrors = [];
  const httpErrors = [];
  const layoutResponses = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    const responseUrl = response.url();
    if (response.status() >= 400 && !responseUrl.endsWith('/favicon.ico')) {
      httpErrors.push({ status: response.status(), url: responseUrl });
    }
    if (product === 'ariad' && response.ok() && responseUrl.includes('/api/layout?')) {
      layoutResponses.push(response.json().catch((error) => ({ parse_error: String(error) })));
    }
  });
  await session.send('Performance.enable');
  await session.send('HeapProfiler.enable');
  if (phase === 'cold') {
    await session.send('Network.enable');
    await session.send('Network.clearBrowserCache');
  }
  await instrument(page, product);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(
      () => window.__R184_VISUAL_LAB__?.firstUsableRenderMs != null,
      undefined,
      { timeout: 60_000 },
    );
    const firstUsable = await page.evaluate(() => window.__R184_VISUAL_LAB__.firstUsableRenderMs);
    await page.waitForTimeout(750);
    let renderedTopology;
    if (product === 'graphify') {
      renderedTopology = await page.evaluate(() => ({
        returned_nodes: eval('RAW_NODES.length'),
        returned_edges: eval('RAW_EDGES.length'),
      }));
      if (renderedTopology.returned_nodes !== expected.returned_nodes
        || renderedTopology.returned_edges !== expected.returned_edges) {
        throw new Error(`Graphify rendered ${JSON.stringify(renderedTopology)} but artifact expected ${JSON.stringify(expected)}`);
      }
    } else {
      const layouts = await Promise.all(layoutResponses);
      const layout = layouts.at(-1);
      if (!layout || !Array.isArray(layout.nodes) || !Array.isArray(layout.edges)) {
        throw new Error('Ariad browser did not render a valid /api/layout response');
      }
      renderedTopology = {
        total_nodes: layout.total_nodes,
        returned_nodes: layout.returned_nodes ?? layout.nodes.length,
        returned_edges: layout.edges.length,
        truncated: layout.truncated ?? (layout.nodes.length < layout.total_nodes),
        strategy: layout.layout?.strategy ?? null,
        layout_url: await page.evaluate(() => performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter((name) => name.includes('/api/layout?'))
          .at(-1) ?? null),
      };
      if (renderedTopology.total_nodes !== expected.total_nodes) {
        throw new Error(`Ariad rendered total ${renderedTopology.total_nodes}, DB has ${expected.total_nodes}`);
      }
      const canvasLabel = await page.locator('canvas').first().getAttribute('aria-label');
      if (!canvasLabel) throw new Error('Ariad rendered canvas lost its topology accessibility label');
      renderedTopology.canvas_aria_label = canvasLabel;
    }
    if (prime) {
      return {
        status: 'prime',
        product,
        target: state.target,
        viewport,
        cache_phase: phase,
        run,
        first_usable_render_ms: Number(firstUsable.toFixed(3)),
        rendered_topology: renderedTopology,
      };
    }
    if (screenshot) {
      if (existsSync(screenshot)) throw new Error(`Refusing to overwrite screenshot: ${screenshot}`);
      await page.screenshot({ path: screenshot, type: 'png', animations: 'disabled' });
    }
    const preTaskAudit = await auditDom(page);
    const task = await runTask(page, product, state.target, viewport, preTaskAudit);
    const interaction = await exerciseCanvas(page, interactionMs);
    const idle = await measureIdle(session, idleMs);
    const lab = await page.evaluate(() => ({
      longTasks: window.__R184_VISUAL_LAB__.longTasks,
      title: document.title,
      finalUrl: location.href,
    }));
    const longDurations = lab.longTasks.map((entry) => entry.duration);
    return {
      schema_version: 1,
      status: 'completed',
      product,
      target: state.target,
      viewport,
      cache_phase: phase,
      run,
      url: lab.finalUrl,
      document_title: lab.title,
      first_usable_render_ms: Number(firstUsable.toFixed(3)),
      rendered_topology: renderedTopology,
      screenshot: screenshot ? relative(dirname(dirname(screenshot)), screenshot).replaceAll('\\', '/') : null,
      screenshot_stage: screenshot ? 'initial-pre-interaction' : null,
      interaction,
      long_tasks: lab.longTasks,
      long_task_p95_ms: Number((
        longDurations.length === 0 ? 0 : percentile(longDurations, 0.95)
      ).toFixed(3)),
      ...idle,
      task_id: task.task_id,
      task: task.task,
      task_time_ms: task.task_time_ms,
      actions: task.actions,
      context_loss_events: task.context_loss_events,
      task_evidence: task.evidence,
      console_errors: httpErrors.length === 0
        ? consoleErrors.filter((message) => !message.startsWith('Failed to load resource:'))
        : consoleErrors,
      page_errors: pageErrors,
      http_errors: httpErrors,
      clipping_failures: preTaskAudit.clippingFailures,
      overlap_failures: preTaskAudit.overlapFailures,
      accessibility_failures: preTaskAudit.accessibilityFailures,
      measured_viewport: preTaskAudit.viewport,
    };
  } finally {
    await session.detach().catch(() => undefined);
    await page.close().catch(() => undefined);
    if (ownsContext) await activeContext.close();
  }
}

function blindedTaskSheet(samples, keys) {
  return {
    schema_version: 1,
    benchmark_id: tasksSpec.benchmark_id,
    instruction: 'Review this A/B task sheet before opening blind-key.json or unblinded-samples.json.',
    limitation: 'Native product branding and product-specific controls remain visible because masking them would alter shipped behavior.',
    rows: samples
      .filter((sample) => sample.run === 1 && sample.cache_phase === 'cold')
      .map((sample) => {
        const assignment = keys.find((key) => (
          key.target === sample.target && key.viewport === sample.viewport.id
        ));
        return {
          target: sample.target,
          viewport: sample.viewport.id,
          label: assignment.assignment[sample.product],
          task_id: sample.task_id,
          status: sample.status,
          task_success: sample.status === 'completed' ? sample.task.success : false,
          signals: sample.status === 'completed' ? sample.task.signals : {},
          task_time_ms: sample.status === 'completed' ? sample.task_time_ms : null,
          actions: sample.status === 'completed' ? sample.actions : [],
          context_loss_events: sample.status === 'completed' ? sample.context_loss_events : null,
          task_evidence: sample.status === 'completed' ? sample.task_evidence : null,
          initial_capture: sample.status === 'completed' ? sample.screenshot : null,
          clipping_failures: sample.status === 'completed' ? sample.clipping_failures : [],
          overlap_failures: sample.status === 'completed' ? sample.overlap_failures : [],
          accessibility_failures: sample.status === 'completed' ? sample.accessibility_failures : [],
          failure: sample.status === 'failed' ? sample.error : null,
        };
      })
      .sort((left, right) => (
        `${left.target}\0${left.viewport}\0${left.label}`
          .localeCompare(`${right.target}\0${right.viewport}\0${right.label}`)
      )),
  };
}

const rawOptions = parseArgs(process.argv.slice(2));
const labRoot = resolve(rawOptions.lab_root ?? resolve(repoRoot, '..', 'r184-competitive-lab'));
const phase = rawOptions.phase ?? 'baseline';
if (!['baseline', 'postfix', 'preflight'].includes(phase)) {
  throw new Error('--phase must be baseline, postfix, or preflight');
}
const runs = integer(
  rawOptions.runs,
  tasksSpec.repetitions.cold_fresh_browser_context,
  1,
  20,
  '--runs',
);
const interactionMs = integer(rawOptions.interaction_ms, 1_500, 500, 10_000, '--interaction-ms');
const idleMs = integer(rawOptions.idle_ms, 1_250, 500, 10_000, '--idle-ms');
const targetOption = rawOptions.target ?? 'all';
const targets = targetOption === 'all' ? ['fixture', 'zod'] : [targetOption];
if (targets.some((target) => !['fixture', 'zod'].includes(target))) {
  throw new Error('--target must be fixture, zod, or all');
}
const stateRepetition = integer(rawOptions.repetition, 4, 1, 4, '--repetition');
if (phase !== 'preflight' && stateRepetition !== 4) {
  throw new Error('--repetition may differ from 4 only for an unscored preflight');
}
const outputDir = resolve(
  rawOptions.output ?? join(labRoot, 'results', phase, 'visual'),
);
assertExternal(outputDir);
if (existsSync(outputDir)) throw new Error(`Refusing to overwrite visual result directory: ${outputDir}`);
mkdirSync(join(outputDir, 'captures'), { recursive: true });
mkdirSync(join(outputDir, 'server-logs'), { recursive: true });

const states = targets.map((target) => runtime(labRoot, phase, target, stateRepetition));
for (const state of states) {
  for (const required of [state.source, state.graphifyGraph, state.graphifyHtml, state.ariadDb]) {
    if (!existsSync(required)) throw new Error(`Missing visual benchmark prerequisite: ${required}`);
  }
}

const browser = await launchBrowser(rawOptions.browser_executable);
const samples = [];
const keys = [];
const serverRecords = [];
function cellPath(sample) {
  return join(
    outputDir,
    'cells',
    `${sample.target}-${sample.viewport.id}-${sample.cache_phase}-r${sample.run}-${sample.product}.json`,
  );
}

async function runCell(arguments_) {
  const identity = {
    schema_version: 1,
    status: 'failed',
    product: arguments_.product,
    target: arguments_.state.target,
    viewport: arguments_.viewport,
    cache_phase: arguments_.phase,
    run: arguments_.run,
  };
  console.log(
    `VISUAL START ${identity.target} ${identity.viewport.id} `
    + `${identity.cache_phase} r${identity.run} ${identity.product}`,
  );
  let sample;
  try {
    sample = await measurePage(arguments_);
  } catch (error) {
    sample = {
      ...identity,
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack ?? null }
        : { name: 'UnknownError', message: String(error), stack: null },
    };
  }
  writeJsonExclusive(cellPath(sample), sample);
  samples.push(sample);
  console.log(
    `VISUAL ${sample.status === 'completed' ? 'DONE' : 'FAIL'} ${identity.target} `
    + `${identity.viewport.id} ${identity.cache_phase} r${identity.run} ${identity.product}`,
  );
}

try {
  for (const state of states) {
    const graphify = await startStaticGraphify(state.graphifyHtml);
    const ariad = await startAriad(state, join(outputDir, 'server-logs'));
    serverRecords.push({
      target: state.target,
      graphify_html_sha256: sha256File(state.graphifyHtml),
      graphify_graph_sha256: sha256File(state.graphifyGraph),
      ariad_db_sha256: sha256File(state.ariadDb),
      ariad_stdout: relative(outputDir, ariad.stdoutPath).replaceAll('\\', '/'),
      ariad_stderr: relative(outputDir, ariad.stderrPath).replaceAll('\\', '/'),
    });
    const urls = { graphify: graphify.url, ariad: ariad.url };
    const expected = {
      graphify: graphifyTopology(state.graphifyGraph, state.graphifyHtml),
      ariad: ariadTopology(state.ariadDb),
    };
    try {
      for (const viewport of tasksSpec.viewports) {
        const assignment = blindAssignment(tasksSpec.blind_seed, state.target, viewport.id);
        keys.push({ target: state.target, viewport: viewport.id, assignment });
        for (let run = 1; run <= runs; run += 1) {
          const order = run % 2 === 1 ? ['graphify', 'ariad'] : ['ariad', 'graphify'];
          for (const product of order) {
            const label = assignment[product];
            const screenshot = run === 1
              ? join(outputDir, 'captures', `${state.target}-${viewport.id}-${label}-initial.png`)
              : null;
            await runCell({
              browser,
              context: null,
              product,
              url: urls[product],
              state,
              phase: 'cold',
              run,
              viewport,
              screenshot,
              interactionMs,
              idleMs,
              expected: expected[product],
            });
          }
        }

        const warmContexts = {};
        for (const product of ['graphify', 'ariad']) {
          warmContexts[product] = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            deviceScaleFactor: 1,
            colorScheme: 'dark',
            locale: 'en-US',
            serviceWorkers: 'block',
          });
          await measurePage({
            browser,
            context: warmContexts[product],
            product,
            url: urls[product],
            state,
            phase: 'warm-prime',
            run: 0,
            viewport,
            screenshot: null,
            interactionMs,
            idleMs,
            expected: expected[product],
            prime: true,
          });
        }
        try {
          for (let run = 1; run <= runs; run += 1) {
            const order = run % 2 === 1 ? ['graphify', 'ariad'] : ['ariad', 'graphify'];
            for (const product of order) {
              await runCell({
                browser,
                context: warmContexts[product],
                product,
                url: urls[product],
                state,
                phase: 'warm',
                run,
                viewport,
                screenshot: null,
                interactionMs,
                idleMs,
                expected: expected[product],
              });
            }
          }
        } finally {
          await Promise.all(Object.values(warmContexts).map((context) => context.close()));
        }
      }
    } finally {
      await Promise.all([graphify.close(), ariad.close()]);
    }
  }
} finally {
  await browser.close();
}

const key = {
  schema_version: 1,
  benchmark_id: tasksSpec.benchmark_id,
  blind_seed: tasksSpec.blind_seed,
  warning: 'Open only after completing blinded-task-sheet.json review.',
  keys,
};
const sheet = blindedTaskSheet(samples, keys);
const result = {
  schema_version: 1,
  benchmark_id: tasksSpec.benchmark_id,
  phase,
  generated_at_utc: new Date().toISOString(),
  protocol: {
    runs,
    cold: 'fresh browser context with cleared browser cache; stable product server',
    warm: 'persistent product and viewport browser context after one unscored prime',
    interaction_ms: interactionMs,
    idle_ms: idleMs,
    initial_capture: 'run 1 cold, after verified first usable render, before any task or canvas interaction',
    browser: await chromium.name?.() ?? 'chromium',
  },
  server_records: serverRecords,
  summaries: summarizeVisualSamples(samples),
};
writeJsonExclusive(join(outputDir, 'blinded-task-sheet.json'), sheet);
writeJsonExclusive(join(outputDir, 'blind-key.json'), key);
writeJsonExclusive(join(outputDir, 'unblinded-samples.json'), samples);
writeJsonExclusive(join(outputDir, 'visual-summary.json'), result);
console.log(join(outputDir, 'visual-summary.json'));
