// A1: gap-fill — audit/score.ts 纯函数覆盖(scoreFindings + verdictForScore)
import { describe, expect, it } from 'vitest';
import {
  DANGER_THRESHOLD,
  INSTANT_ZERO_CRITICALS,
  SAFE_THRESHOLD,
  scoreFindings,
  verdictForScore,
} from '../src/core/audit/score.ts';

describe('scoreFindings', () => {
  it('returns 100 for no findings', () => {
    expect(scoreFindings([])).toBe(100);
  });

  it('deducts correct weights per severity', () => {
    // 1 critical(20) + 1 high(10) + 1 medium(3) + 1 low(1) = 34 deducted → 66
    expect(
      scoreFindings([
        { severity: 'critical' },
        { severity: 'high' },
        { severity: 'medium' },
        { severity: 'low' },
      ]),
    ).toBe(66);
  });

  it('floors at 0 when penalty exceeds 100', () => {
    // 6 criticals = 120 penalty, but also triggers instant-zero path
    expect(scoreFindings(Array.from({ length: 6 }, () => ({ severity: 'critical' as const })))).toBe(0);
    // 11 highs = 110 penalty, not an instant-zero → still 0 (floor)
    expect(scoreFindings(Array.from({ length: 11 }, () => ({ severity: 'high' as const })))).toBe(0);
  });

  it(`returns 0 instantly when criticals >= ${INSTANT_ZERO_CRITICALS}`, () => {
    // exactly 5 criticals → instant zero regardless of other findings
    const findings = Array.from({ length: INSTANT_ZERO_CRITICALS }, () => ({ severity: 'critical' as const }));
    expect(scoreFindings(findings)).toBe(0);
  });

  it('does not instant-zero with fewer than 5 criticals', () => {
    // 4 criticals = 80 penalty → score 20
    const findings = Array.from({ length: 4 }, () => ({ severity: 'critical' as const }));
    expect(scoreFindings(findings)).toBe(20);
  });
});

describe('verdictForScore', () => {
  it(`returns SAFE at or above ${SAFE_THRESHOLD}`, () => {
    expect(verdictForScore(100)).toBe('SAFE');
    expect(verdictForScore(SAFE_THRESHOLD)).toBe('SAFE');
  });

  it(`returns REVIEW between ${DANGER_THRESHOLD} and ${SAFE_THRESHOLD - 1}`, () => {
    expect(verdictForScore(SAFE_THRESHOLD - 1)).toBe('REVIEW');
    expect(verdictForScore(DANGER_THRESHOLD)).toBe('REVIEW');
  });

  it(`returns DANGER below ${DANGER_THRESHOLD}`, () => {
    expect(verdictForScore(DANGER_THRESHOLD - 1)).toBe('DANGER');
    expect(verdictForScore(0)).toBe('DANGER');
  });
});
