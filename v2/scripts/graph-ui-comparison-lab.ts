import { mkdir, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { basename, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import {
  GRAPH_UI_LAB_VERSION,
  PERCEPTION_TASKS,
  analyzeFrames,
  assertSameCompleteTopology,
  blindLabels,
  isHelpRequest,
  summarizeTimings,
  topologyFingerprint,
  type FrameSummary,
  type LayoutLike,
  type TimingSummary,
  type TopologyFingerprint,
} from './graph-ui-lab-core.js';

type Variant = 'v1' | 'v2';
type Phase = 'cold' | 'warm';

interface Options {
  v1Url: string;
  v2Url: string;
  project: string;
  runs: number;
  maxNodes: number;
  v2Mode: 'architecture' | 'stellar';
  interactionMs: number;
  cooldownTimeoutMs: number;
  idleMs: number;
  timeoutMs: number;
  outputDir: string;
  browserExecutable?: string;
  allowSampled: boolean;
}

interface LongTaskRecord {
  start: number;
  duration: number;
}

interface BrowserSample {
  phase: Phase;
  variant: Variant;
  run: number;
  firstUsefulGraphMs: number;
  layoutResponseEndMs: number;
  layoutTransferBytes: number;
  cooldownMs: number;
  cooldownReached: boolean;
  maxLongTaskMs: number;
  totalLongTaskMs: number;
  longTaskCount: number;
  longTasks: LongTaskRecord[];
  interaction: FrameSummary;
  idleCpuPct: number;
  jsHeapBeforeGcMb: number;
  jsHeapUsedMb: number;
  consoleErrors: string[];
  pageErrors: string[];
  failedResponses: Array<{ status: number; url: string }>;
  screenshot?: string;
}

interface VariantSummary {
  firstUsefulGraphMs: TimingSummary;
  layoutResponseEndMs: TimingSummary;
  layoutTransferBytes: TimingSummary;
  cooldownMs: TimingSummary;
  maxLongTaskMs: TimingSummary;
  interactionFps: TimingSummary;
  interactionP95FrameMs: TimingSummary;
  idleCpuPct: TimingSummary;
  jsHeapUsedMb: TimingSummary;
}

const V1_REFERENCE_COMMIT = '345425a1bbf73fa29f76067a91f6d16dcf6f11a8';
const USAGE = 'Usage: npm run bench:graph-ui:compare -- --project <name> '
  + '[--v1-url http://127.0.0.1:9752] [--v2-url http://127.0.0.1:9753] '
  + '[--runs 5] [--max-nodes 1000] [--v2-mode architecture|stellar]';

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function integerOption(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported URL: ${value}`);
  return url.toString().replace(/\/$/u, '');
}

function parseOptions(): Options {
  const project = option('project');
  if (!project) {
    throw new Error(USAGE);
  }
  const v2Mode = option('v2-mode', 'architecture');
  if (v2Mode !== 'architecture' && v2Mode !== 'stellar') {
    throw new Error('--v2-mode must be architecture or stellar');
  }
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  return {
    v1Url: normalizeBaseUrl(option('v1-url', 'http://127.0.0.1:9752')!),
    v2Url: normalizeBaseUrl(option('v2-url', 'http://127.0.0.1:9753')!),
    project,
    runs: integerOption('runs', 5, 1, 20),
    maxNodes: integerOption('max-nodes', 1000, 1, 10000),
    v2Mode,
    interactionMs: integerOption('interaction-ms', 1600, 500, 10000),
    cooldownTimeoutMs: integerOption('cooldown-timeout-ms', 8000, 1000, 30000),
    idleMs: integerOption('idle-ms', 1500, 500, 10000),
    timeoutMs: integerOption('timeout-ms', 30000, 5000, 120000),
    outputDir: resolve(option(
      'output',
      resolve(process.cwd(), '..', '.codex-runtime', 'graph-ui-lab', 'results', stamp),
    )!),
    browserExecutable: option('browser-executable'),
    allowSampled: hasFlag('allow-sampled'),
  };
}

async function fetchLayout(baseUrl: string, project: string, maxNodes: number): Promise<LayoutLike> {
  const path = `/api/layout?project=${encodeURIComponent(project)}&max_nodes=${maxNodes}`;
  const response = await fetch(`${baseUrl}${path}`, { headers: { 'Accept-Encoding': 'identity' } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${baseUrl}${path} returned ${response.status}: ${text.slice(0, 500)}`);
  const value = JSON.parse(text) as Partial<LayoutLike>;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Number.isSafeInteger(value.total_nodes)) {
    throw new Error(`${baseUrl}${path} returned an invalid layout contract`);
  }
  return value as LayoutLike;
}

