// graph-ui/src/test-setup.ts
// R44 (Part C): Vitest setup — imports @testing-library/jest-dom matchers
// (toBeInTheDocument, toHaveAttribute, etc.) so tests can use them without
// importing in every file.

import "@testing-library/jest-dom/vitest";

// Mock `window.matchMedia` — some components may use it for responsive logic.
// jsdom doesn't implement it natively.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// Mock `ResizeObserver` — jsdom doesn't implement it. GraphCanvas uses it
// to handle canvas resizing.
if (!global.ResizeObserver) {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
}

// Mock `requestAnimationFrame` — jsdom doesn't implement it. GraphCanvas
// uses rAF to batch redraws.
if (!global.requestAnimationFrame) {
  global.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number;
  global.cancelAnimationFrame = (id: number) => clearTimeout(id);
}

// Mock `HTMLCanvasElement.prototype.getContext` — jsdom doesn't implement
// the Canvas 2D API (requires the `canvas` npm package). GraphCanvas calls
// getContext("2d") in its draw function. We return a stub with no-op methods.
// R45 (F5): needed for the GraphCanvas sim-reuse regression test.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = function () {
    return {
      clearRect: () => {},
      save: () => {},
      restore: () => {},
      scale: () => {},
      translate: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      moveTo: () => {},
      lineTo: () => {},
      quadraticCurveTo: () => {},
      fillText: () => {},
      strokeText: () => {},
      measureText: (text: string) => ({ width: text.length * 6 }),
      canvas: { width: 800, height: 600 },
    } as any;
  } as any;
}

// Mock pointer capture methods — jsdom doesn't implement them.
// R48: ResizeHandle calls setPointerCapture in onPointerDown; without this
// mock, the R46 test throws "setPointerCapture is not a function" in CI.
if (typeof HTMLElement !== "undefined") {
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = function () {} as any;
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = function () {} as any;
  }
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = function () { return false; } as any;
  }
}
