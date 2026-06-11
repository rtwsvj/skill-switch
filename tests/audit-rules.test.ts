// S2.2:外渗 + 反向 shell 规则的命中/反例验收。
// 每条规则至少 1 个恶意样本命中(按 ruleId 断言),全部良性样本零误报。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allRules } from '../rules/index.ts';
import { auditContents } from '../src/core/audit/engine.ts';
import { verdictForScore } from '../src/core/audit/score.ts';

const FIX = join(import.meta.dirname, 'fixtures');

function auditSample(kind: 'skills-malicious' | 'skills-benign', name: string) {
  const file = join(FIX, kind, name, 'SKILL.md');
  return auditContents(allRules, [{ file: 'SKILL.md', content: readFileSync(file, 'utf8') }]);
}

const MALICIOUS_EXPECT: Array<[string, string]> = [
  ['exfil-curl-secret', 'exfiltration/curl-body-with-secret'],
  ['exfil-ssh-key', 'exfiltration/sensitive-file-read'],
  ['exfil-ssh-key', 'exfiltration/exfil-endpoint'],
  ['revshell-dev-tcp', 'reverse-shell/dev-tcp'],
  ['revshell-python', 'reverse-shell/scripting-socket'],
  ['revshell-netcat', 'reverse-shell/netcat-exec'],
];

const BENIGN_SAMPLES = ['network-helper', 'api-client', 'ssh-config-tips'];

describe('S2.2 audit rules — malicious samples', () => {
  it.each(MALICIOUS_EXPECT)('%s triggers %s', (sample, ruleId) => {
    const report = auditSample('skills-malicious', sample);
    expect(report.findings.map((f) => f.ruleId)).toContain(ruleId);
  });

  // S2.2 范围:确认恶意样本被规则识别(有 CRITICAL、非 SAFE)。
  // "评分 <70 → exit 1" 的硬阻断策略属 S2.5;单条 CRITICAL 按 ags 评分=80=REVIEW,
  // 是否对任意 CRITICAL 直接阻断留给 S2.5 决定(见改动记录)。
  it.each([...new Set(MALICIOUS_EXPECT.map(([s]) => s))])(
    '%s yields a CRITICAL finding and is not SAFE',
    (sample) => {
      const report = auditSample('skills-malicious', sample);
      expect(report.findings.some((f) => f.severity === 'critical')).toBe(true);
      expect(report.verdict).not.toBe('SAFE');
    },
  );
});

describe('S2.2 audit rules — benign counterexamples', () => {
  it.each(BENIGN_SAMPLES)('%s produces zero findings and stays SAFE', (sample) => {
    const report = auditSample('skills-benign', sample);
    expect(report.findings).toEqual([]);
    expect(report.score).toBe(100);
    expect(verdictForScore(report.score)).toBe('SAFE');
  });
});

describe('S2.2 rule registry hygiene', () => {
  it('every rule has a unique id and a non-empty source attribution', () => {
    const ids = allRules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of allRules) {
      expect(rule.source.length, rule.id).toBeGreaterThan(0);
    }
  });
});