function metric(metrics: Array<{ name: string; value: number }>, name: string): number {
  return metrics.find((entry) => entry.name === name)?.value ?? 0;
}

async function performanceMetrics(session: CDPSession): Promise<Record<string, number>> {
  const result = await session.send('Performance.getMetrics') as {
    metrics: Array<{ name: string; value: number }>;
  };
  return {
    taskDuration: metric(result.metrics, 'TaskDuration'),
    jsHeapUsedSize: metric(result.metrics, 'JSHeapUsedSize'),
  };
}

async function waitForCooldown(
  session: CDPSession,
  firstUsefulGraphMs: number,
  timeoutMs: number,
): Promise<{ cooldownMs: number; reached: boolean }> {
  let previous = await performanceMetrics(session);
  let previousAt = Date.now();
  let quietWindows = 0;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    const current = await performanceMetrics(session);
    const currentAt = Date.now();
    const wallSeconds = (currentAt - previousAt) / 1000;
    const cpuRatio = wallSeconds === 0 ? 1 : (current.taskDuration - previous.taskDuration) / wallSeconds;
    quietWindows = cpuRatio <= 0.04 ? quietWindows + 1 : 0;
    if (quietWindows >= 3) {
      return { cooldownMs: Math.max(0, currentAt - startedAt + firstUsefulGraphMs), reached: true };
    }
    previous = current;
    previousAt = currentAt;
  }
  return { cooldownMs: firstUsefulGraphMs + timeoutMs, reached: false };
}

async function measureIdle(session: CDPSession, durationMs: number): Promise<{
  cpuPct: number;
  heapBeforeGcMb: number;
  heapMb: number;
}> {
  const before = await performanceMetrics(session);
  const startedAt = Date.now();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));
  const after = await performanceMetrics(session);
  const wallSeconds = (Date.now() - startedAt) / 1000;
  await session.send('HeapProfiler.collectGarbage');
  const retained = await performanceMetrics(session);
  return {
    cpuPct: Number((((after.taskDuration - before.taskDuration) / wallSeconds) * 100).toFixed(3)),
    heapBeforeGcMb: Number((after.jsHeapUsedSize / 1024 / 1024).toFixed(3)),
    heapMb: Number((retained.jsHeapUsedSize / 1024 / 1024).toFixed(3)),
  };
}

async function installInstrumentation(page: Page): Promise<void> {
  await page.addInitScript({
    content: `(() => {
      const state = {
        firstUsefulGraphMs: null,
        layoutResponseEndMs: null,
        layoutTransferBytes: 0,
        longTasks: [],
        activeFrames: null,
        beginFrames: () => {
          if (state.activeFrames) return;
          state.activeFrames = [];
          const collect = (timestamp) => {
            if (!state.activeFrames) return;
            state.activeFrames.push(timestamp);
            requestAnimationFrame(collect);
          };
          requestAnimationFrame(collect);
        },
        endFrames: () => {
          const frames = state.activeFrames || [];
          state.activeFrames = null;
          return frames;
        },
      };
      window.__CBM_GRAPH_LAB__ = state;
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            state.longTasks.push({ start: entry.startTime, duration: entry.duration });
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch {}
      let consecutiveReadyFrames = 0;
      const detectUsefulGraph = (timestamp) => {
        const layouts = performance.getEntriesByType('resource')
          .filter((entry) => entry.name.includes('/api/layout?'));
        const layout = layouts[layouts.length - 1];
        const canvas = document.querySelector('canvas');
        const canvasReady = canvas && canvas.width > 0 && canvas.height > 0;
        if (layout && canvasReady) {
          consecutiveReadyFrames += 1;
          if (consecutiveReadyFrames >= 2) {
            state.firstUsefulGraphMs = timestamp;
            state.layoutResponseEndMs = layout.responseEnd;
            state.layoutTransferBytes = layout.transferSize;
            return;
          }
        } else {
          consecutiveReadyFrames = 0;
        }
        requestAnimationFrame(detectUsefulGraph);
      };
      requestAnimationFrame(detectUsefulGraph);
    })();`,
  });
}

