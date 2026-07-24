import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blindAssignment,
  evaluateTask,
  frameSummary,
  summarizeNumbers,
  summarizeVisualSamples,
} from './visual-core.mjs';

test('blind assignment is deterministic, complete, and target-specific', () => {
  const first = blindAssignment('seed', 'fixture', 'desktop');
  assert.deepEqual(first, blindAssignment('seed', 'fixture', 'desktop'));
  assert.deepEqual(new Set(Object.values(first)), new Set(['A', 'B']));
  assert.notEqual(
    JSON.stringify(first),
    JSON.stringify(blindAssignment('seed', 'zod', 'narrow')),
  );
});

test('frame and number summaries preserve native observations', () => {
  assert.deepEqual(summarizeNumbers([10, 20, 30, 40]), {
    count: 4,
    min: 10,
    p50: 20,
    p95: 40,
    max: 40,
    mean: 25,
    coefficient_of_variation_percent: 44.721,
  });
  const frames = frameSummary([0, 16, 32, 64]);
  assert.equal(frames.frame_count, 4);
  assert.equal(frames.p95_frame_ms, 32);
  assert.equal(frames.frames_over_25_ms_percent, 33.333);
});

test('task evaluation fails closed when one registered signal is absent', () => {
  assert.deepEqual(evaluateTask(['located', 'direction'], { located: true, direction: false }), {
    success: false,
    passed_signals: 1,
    required_signals: 2,
    signals: { located: true, direction: false },
  });
});

test('visual summary groups products without erasing failures', () => {
  const base = {
    target: 'fixture',
    viewport: { id: 'desktop' },
    product: 'ariad',
    cache_phase: 'cold',
    first_usable_render_ms: 100,
    interaction: { fps: 60, p95_frame_ms: 17 },
    long_task_p95_ms: 0,
    idle_cpu_percent: 1,
    heap_mib: 20,
    task: { success: true },
    task_time_ms: 50,
    actions: ['search'],
    context_loss_events: 0,
    console_errors: [],
    page_errors: [],
    http_errors: [],
    clipping_failures: [],
    overlap_failures: [],
    accessibility_failures: [],
  };
  const summary = summarizeVisualSamples([
    base,
    {
      ...base,
      first_usable_render_ms: 200,
      task: { success: false },
      console_errors: ['boom'],
    },
  ]);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].first_usable_render_ms.p50, 100);
  assert.equal(summary[0].completed_runs, 2);
  assert.equal(summary[0].failed_runs, 0);
  assert.equal(summary[0].task_success_runs, 1);
  assert.equal(summary[0].console_errors, 1);
});

test('visual summary retains explicit failed cells without inventing metrics', () => {
  const summary = summarizeVisualSamples([{
    status: 'failed',
    target: 'fixture',
    viewport: { id: 'narrow' },
    product: 'graphify',
    cache_phase: 'cold',
  }]);
  assert.equal(summary[0].runs, 1);
  assert.equal(summary[0].completed_runs, 0);
  assert.equal(summary[0].failed_runs, 1);
  assert.equal(summary[0].first_usable_render_ms, null);
});
