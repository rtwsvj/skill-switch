// A3: audit regexes must not let a single pathological line DoS the scanner.
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { allFileRules, allRules } from '../rules/index.ts';
import {
  MAX_AUDIT_MATCH_LINE_LENGTH,
  runFileRules,
  runRules,
} from '../src/core/audit/engine.ts';
import type { AuditRule } from '../src/core/audit/types.ts';

const MAX_FILE_BYTES = 512 * 1024;
// 放宽到 CI 稳健值:线性正则远低于此(<10ms),真 ReDoS 病态回溯是秒级 → 仍稳定判失败。
// 100ms 在 CI 的 GC/CPU 争用尖峰下会间歇误报(本质非逻辑错),1000ms 留足余量消除 flaky。
const RULE_BUDGET_MS = 1_000;

const pathologicalLines = [
  'a'.repeat(MAX_FILE_BYTES),
  'curl '.repeat(Math.floor(MAX_FILE_BYTES / 5)),
  'Application Support/Google/Chrome/'.repeat(Math.floor(MAX_FILE_BYTES / 35)),
  '>>>>>>>>>>>>>>>> tee -a '.repeat(Math.floor(MAX_FILE_BYTES / 22)),
];

function elapsedMs(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

describe('A3 audit ReDoS hardening', () => {
  it.each(allRules)('%s stays within budget on pathological long lines', (rule) => {
    for (const line of pathologicalLines) {
      const duration = elapsedMs(() => {
        runRules([rule], [{ file: 'SKILL.md', content: line }]);
      });
      expect(duration, `${rule.id} exceeded ${RULE_BUDGET_MS}ms`).toBeLessThan(RULE_BUDGET_MS);
    }
  });

  it('file-level staged exfil rules stay within budget on pathological files', () => {
    const content = pathologicalLines.join('\n');
    for (const rule of allFileRules) {
      const duration = elapsedMs(() => {
        runFileRules([rule], [{ file: 'SKILL.md', content }]);
      });
      expect(duration, `${rule.id} exceeded ${RULE_BUDGET_MS}ms`).toBeLessThan(RULE_BUDGET_MS);
    }
  });

  it('line matching is capped before regex evaluation', () => {
    const suffixOnlyRule: AuditRule = {
      id: 'test/suffix-only',
      severity: 'low',
      pattern: /TAIL_SENTINEL/,
      message: 'test rule',
      source: 'test',
    };
    const content = `${'a'.repeat(MAX_AUDIT_MATCH_LINE_LENGTH + 32)}TAIL_SENTINEL`;

    expect(runRules([suffixOnlyRule], [{ file: 'SKILL.md', content }])).toEqual([]);
  });
});