async function selectV1Project(page: Page, project: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (projectName) => document.body.textContent?.includes(projectName) === true,
    project,
    { timeout: timeoutMs },
  );
  const clicked = await page.evaluate((projectName) => {
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find((candidate) => {
      if (!/view graph|查看图谱/iu.test(candidate.textContent ?? '')) return false;
      let ancestor: Element | null = candidate;
      for (let depth = 0; ancestor && depth < 6; depth += 1, ancestor = ancestor.parentElement) {
        if (ancestor.textContent?.includes(projectName)) return true;
      }
      return false;
    });
    button?.click();
    return button != null;
  }, project);
  if (!clicked) throw new Error(`V1 project card did not expose a View Graph action for ${project}`);
}

async function waitForUsefulGraph(page: Page, timeoutMs: number): Promise<{
  firstUsefulGraphMs: number;
  layoutResponseEndMs: number;
  layoutTransferBytes: number;
}> {
  await page.waitForFunction(
    () => (window as Window & { __CBM_GRAPH_LAB__?: { firstUsefulGraphMs: number | null } })
      .__CBM_GRAPH_LAB__?.firstUsefulGraphMs != null,
    undefined,
    { timeout: timeoutMs },
  );
  return page.evaluate(() => {
    const state = (window as unknown as Window & {
      __CBM_GRAPH_LAB__: {
        firstUsefulGraphMs: number;
        layoutResponseEndMs: number;
        layoutTransferBytes: number;
      };
    }).__CBM_GRAPH_LAB__;
    return {
      firstUsefulGraphMs: state.firstUsefulGraphMs,
      layoutResponseEndMs: state.layoutResponseEndMs,
      layoutTransferBytes: state.layoutTransferBytes,
    };
  });
}

async function exerciseCanvas(page: Page, durationMs: number): Promise<FrameSummary> {
  const canvas = page.locator('canvas').first();
  await canvas.waitFor({ state: 'visible' });
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Graph canvas has no interactive bounding box');
  await page.evaluate(() => {
    (window as unknown as Window & { __CBM_GRAPH_LAB__: { beginFrames: () => void } })
      .__CBM_GRAPH_LAB__.beginFrames();
  });

  const centerX = box.x + (box.width / 2);
  const centerY = box.y + (box.height / 2);
  await page.mouse.move(centerX, centerY);
  await page.mouse.wheel(0, -420);
  await page.mouse.down();
  await page.mouse.move(centerX + Math.min(180, box.width / 4), centerY + Math.min(90, box.height / 5), {
    steps: 12,
  });
  await page.mouse.up();
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(durationMs);

  const frames = await page.evaluate(() => (
    window as unknown as Window & { __CBM_GRAPH_LAB__: { endFrames: () => number[] } }
  ).__CBM_GRAPH_LAB__.endFrames());
  return analyzeFrames(frames);
}

async function createContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    locale: 'en-US',
    serviceWorkers: 'block',
  });
}

