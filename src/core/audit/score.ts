// 评分器:纯函数,规格逐字来自 ags SECURITY.md Scoring 章节(已源码级核实):
//   Score = 100 - (CRITICAL × 20) - (HIGH × 10) - (MEDIUM × 3) - (LOW × 1)
//   ≥5 个 CRITICAL 直接 0 分;档位 90-100 SAFE / 70-89 REVIEW / <70 DANGER。
import type { Severity } from './types.ts';

export type Verdict = 'SAFE' | 'REVIEW' | 'DANGER';

export const DANGER_THRESHOLD = 70;
export const SAFE_THRESHOLD = 90;
export const INSTANT_ZERO_CRITICALS = 5;

const WEIGHTS: Record<Severity, number> = {
  critical: 20,
  high: 10,
  medium: 3,
  low: 1,
};

export function scoreFindings(findings: ReadonlyArray<{ severity: Severity }>): number {
  let criticals = 0;
  let penalty = 0;
  for (const { severity } of findings) {
    if (severity === 'critical') criticals += 1;
    penalty += WEIGHTS[severity];
  }
  if (criticals >= INSTANT_ZERO_CRITICALS) return 0;
  return Math.max(0, 100 - penalty);
}

export function verdictForScore(score: number): Verdict {
  if (score >= SAFE_THRESHOLD) return 'SAFE';
  if (score >= DANGER_THRESHOLD) return 'REVIEW';
  return 'DANGER';
}
