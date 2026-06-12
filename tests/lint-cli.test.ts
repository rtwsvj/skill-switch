// S5.3:lint 聚合验收 — 冲突样本对报 critical、预算数字、exit 语义(error=1 / 仅 warning=0)。
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintHome, lintSkillDir } from '../src/core/lint/lint-home.ts';

const ROOT = join(import.meta.dirname, '..');
const FIX = join(import.meta.dirname, 'fixtures');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

function runLint(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', CLI, 'lint', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? -1 };
  }
}

describe('lintHome', () => {
  it('home-conflict 的对立 skill 对报出 ≥1 critical 冲突 → hasErrors', async () => {
    const report = await lintHome(join(FIX, 'home-conflict'), 'claude-code');
    expect(report.conflicts.summary.critical).toBeGreaterThanOrEqual(1);
    expect(report.hasErrors).toBe(true);
  });

  it('home-basic 输出预算数字(100 tokens/skill 口径 + 全量估算)', async () => {
    const report = await lintHome(join(FIX, 'home-basic'), 'claude-code');
    const claudeRow = report.budget.perAgent.find((r) => r.relSkillsDir.includes('.claude'));
    expect(claudeRow).toBeDefined();
    expect(claudeRow!.skillCount).toBe(3);
    expect(claudeRow!.metadataTokens).toBe(300);
    expect(report.budget.plan).toBeDefined();
    expect(report.budget.plan!.totalTokens).toBeGreaterThan(0);
  });

  it('home-basic 的坏样本(mismatched/broken)→ hasErrors', async () => {
    const report = await lintHome(join(FIX, 'home-basic'), 'claude-code');
    const mismatched = report.skills.find((s) => s.name === 'mismatched-name');
    expect(mismatched!.specErrors.join()).toContain('must match skill name');
    const broken = report.skills.find((s) => s.name === 'broken-frontmatter');
    expect(broken!.specErrors.length).toBeGreaterThan(0);
    expect(report.hasErrors).toBe(true);
  });
});

describe('lintSkillDir: 平台扩展字段分流', () => {
  it('Claude 扩展字段对 target=claude-code 不算 spec error', async () => {
    const result = await lintSkillDir(join(FIX, 'skills-portability', 'claude-flavored'), 'claude-code');
    expect(result.specErrors).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('同一 skill 对 target=codex 产生 warnings(专有字段 + $ARGUMENTS),无 error', async () => {
    const result = await lintSkillDir(join(FIX, 'skills-portability', 'claude-flavored'), 'codex');
    expect(result.specErrors).toEqual([]);
    expect(result.issues.filter((i) => i.severity === 'warning').length).toBeGreaterThanOrEqual(3);
    expect(result.issues.some((i) => i.severity === 'error')).toBe(false);
  });
});

describe('lint CLI exit 语义(真实子进程)', () => {
  it('仅 warning → exit 0', () => {
    const { status } = runLint([
      join(FIX, 'skills-portability', 'claude-flavored'),
      '--target',
      'codex',
    ]);
    expect(status).toBe(0);
  });

  it('error(冲突 home)→ exit 1', () => {
    const { status } = runLint(['--home', join(FIX, 'home-conflict')]);
    expect(status).toBe(1);
  });

  it('--json 单 skill 输出可解析', () => {
    const { stdout } = runLint([
      join(FIX, 'skills-portability', 'claude-flavored'),
      '--target',
      'codex',
      '--json',
    ]);
    const parsed = JSON.parse(stdout) as { issues: Array<{ rule: string }> };
    expect(parsed.issues.map((i) => i.rule)).toContain('portability/claude-only-field');
  });
});