async function measurePage(
  context: BrowserContext,
  options: Options,
  variant: Variant,
  phase: Phase,
  run: number,
  screenshotPath?: string,
): Promise<BrowserSample> {
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedResponses: Array<{ status: number; url: string }> = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400 && !new URL(response.url()).pathname.endsWith('/favicon.ico')) {
      failedResponses.push({ status: response.status(), url: response.url() });
    }
  });
  await session.send('Performance.enable');
  if (phase === 'cold') {
    await session.send('Network.enable');
    await session.send('Network.clearBrowserCache');
  }
  await installInstrumentation(page);
  if (variant === 'v2') {
    await page.addInitScript({
      content: `localStorage.setItem('cbm-graph-visual-mode', ${JSON.stringify(options.v2Mode)});`,
    });
  }

  const baseUrl = variant === 'v1' ? options.v1Url : options.v2Url;
  const targetUrl = variant === 'v1'
    ? `${baseUrl}/`
    : `${baseUrl}/?tab=graph&project=${encodeURIComponent(options.project)}`;
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    if (variant === 'v1') await selectV1Project(page, options.project, options.timeoutMs);
    const useful = await waitForUsefulGraph(page, options.timeoutMs);
    const cooldown = await waitForCooldown(session, useful.firstUsefulGraphMs, options.cooldownTimeoutMs);
    const interaction = await exerciseCanvas(page, options.interactionMs);
    const idle = await measureIdle(session, options.idleMs);
    const state = await page.evaluate(() => {
      const lab = (window as unknown as Window & {
        __CBM_GRAPH_LAB__: { longTasks: LongTaskRecord[] };
      }).__CBM_GRAPH_LAB__;
      return { longTasks: lab.longTasks };
    });
    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, type: 'png', animations: 'disabled' });
    }
    const maxLongTaskMs = state.longTasks.length === 0
      ? 0
      : Math.max(...state.longTasks.map((task) => task.duration));
    return {
      phase,
      variant,
      run,
      ...useful,
      cooldownMs: cooldown.cooldownMs,
      cooldownReached: cooldown.reached,
      maxLongTaskMs: Number(maxLongTaskMs.toFixed(3)),
      totalLongTaskMs: Number(state.longTasks.reduce((sum, task) => sum + task.duration, 0).toFixed(3)),
      longTaskCount: state.longTasks.length,
      longTasks: state.longTasks,
      interaction,
      idleCpuPct: idle.cpuPct,
      jsHeapBeforeGcMb: idle.heapBeforeGcMb,
      jsHeapUsedMb: idle.heapMb,
      consoleErrors: failedResponses.length === 0
        ? consoleErrors.filter((message) => !message.startsWith('Failed to load resource:'))
        : consoleErrors,
      pageErrors,
      failedResponses,
      screenshot: screenshotPath ? basename(screenshotPath) : undefined,
    };
  } catch (error) {
    const debug = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const lab = (window as unknown as Window & {
        __CBM_GRAPH_LAB__?: {
          firstUsefulGraphMs: number | null;
          layoutResponseEndMs: number | null;
          longTasks: LongTaskRecord[];
        };
      }).__CBM_GRAPH_LAB__;
      return {
        title: document.title,
        url: location.href,
        body: document.body.innerText.slice(0, 2000),
        canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
        layouts: performance.getEntriesByType('resource')
          .filter((entry) => entry.name.includes('/api/layout?'))
          .map((entry) => ({ name: entry.name, duration: entry.duration })),
        lab: lab ? {
          firstUsefulGraphMs: lab.firstUsefulGraphMs,
          layoutResponseEndMs: lab.layoutResponseEndMs,
          longTaskCount: lab.longTasks.length,
        } : null,
      };
    }).catch((debugError: unknown) => ({ debugError: String(debugError) }));
    throw new Error(
      `${variant.toUpperCase()} ${phase} run ${run} failed: `
      + `${error instanceof Error ? error.message : String(error)}\n`
      + `${JSON.stringify({ debug, consoleErrors, pageErrors, failedResponses }, null, 2)}`,
      { cause: error },
    );
  } finally {
    await session.detach().catch(() => undefined);
    await page.close().catch(() => undefined);
  }
}

function summarize(samples: readonly BrowserSample[]): VariantSummary {
  const values = (select: (sample: BrowserSample) => number): number[] => samples.map(select);
  return {
    firstUsefulGraphMs: summarizeTimings(values((sample) => sample.firstUsefulGraphMs)),
    layoutResponseEndMs: summarizeTimings(values((sample) => sample.layoutResponseEndMs)),
    layoutTransferBytes: summarizeTimings(values((sample) => sample.layoutTransferBytes)),
    cooldownMs: summarizeTimings(values((sample) => sample.cooldownMs)),
    maxLongTaskMs: summarizeTimings(values((sample) => sample.maxLongTaskMs)),
    interactionFps: summarizeTimings(values((sample) => sample.interaction.fps)),
    interactionP95FrameMs: summarizeTimings(values((sample) => sample.interaction.p95FrameMs)),
    idleCpuPct: summarizeTimings(values((sample) => sample.idleCpuPct)),
    jsHeapUsedMb: summarizeTimings(values((sample) => sample.jsHeapUsedMb)),
  };
}

