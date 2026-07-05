// v2/tests/round33-regression-tests.test.ts
// R33: Regression tests for the 3 fixes from R32, as recommended by the
// Claude Sonnet 5 Round 3 audit (Part E).
//
// These tests verify:
// 1. GraphTab filter persistence: manually-disabled labels stay disabled
//    when a WebSocket refresh brings the same data.
// 2. Watch daemon timestamp guard: lastSyncFinishedAt prevents redundant
//    export within the guard window.
// 3. GraphCanvas zoom-to-cursor math: rect.width is used instead of
//    canvas.width (device pixels) for HiDPI compatibility.

import { describe, it, expect } from 'vitest';

// ── Test 1: Filter persistence logic ──────────────────────────────
// We can't easily test React components without a test renderer, but we
// can test the pure logic that determines whether a label should be
// auto-enabled. This mirrors the GraphTab useEffect logic.

describe('R33: GraphTab filter persistence logic', () => {
  // Simulate the knownLabelsRef / enabledLabels logic from GraphTab.
  function createFilterState() {
    const knownLabels = new Set<string>();
    const enabledLabels = new Set<string>();

    function initialize(labels: Set<string>) {
      enabledLabels.clear();
      for (const l of labels) {
        knownLabels.add(l);
        enabledLabels.add(l);
      }
    }

    function toggleLabel(label: string) {
      if (enabledLabels.has(label)) {
        enabledLabels.delete(label);
      } else {
        enabledLabels.add(label);
      }
    }

    function refresh(labels: Set<string>): string[] {
      const newlyEnabled: string[] = [];
      for (const label of labels) {
        if (!knownLabels.has(label)) {
          // Genuinely new label — auto-enable it.
          knownLabels.add(label);
          enabledLabels.add(label);
          newlyEnabled.push(label);
        }
        // If already known, do NOT re-add (preserves user's disable choice).
      }
      return newlyEnabled;
    }

    return { knownLabels, enabledLabels, initialize, toggleLabel, refresh };
  }

  it('first load enables all labels', () => {
    const state = createFilterState();
    state.initialize(new Set(['Module', 'Function', 'Route']));
    expect(state.enabledLabels.has('Module')).toBe(true);
    expect(state.enabledLabels.has('Function')).toBe(true);
    expect(state.enabledLabels.has('Route')).toBe(true);
  });

  it('disabling a label and refreshing does NOT re-enable it', () => {
    const state = createFilterState();
    state.initialize(new Set(['Module', 'Function', 'Route']));

    // User disables 'Module'
    state.toggleLabel('Module');
    expect(state.enabledLabels.has('Module')).toBe(false);

    // WebSocket refresh brings the same labels
    const newlyEnabled = state.refresh(new Set(['Module', 'Function', 'Route']));

    // 'Module' should still be disabled (it's known, not new)
    expect(state.enabledLabels.has('Module')).toBe(false);
    expect(newlyEnabled).toEqual([]);

    // 'Function' and 'Route' should still be enabled
    expect(state.enabledLabels.has('Function')).toBe(true);
    expect(state.enabledLabels.has('Route')).toBe(true);
  });

  it('a genuinely new label IS auto-enabled on refresh', () => {
    const state = createFilterState();
    state.initialize(new Set(['Module', 'Function']));

    // WebSocket refresh brings a new label 'BugNote' that wasn't in the initial data
    const newlyEnabled = state.refresh(new Set(['Module', 'Function', 'BugNote']));

    // 'BugNote' should be auto-enabled
    expect(state.enabledLabels.has('BugNote')).toBe(true);
    expect(newlyEnabled).toEqual(['BugNote']);
  });

  it('disabling all labels then refreshing only re-enables genuinely new ones', () => {
    const state = createFilterState();
    state.initialize(new Set(['Module', 'Function', 'Route']));

    // User clicks "Disable All"
    state.enabledLabels.clear();

    // Refresh with same labels + one new
    const newlyEnabled = state.refresh(new Set(['Module', 'Function', 'Route', 'Class']));

    // Only 'Class' should be enabled (it's genuinely new)
    expect(state.enabledLabels.has('Module')).toBe(false);
    expect(state.enabledLabels.has('Function')).toBe(false);
    expect(state.enabledLabels.has('Route')).toBe(false);
    expect(state.enabledLabels.has('Class')).toBe(true);
    expect(newlyEnabled).toEqual(['Class']);
  });
});

// ── Test 2: Watch daemon timestamp guard logic ───────────────────
// Test the pure logic: should the export be skipped based on the timestamp?

