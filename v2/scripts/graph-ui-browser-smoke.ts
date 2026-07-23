import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  assertGraphBrowserSmoke,
  isHelpRequest,
  type GraphBrowserSmokeObservation,
} from './graph-ui-lab-core.js';
import { graphKeyboardTraversalAction } from './graph-ui-browser-smoke-core.js';

interface Options {
  baseUrl: string;
  project: string;
  timeoutMs: number;
  browserExecutable?: string;
}

const USAGE = 'Usage: npm run smoke:graph-ui:browser -- --project <name> '
  + '[--base-url http://127.0.0.1:9749] [--timeout-ms 30000] '
  + '[--browser-executable <path>]';

function option(argv: readonly string[], name: string, fallback?: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

function parseOptions(argv: readonly string[]): Options {
  const project = option(argv, 'project');
  if (!project) throw new Error(USAGE);
  const baseUrl = new URL(option(argv, 'base-url', 'http://127.0.0.1:9749')!);
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error(`Unsupported Graph UI URL: ${baseUrl.toString()}`);
  }
  const timeoutMs = Number(option(argv, 'timeout-ms', '30000'));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 120000) {
    throw new Error('--timeout-ms must be an integer between 5000 and 120000');
  }
  return {
    baseUrl: baseUrl.toString().replace(/\/$/u, ''),
    project,
    timeoutMs,
    browserExecutable: option(argv, 'browser-executable'),
  };
}

async function launchBrowser(options: Options): Promise<Browser> {
  const launchOptions = {
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
    return chromium.launch({ ...launchOptions, executablePath: resolve(options.browserExecutable) });
  }
  try {
    return await chromium.launch(launchOptions);
  } catch (error) {
    if (process.platform === 'win32') {
      return chromium.launch({ ...launchOptions, channel: 'msedge' });
    }
    throw new Error(
      'Pinned Chromium is not installed; run `npx playwright-core install --with-deps chromium`.',
      { cause: error },
    );
  }
}

async function waitForCanvas(page: Page, timeoutMs: number) {
  const canvas = page.locator('canvas[role="application"]');
  await canvas.waitFor({ state: 'visible', timeout: timeoutMs });
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLCanvasElement>('canvas[role="application"]');
    const match = element?.getAttribute('aria-label')?.match(/: ([0-9,]+) nodes/u);
    return element != null
      && element.width >= 320
      && element.height >= 200
      && match != null
      && Number(match[1]!.replaceAll(',', '')) > 0;
  }, undefined, { timeout: timeoutMs });
  return canvas;
}

async function graphState(
  canvas: ReturnType<Page['locator']>,
  viewButton: ReturnType<Page['locator']>,
): Promise<{ visualMode: string | null; viewPressed: boolean; flowLens: string | null }> {
  const [visualMode, viewPressed, flowLens] = await Promise.all([
    canvas.getAttribute('data-visual-mode'),
    viewButton.getAttribute('aria-pressed'),
    canvas.getAttribute('data-flow-lens'),
  ]);
  return { visualMode, viewPressed: viewPressed === 'true', flowLens };
}

async function exerciseGraph(page: Page, options: Options): Promise<GraphBrowserSmokeObservation> {
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

  await page.goto(
    `${options.baseUrl}/?tab=graph&project=${encodeURIComponent(options.project)}`,
    { waitUntil: 'domcontentloaded', timeout: options.timeoutMs },
  );
  const graphTab = page.locator('#tab-graph');
  await graphTab.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const canvas = await waitForCanvas(page, options.timeoutMs);
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error('Graph canvas has no CSS bounding box');
  const canvasPixels = await canvas.evaluate((element) => ({
    width: (element as HTMLCanvasElement).width,
    height: (element as HTMLCanvasElement).height,
  }));

  const viewGroup = page.getByRole('group', { name: 'Graph view' });
  const structureButton = viewGroup.getByRole('button', { name: 'Structure', exact: true });
  const dependenciesButton = viewGroup.getByRole('button', { name: 'Dependencies', exact: true });
  const initial = await graphState(canvas, structureButton);

  await dependenciesButton.click();
  await page.waitForFunction(() => (
    document.querySelector('canvas[role="application"]')?.getAttribute('data-visual-mode') === 'stellar'
  ), undefined, { timeout: options.timeoutMs });
  await canvas.focus();
  const keyboardStatus = page.locator('span[role="status"][aria-live="polite"][aria-atomic="true"]');
  const zoomInButton = page.getByRole('button', { name: 'Zoom in', exact: true });
  let keyboardAnnouncement = '';
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.keyboard.press('n');
    await page.waitForTimeout(75);
    keyboardAnnouncement = (await keyboardStatus.textContent())?.trim() ?? '';
    const action = graphKeyboardTraversalAction(keyboardAnnouncement);
    if (action === 'complete') break;
    if (action === 'zoom') {
      await zoomInButton.click();
      await page.waitForTimeout(120);
      await canvas.focus();
    }
  }
  if (!/^Node\b/u.test(keyboardAnnouncement)) {
    throw new Error(
      `Graph keyboard traversal did not announce a node: ${keyboardAnnouncement || 'empty'}`,
    );
  }
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (
    document.querySelector('canvas[role="application"]')?.getAttribute('data-flow-lens') === 'semantic-depth-v2'
  ), undefined, { timeout: options.timeoutMs });
  const dependencies = await graphState(canvas, dependenciesButton);

  await structureButton.click();
  await page.waitForFunction(() => {
    const element = document.querySelector('canvas[role="application"]');
    return element?.getAttribute('data-visual-mode') === 'architecture'
      && element.getAttribute('data-flow-lens') === 'off';
  }, undefined, { timeout: options.timeoutMs });
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  const restored = await graphState(canvas, structureButton);

  return {
    graphTabSelected: await graphTab.getAttribute('aria-selected') === 'true',
    projectVisible: await page.locator('header').getByText(options.project, { exact: true }).isVisible(),
    canvas: {
      cssWidth: Math.round(canvasBox.width),
      cssHeight: Math.round(canvasBox.height),
      pixelWidth: canvasPixels.width,
      pixelHeight: canvasPixels.height,
    },
    initial,
    dependencies,
    keyboardAnnouncement,
    restored,
    consoleErrors: failedResponses.length === 0
      ? consoleErrors.filter((message) => !message.startsWith('Failed to load resource:'))
      : consoleErrors,
    pageErrors,
    failedResponses,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isHelpRequest(argv)) {
    console.log(USAGE);
    return;
  }
  const options = parseOptions(argv);
  const browser = await launchBrowser(options);
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      locale: 'en-US',
      serviceWorkers: 'block',
    });
    try {
      const page = await context.newPage();
      const observation = await exerciseGraph(page, options);
      assertGraphBrowserSmoke(observation);
      console.log(JSON.stringify({
        result: 'PASS',
        project: options.project,
        baseUrl: options.baseUrl,
        browser: browser.version(),
        observation,
      }, null, 2));
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