function markdownSummary(
  options: Options,
  topology: Record<Variant, TopologyFingerprint>,
  summaries: Record<Phase, Record<Variant, VariantSummary>>,
): string {
  const rows: string[] = [];
  for (const phase of ['cold', 'warm'] as const) {
    for (const variant of ['v1', 'v2'] as const) {
      const value = summaries[phase][variant];
      rows.push(
        `| ${phase} | ${variant.toUpperCase()} | ${value.firstUsefulGraphMs.p50.toFixed(1)} / `
        + `${value.firstUsefulGraphMs.p95.toFixed(1)} | ${value.maxLongTaskMs.p95.toFixed(1)} | `
        + `${value.interactionFps.p50.toFixed(1)} | ${value.interactionP95FrameMs.p95.toFixed(1)} | `
        + `${value.idleCpuPct.p50.toFixed(2)} | ${value.jsHeapUsedMb.p50.toFixed(1)} |`,
      );
    }
  }
  return `# Graph UI Performance & Perception Lab\n\n`
    + `- Project: \`${options.project}\`\n`
    + `- V1 reference: \`${V1_REFERENCE_COMMIT}\`\n`
    + `- V2 mode: \`${options.v2Mode}\`\n`
    + `- Runs per phase and variant: ${options.runs}\n`
    + `- Strict topology: ${topology.v1.topologyDigest === topology.v2.topologyDigest ? 'PASS' : 'FAIL'}\n`
    + `- Nodes/edges: ${topology.v1.returnedNodes}/${topology.v1.returnedEdges}\n\n`
    + `| Phase | Variant | First useful p50/p95 ms | Long task p95 ms | Interaction FPS p50 | Frame p95 ms | Idle CPU p50 % | Heap p50 MiB |\n`
    + `|---|---|---:|---:|---:|---:|---:|---:|\n`
    + `${rows.join('\n')}\n\n`
    + `These measurements are evidence, not an automatic aesthetic winner. Use the anonymous captures `
    + `with the task sheet before changing adaptive rendering budgets.\n`;
}

async function launchBrowser(options: Options): Promise<Browser> {
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
  if (options.browserExecutable) {
    return chromium.launch({ ...common, executablePath: resolve(options.browserExecutable) });
  }
  if (process.platform === 'win32') return chromium.launch({ ...common, channel: 'msedge' });
  throw new Error('Pass --browser-executable <path> when no bundled Chromium is installed');
}

