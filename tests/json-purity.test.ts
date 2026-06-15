// M0-5.5:所有 --json 命令的 stdout 必须是纯 JSON(日志/进度只能进 stderr)。
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'home-basic');

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PAGER: '', GIT_PAGER: '' },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'skill-switch-jsonpurity-'));
}

// [label, args] —— 退出码可能非零(如 audit 命中风险),但 stdout 必须仍是纯 JSON。
const cases: Array<[string, string[]]> = [
  ['scan', ['scan', '--home', FIXTURE, '--json']],
  ['audit', ['audit', '--home', FIXTURE, '--json']],
  ['doctor', ['doctor', '--home', FIXTURE, '--json']],
  ['drift', ['drift', '--home', FIXTURE, '--json']],
  ['stats', ['stats', '--home', FIXTURE, '--json']],
  ['lint', ['lint', '--home', FIXTURE, '--json']],
  ['lock --verify', ['lock', '--verify', '--home', FIXTURE, '--json']],
  ['sync --dry-run', ['sync', '--dry-run', '--home', tmpHome(), '--json']],
  ['restore (list)', ['restore', '--home', tmpHome(), '--json']],
  ['uninstall --dry-run', ['uninstall', '--dry-run', '--home', tmpHome(), '--json']],
];

describe('CLI --json stdout purity', () => {
  for (const [label, args] of cases) {
    it(`${label} emits pure JSON on stdout`, () => {
      const { stdout } = run(args);
      const trimmed = stdout.trim();
      expect(trimmed.length, `${label} stdout 为空`).toBeGreaterThan(0);
      // 第一个非空白字符必须是 { 或 [ —— 没有泄漏的日志前缀
      expect(['{', '['], `${label} stdout 不以 JSON 起始: ${trimmed.slice(0, 60)}`).toContain(trimmed[0]);
      // 整段 stdout 必须能完整 parse(中途没有混入非 JSON 行)
      expect(() => JSON.parse(trimmed), `${label} stdout 不是合法 JSON`).not.toThrow();
    });
  }
});
