import { createHash } from 'node:crypto';

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function blindAssignment(seed, target, viewport) {
  const digest = sha256Text(`${seed}\0${target}\0${viewport}`);
  return Number.parseInt(digest.slice(0, 2), 16) % 2 === 0
    ? { graphify: 'A', ariad: 'B' }
    : { graphify: 'B', ariad: 'A' };
}

export function percentile(values, ratio) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('percentile requires at least one sample');
  }
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error(`invalid percentile ratio: ${ratio}`);
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

export function summarizeNumbers(values) {
  if (!Array.isArray(values) || values.length === 0
    || values.some((value) => !Number.isFinite(value))) {
    throw new Error('summary values must be finite and non-empty');
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return {
    count: values.length,
    min: Number(Math.min(...values).toFixed(3)),
    p50: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
    max: Number(Math.max(...values).toFixed(3)),
    mean: Number(mean.toFixed(3)),
    coefficient_of_variation_percent: Number((
      mean === 0 ? 0 : (Math.sqrt(variance) / mean) * 100
    ).toFixed(3)),
  };
}

export function frameSummary(timestamps) {
  if (!Array.isArray(timestamps) || timestamps.length < 2) {
    return {
      frame_count: timestamps?.length ?? 0,
      duration_ms: 0,
      fps: 0,
      p50_frame_ms: 0,
      p95_frame_ms: 0,
      frames_over_25_ms_percent: 0,
      frames_over_50_ms_percent: 0,
    };
  }
  const deltas = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const delta = timestamps[index] - timestamps[index - 1];
    if (Number.isFinite(delta) && delta >= 0) deltas.push(delta);
  }
  const duration = timestamps.at(-1) - timestamps[0];
  const percentage = (threshold) => (
    deltas.filter((delta) => delta > threshold).length / Math.max(1, deltas.length)
  ) * 100;
  return {
    frame_count: timestamps.length,
    duration_ms: Number(duration.toFixed(3)),
    fps: Number((duration <= 0 ? 0 : ((timestamps.length - 1) / duration) * 1000).toFixed(3)),
    p50_frame_ms: Number(percentile(deltas, 0.5).toFixed(3)),
    p95_frame_ms: Number(percentile(deltas, 0.95).toFixed(3)),
    frames_over_25_ms_percent: Number(percentage(25).toFixed(3)),
    frames_over_50_ms_percent: Number(percentage(50).toFixed(3)),
  };
}

export function evaluateTask(requiredSignals, observations) {
  const required = [...requiredSignals];
  const signals = Object.fromEntries(required.map((signal) => [signal, Boolean(observations[signal])]));
  const passed = Object.values(signals).filter(Boolean).length;
  return {
    success: passed === required.length,
    passed_signals: passed,
    required_signals: required.length,
    signals,
  };
}

export function summarizeVisualSamples(samples) {
  const group = new Map();
  for (const sample of samples) {
    const key = [
      sample.target,
      sample.viewport.id,
      sample.product,
      sample.cache_phase,
    ].join('\0');
    const bucket = group.get(key) ?? [];
    bucket.push(sample);
    group.set(key, bucket);
  }
  return [...group.entries()].map(([key, rows]) => {
    const [target, viewport, product, cachePhase] = key.split('\0');
    const valid = rows.filter((row) => row.status !== 'failed');
    const values = (selector) => valid.map(selector);
    return {
      target,
      viewport,
      product,
      cache_phase: cachePhase,
      runs: rows.length,
      completed_runs: valid.length,
      failed_runs: rows.length - valid.length,
      first_usable_render_ms: valid.length ? summarizeNumbers(values((row) => row.first_usable_render_ms)) : null,
      interaction_fps: valid.length ? summarizeNumbers(values((row) => row.interaction.fps)) : null,
      interaction_p95_frame_ms: valid.length ? summarizeNumbers(values((row) => row.interaction.p95_frame_ms)) : null,
      long_task_p95_ms: valid.length ? summarizeNumbers(values((row) => row.long_task_p95_ms)) : null,
      idle_cpu_percent: valid.length ? summarizeNumbers(values((row) => row.idle_cpu_percent)) : null,
      heap_mib: valid.length ? summarizeNumbers(values((row) => row.heap_mib)) : null,
      task_success_runs: valid.filter((row) => row.task.success).length,
      task_time_ms: valid.length ? summarizeNumbers(values((row) => row.task_time_ms)) : null,
      action_count: valid.length ? summarizeNumbers(values((row) => row.actions.length)) : null,
      context_loss_events: valid.reduce((sum, row) => sum + row.context_loss_events, 0),
      console_errors: valid.reduce((sum, row) => sum + row.console_errors.length, 0),
      page_errors: valid.reduce((sum, row) => sum + row.page_errors.length, 0),
      http_errors: valid.reduce((sum, row) => sum + row.http_errors.length, 0),
      clipping_failures: valid.reduce((sum, row) => sum + row.clipping_failures.length, 0),
      overlap_failures: valid.reduce((sum, row) => sum + row.overlap_failures.length, 0),
      accessibility_failures: valid.reduce((sum, row) => sum + row.accessibility_failures.length, 0),
    };
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
