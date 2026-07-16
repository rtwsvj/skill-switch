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

/**
 * Advisory 规则:仍产出 finding 供人复核,但**不计入安全评分**——因此无法把 score
 * 压到 DANGER_THRESHOLD 以下,不会翻转默认退出码(兑现 report-only 承诺)。
 * 注:自定义 policy 的 `failOn: medium` 仍可显式对其阻断(opt-in)——那条路径按 severity
 * 判定、不经 score,故本豁免只影响"默认(评分驱动)"退出码,不影响用户显式选择的门控。
 */
export const ADVISORY_RULE_IDS: ReadonlySet<string> = new Set(['agentic/lethal-trifecta']);

export function scoreFindings(findings: ReadonlyArray<{ severity: Severity; ruleId?: string }>): number {
  let criticals = 0;
  let penalty = 0;
  for (const f of findings) {
    // advisory finding 不计分(report-only);ruleId 缺省的裸对象按普通 finding 计。
    if (f.ruleId !== undefined && ADVISORY_RULE_IDS.has(f.ruleId)) continue;
    if (f.severity === 'critical') criticals += 1;
    penalty += WEIGHTS[f.severity];
  }
  if (criticals >= INSTANT_ZERO_CRITICALS) return 0;
  return Math.max(0, 100 - penalty);
}

export function verdictForScore(score: number): Verdict {
  if (score >= SAFE_THRESHOLD) return 'SAFE';
  if (score >= DANGER_THRESHOLD) return 'REVIEW';
  return 'DANGER';
}
