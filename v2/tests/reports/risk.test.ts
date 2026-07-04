// v2/tests/reports/risk.test.ts
// Tests for computeRiskScore — the shared risk formula used by 3 modules.

import { describe, it, expect } from 'vitest';
import { computeRiskScore } from '../../src/reports/risk.js';

describe('computeRiskScore', () => {
  it('returns 0.2 for zero degree, zero complexity, no notes (only documentation penalty)', () => {
    const score = computeRiskScore(0, 0, 0);
    expect(score).toBeCloseTo(0.2, 5);
  });

  it('returns 0.0 for zero degree, zero complexity, with notes', () => {
    const score = computeRiskScore(0, 0, 1);
    expect(score).toBeCloseTo(0.0, 5);
  });

  it('returns max 0.5 for degree=100, complexity=0, with notes', () => {
    const score = computeRiskScore(100, 0, 1);
    expect(score).toBeCloseTo(0.5, 5);
  });

  it('returns max 0.3 for degree=0, complexity=20, with notes', () => {
    const score = computeRiskScore(0, 20, 1);
    expect(score).toBeCloseTo(0.3, 5);
  });

  it('returns 1.0 for degree=100, complexity=20, no notes (capped)', () => {
    const score = computeRiskScore(100, 20, 0);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('caps at 1.0 even with extreme inputs', () => {
    const score = computeRiskScore(500, 100, 0);
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThanOrEqual(0.0);
  });

  it('returns 0.6 for degree=50, complexity=10, no notes', () => {
    // degreeScore = 50/100 = 0.5
    // complexityScore = 10/20 = 0.5
    // documentationPenalty = 0.2
    // riskScore = 0.5*0.5 + 0.5*0.3 + 0.2 = 0.25 + 0.15 + 0.2 = 0.6
    const score = computeRiskScore(50, 10, 0);
    expect(score).toBeCloseTo(0.6, 5);
  });

  it('produces consistent results across multiple calls', () => {
    const s1 = computeRiskScore(42, 7, 0);
    const s2 = computeRiskScore(42, 7, 0);
    expect(s1).toBe(s2);
  });

  it('is monotonic — higher degree means higher score (with same complexity and notes)', () => {
    const s0 = computeRiskScore(0, 10, 0);
    const s50 = computeRiskScore(50, 10, 0);
    const s100 = computeRiskScore(100, 10, 0);
    expect(s0).toBeLessThan(s50);
    expect(s50).toBeLessThan(s100);
  });

  it('is monotonic — higher complexity means higher score (with same degree and notes)', () => {
    const s0 = computeRiskScore(50, 0, 0);
    const s10 = computeRiskScore(50, 10, 0);
    const s20 = computeRiskScore(50, 20, 0);
    expect(s0).toBeLessThan(s10);
    expect(s10).toBeLessThan(s20);
  });

  it('documentation reduces risk — same degree+complexity with notes scores lower', () => {
    const undocumented = computeRiskScore(50, 10, 0);
    const documented = computeRiskScore(50, 10, 1);
    expect(documented).toBeLessThan(undocumented);
  });
});
