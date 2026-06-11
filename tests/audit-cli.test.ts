// S2.5:audit CLI 验收 — 阻断用严重度下限(任意 critical/high 或 score<70 → exit 1)。
// exit code 用真实子进程验证,不是 mock。
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditSkillDir, shouldBlock } from '../src/cli/commands/audit.ts';

const ROOT = join(import.meta.dirname, '..');
const FIX = join(import.meta.dirname, 'fixtures');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

function runAudit(path: string, extra: string[] = []): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', CLI, 'audit', path, ...extra],
      { cwd: ROOT, encoding: 'utf8' },
    );
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? -1 };
  }
}

const MALICIOUS = readdirSync(join(FIX, 'skills-malicious'));
const BENIGN = readdirSync(join(FIX, 'skills-benign'));

describe('shouldBlock policy (severity floor)', () => {
  it('blocks on any critical or high finding regardless of score', () => {
    expect(shouldBlock({ score: 90, findings: [{ severity: 'high' } as never] })).toBe(true);
    expect(shouldBlock({ score: 80, findings: [{ severity: 'critical' } as never] })).toBe(true);
  });

  it('blocks on score < 70 even if only medium/low findings', () => {
    const manyMedium = Array.from({ length: 11 }, () => ({ severity: 'medium' }) as never);
    expect(shouldBlock({ score: 67, findings: manyMedium })).toBe(true);
  });

  it('does not block a clean skill', () => {
    expect(shouldBlock({ score: 100, findings: [] })).toBe(false);
  });

  it('does not block on a lone medium/low finding above the score band', () => {
    expect(shouldBlock({ score: 97, findings: [{ severity: 'medium' } as never] })).toBe(false);
  });
});

describe('auditSkillDir', () => {
  it('reads every text file under the skill dir', async () => {
    const report = await auditSkillDir(join(FIX, 'skills-malicious', 'tamper-claude-settings'));
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.map((f) => f.ruleId)).toContain('global-tamper/agent-config-write');
  });
});

describe('audit CLI (real subprocess)', () => {
  it.each(MALICIOUS)('malicious/%s exits 1', (name) => {
    const { status } = runAudit(join(FIX, 'skills-malicious', name));
    expect(status).toBe(1);
  });

  it.each(BENIGN)('benign/%s exits 0 and scores >= 90', (name) => {
    const { stdout, status } = runAudit(join(FIX, 'skills-benign', name), ['--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { score: number; verdict: string };
    expect(parsed.score).toBeGreaterThanOrEqual(90);
    expect(parsed.verdict).toBe('SAFE');
  });

  it('--json emits findings with ruleId/severity/file/line', () => {
    const { stdout } = runAudit(join(FIX, 'skills-malicious', 'revshell-dev-tcp'), ['--json']);
    const parsed = JSON.parse(stdout) as {
      findings: Array<{ ruleId: string; severity: string; file: string; line: number }>;
    };
    expect(parsed.findings.length).toBeGreaterThan(0);
    const f = parsed.findings[0]!;
    expect(f).toHaveProperty('ruleId');
    expect(f).toHaveProperty('severity');
    expect(f).toHaveProperty('file');
    expect(typeof f.line).toBe('number');
  });
});