async function main(): Promise<void> {
  if (isHelpRequest(process.argv.slice(2))) {
    console.log(USAGE);
    return;
  }
  const options = parseOptions();
  await mkdir(options.outputDir, { recursive: true });
  const captureDir = resolve(options.outputDir, 'blind-captures');
  await mkdir(captureDir, { recursive: true });

  const [v1Layout, v2Layout] = await Promise.all([
    fetchLayout(options.v1Url, options.project, options.maxNodes),
    fetchLayout(options.v2Url, options.project, options.maxNodes),
  ]);
  const topology = {
    v1: topologyFingerprint(v1Layout),
    v2: topologyFingerprint(v2Layout),
  };
  let strictTopology = true;
  try {
    assertSameCompleteTopology('v1', topology.v1, 'v2', topology.v2);
  } catch (error) {
    strictTopology = false;
    if (!options.allowSampled) throw error;
  }

  const seed = `${options.project}\0${topology.v1.topologyDigest}\0${new Date().toISOString().slice(0, 10)}`;
  const labels = blindLabels(seed);
  const browser = await launchBrowser(options);
  const samples: Record<Phase, Record<Variant, BrowserSample[]>> = {
    cold: { v1: [], v2: [] },
    warm: { v1: [], v2: [] },
  };
  try {
    for (let run = 1; run <= options.runs; run += 1) {
      const order: Variant[] = run % 2 === 1 ? ['v1', 'v2'] : ['v2', 'v1'];
      for (const variant of order) {
        const context = await createContext(browser);
        try {
          const screenshotPath = run === 1
            ? resolve(captureDir, `${labels[variant]}-cold.png`)
            : undefined;
          samples.cold[variant].push(await measurePage(
            context,
            options,
            variant,
            'cold',
            run,
            screenshotPath,
          ));
        } finally {
          await context.close();
        }
      }
    }

    const warmContexts: Record<Variant, BrowserContext> = {
      v1: await createContext(browser),
      v2: await createContext(browser),
    };
    try {
      for (const variant of ['v1', 'v2'] as const) {
        await measurePage(warmContexts[variant], options, variant, 'warm', 0);
      }
      for (let run = 1; run <= options.runs; run += 1) {
        const order: Variant[] = run % 2 === 1 ? ['v1', 'v2'] : ['v2', 'v1'];
        for (const variant of order) {
          const screenshotPath = run === 1
            ? resolve(captureDir, `${labels[variant]}-warm.png`)
            : undefined;
          samples.warm[variant].push(await measurePage(
            warmContexts[variant],
            options,
            variant,
            'warm',
            run,
            screenshotPath,
          ));
        }
      }
    } finally {
      await Promise.all(Object.values(warmContexts).map((context) => context.close()));
    }
  } finally {
    await browser.close();
  }

  const summaries: Record<Phase, Record<Variant, VariantSummary>> = {
    cold: { v1: summarize(samples.cold.v1), v2: summarize(samples.cold.v2) },
    warm: { v1: summarize(samples.warm.v1), v2: summarize(samples.warm.v2) },
  };
  const allSamples = [
    ...samples.cold.v1,
    ...samples.cold.v2,
    ...samples.warm.v1,
    ...samples.warm.v2,
  ];
  const runtimeErrors = allSamples.some((sample) => (
    sample.consoleErrors.length > 0
    || sample.pageErrors.length > 0
    || sample.failedResponses.length > 0
  ));
  const unstable = (['cold', 'warm'] as const).some((phase) => (
    (['v1', 'v2'] as const).some((variant) => (
      summaries[phase][variant].firstUsefulGraphMs.coefficientOfVariationPct > 25
      || summaries[phase][variant].interactionFps.coefficientOfVariationPct > 10
    ))
  ));
  const evidenceGrade = !strictTopology
    ? 'exploratory-sampled'
    : options.runs < 5
      ? 'exploratory'
      : runtimeErrors
        ? 'invalid-runtime-errors'
        : unstable
          ? 'unstable'
          : 'comparison-candidate';
  const report = {
    labVersion: GRAPH_UI_LAB_VERSION,
    generatedAt: new Date().toISOString(),
    evidenceGrade,
    automaticWinner: null,
    reference: { v1Commit: V1_REFERENCE_COMMIT, v2Mode: options.v2Mode },
    environment: {
      platform: platform(),
      release: release(),
      arch: arch(),
      node: process.version,
      browser: browser.version(),
      viewport: { width: 1440, height: 960, deviceScaleFactor: 1 },
    },
    config: options,
    topology: { strict: strictTopology, ...topology },
    samples,
    summaries,
    perception: {
      tasks: PERCEPTION_TASKS,
      captureDirectory: 'blind-captures',
      answerSheet: Object.fromEntries(PERCEPTION_TASKS.map((task) => [task.id, {
        A: { timeMs: null, actions: null, errors: null, confidence: null, notes: '' },
        B: { timeMs: null, actions: null, errors: null, confidence: null, notes: '' },
      }])),
    },
  };

  await Promise.all([
    writeFile(resolve(options.outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(resolve(options.outputDir, 'summary.md'), markdownSummary(options, topology, summaries), 'utf8'),
    writeFile(resolve(options.outputDir, 'blind-key.json'), `${JSON.stringify({ seed, labels }, null, 2)}\n`, 'utf8'),
  ]);
  console.log(JSON.stringify({
    report: resolve(options.outputDir, 'report.json'),
    summary: resolve(options.outputDir, 'summary.md'),
    blindCaptures: captureDir,
    strictTopology,
    evidenceGrade: report.evidenceGrade,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
