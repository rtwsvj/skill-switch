// S2.2:外渗 + 反向 shell 规则的命中/反例验收。
// 每条规则至少 1 个恶意样本命中(按 ruleId 断言),全部良性样本零误报。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allFileRules, allRules } from '../rules/index.ts';
import { auditContents } from '../src/core/audit/engine.ts';
import { verdictForScore } from '../src/core/audit/score.ts';

const FIX = join(import.meta.dirname, 'fixtures');

function auditSample(kind: 'skills-malicious' | 'skills-benign', name: string) {
  const file = join(FIX, kind, name, 'SKILL.md');
  return auditContents(allRules, [{ file: 'SKILL.md', content: readFileSync(file, 'utf8') }], allFileRules);
}

const MALICIOUS_EXPECT: Array<[string, string]> = [
  ['exfil-curl-secret', 'exfiltration/curl-body-with-secret'],
  ['exfil-ssh-key', 'exfiltration/sensitive-file-exfil'],
  ['exfil-ssh-key', 'exfiltration/exfil-endpoint'],
  ['exfil-staged-read', 'exfiltration/staged-read-exfil'],
  ['revshell-dev-tcp', 'reverse-shell/dev-tcp'],
  ['revshell-python', 'reverse-shell/scripting-socket'],
  ['revshell-netcat', 'reverse-shell/netcat-exec'],
  // S2.3
  ['destruct-rm-rf', 'destructive/rm-rf-root'],
  ['destruct-mkfs', 'destructive/disk-overwrite'],
  ['destruct-forkbomb', 'destructive/fork-bomb'],
  ['clickfix-gatekeeper', 'clickfix/gatekeeper-bypass'],
  ['clickfix-curl-bash', 'clickfix/curl-pipe-shell'],
  ['clickfix-curl-bash', 'clickfix/copy-paste-lure'],
  ['staged-prerequisite', 'staged/prerequisite-install'],
  ['staged-prerequisite', 'staged/chained-download-exec'],
  // S2.4
  ['persist-shell-startup', 'persistence/shell-startup'],
  ['persist-cron-githook', 'persistence/cron'],
  ['persist-cron-githook', 'persistence/git-hooks'],
  ['tamper-claude-settings', 'global-tamper/agent-config-write'],
  ['tamper-claude-settings', 'global-tamper/permission-grant'],
  // F6
  ['cred-phish-secret', 'credential-theft/phishing-request'],
  ['cred-keychain-dump', 'credential-theft/credential-store-read'],
  ['cred-token-webhook', 'credential-theft/token-exfil'],
  ['supply-typosquat-package', 'supply-chain/typosquat-package'],
  ['supply-untrusted-source', 'supply-chain/untrusted-install-source'],
];

const BENIGN_SAMPLES = [
  'network-helper',
  'api-client',
  'ssh-config-tips',
  'project-setup',
  'shell-aliases',
  'credential-handling-safe',
  'supply-official-install',
];

const BENIGN_SAFE_WITH_FINDINGS: Array<[string, string]> = [
  ['secret-uploader', 'exfiltration/sensitive-path-reference'],
  ['tls-cert-curl', 'exfiltration/sensitive-path-reference'],
];

describe('S2.2 audit rules — malicious samples', () => {
  it.each(MALICIOUS_EXPECT)('%s triggers %s', (sample, ruleId) => {
    const report = auditSample('skills-malicious', sample);
    expect(report.findings.map((f) => f.ruleId)).toContain(ruleId);
  });

  // 可验证不变量:每个恶意样本都被规则识别(至少一条 finding)。
  // 注意 verdict 不是这里的判据:按 ags 纯评分,单条 HIGH=90=SAFE、单条 CRITICAL=80=REVIEW,
  // 也就是说"光看分数,一个登录后门可能被判 SAFE"。这正是 S2.5 必须用
  // 严重度下限阻断(任意 CRITICAL/HIGH 即 exit 1)而非只看分数带的原因(见改动记录)。
  it.each([...new Set(MALICIOUS_EXPECT.map(([s]) => s))])(
    '%s yields at least one finding',
    (sample) => {
      const report = auditSample('skills-malicious', sample);
      expect(report.findings.length).toBeGreaterThan(0);
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

  it.each(BENIGN_SAFE_WITH_FINDINGS)('%s only produces non-blocking %s', (sample, ruleId) => {
    const report = auditSample('skills-benign', sample);
    expect(report.findings.map((f) => f.ruleId)).toEqual([ruleId]);
    expect(report.findings[0]!.severity).toBe('low');
    expect(report.score).toBeGreaterThanOrEqual(90);
    expect(verdictForScore(report.score)).toBe('SAFE');
  });
});

describe('S2.2 rule registry hygiene', () => {
  it('every rule has a unique id and a non-empty source attribution', () => {
    const rules = [...allRules, ...allFileRules];
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of rules) {
      expect(rule.source.length, rule.id).toBeGreaterThan(0);
    }
  });
});