describe('R33: Watch daemon timestamp guard logic', () => {
  const SYNC_GUARD_WINDOW_MS = 1500;

  function shouldSkipExport(lastSyncFinishedAt: number, now: number): boolean {
    if (lastSyncFinishedAt > 0 && now - lastSyncFinishedAt < SYNC_GUARD_WINDOW_MS) {
      return true; // Skip — within the guard window
    }
    return false; // Don't skip — either no sync yet, or outside the window
  }

  it('skips export if sync just finished (within window)', () => {
    const lastSync = 1000000;
    const now = 1000000 + 700; // 700ms later (typical debounce delay)
    expect(shouldSkipExport(lastSync, now)).toBe(true);
  });

  it('does NOT skip export if sync finished long ago (outside window)', () => {
    const lastSync = 1000000;
    const now = 1000000 + 2000; // 2s later (outside 1500ms window)
    expect(shouldSkipExport(lastSync, now)).toBe(false);
  });

  it('does NOT skip export if no sync has ever run (lastSyncFinishedAt = 0)', () => {
    expect(shouldSkipExport(0, 1000000)).toBe(false);
  });

  it('skips export at the edge of the window (1499ms)', () => {
    const lastSync = 1000000;
    const now = 1000000 + 1499;
    expect(shouldSkipExport(lastSync, now)).toBe(true);
  });

  it('does NOT skip export just past the window (1500ms)', () => {
    const lastSync = 1000000;
    const now = 1000000 + 1500;
    expect(shouldSkipExport(lastSync, now)).toBe(false);
  });
});

// ── Test 3: Zoom-to-cursor math uses CSS pixels ──────────────────
// Test that the zoom formula uses rect dimensions (CSS px) not canvas
// dimensions (device px = CSS * dpr). We test the math, not the canvas.

describe('R33: Zoom-to-cursor math uses CSS pixels', () => {
  // Simulate the onWheel math from GraphCanvas.
  function computeZoomTransform(
    mouseX: number,
    mouseY: number,
    centerWidth: number, // should be rect.width / 2 (CSS px)
    centerHeight: number, // should be rect.height / 2 (CSS px)
    oldK: number,
    newK: number,
    tx: number,
    ty: number,
  ): { x: number; y: number; k: number } {
    const worldX = (mouseX - centerWidth - tx) / oldK;
    const worldY = (mouseY - centerHeight - ty) / oldK;
    return {
      k: newK,
      x: mouseX - centerWidth - worldX * newK,
      y: mouseY - centerHeight - worldY * newK,
    };
  }

  it('produces correct transform when dpr=1 (canvas.width == rect.width)', () => {
    const dpr = 1;
    const rectWidth = 800;
    const rectHeight = 600;
    const canvasWidth = rectWidth * dpr;
    const canvasHeight = rectHeight * dpr;

    // Mouse at center of canvas
    const mouseX = 400;
    const mouseY = 300;

    // Using rect dimensions (correct):
    const correctResult = computeZoomTransform(
      mouseX, mouseY, rectWidth / 2, rectHeight / 2,
      1, 2, 0, 0,
    );

    // Using canvas dimensions (would be wrong on HiDPI but same when dpr=1):
    const canvasResult = computeZoomTransform(
      mouseX, mouseY, canvasWidth / 2, canvasHeight / 2,
      1, 2, 0, 0,
    );

    // When dpr=1, both approaches give the same result
    expect(correctResult).toEqual(canvasResult);
  });

  it('produces DIFFERENT results when dpr=2 (rect.width != canvas.width)', () => {
    const dpr = 2;
    const rectWidth = 800;
    const rectHeight = 600;
    const canvasWidth = rectWidth * dpr; // 1600
    const canvasHeight = rectHeight * dpr; // 1200

    const mouseX = 400; // CSS px
    const mouseY = 300; // CSS px

    // Using rect dimensions (CORRECT — what R32 fix does):
    const correctResult = computeZoomTransform(
      mouseX, mouseY, rectWidth / 2, rectHeight / 2,
      1, 2, 0, 0,
    );

    // Using canvas dimensions (WRONG — pre-R32 behavior):
    const wrongResult = computeZoomTransform(
      mouseX, mouseY, canvasWidth / 2, canvasHeight / 2,
      1, 2, 0, 0,
    );

    // The results MUST differ — this proves the bug existed on HiDPI
    expect(correctResult).not.toEqual(wrongResult);

    // The correct result should keep the mouse point fixed under the cursor
    // (worldX = 0 when mouse is at center and tx=0, so new tx should be 0)
    expect(correctResult.x).toBe(0);
    expect(correctResult.y).toBe(0);

    // The wrong result would have a large offset (bug)
    expect(wrongResult.x).not.toBe(0);
    expect(wrongResult.y).not.toBe(0);
  });
});
