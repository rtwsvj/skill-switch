// F7:CLI 顶层错误处理 — action 抛错时 stderr 给干净消息,不泄露栈。
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? -1 };
  }
}

describe('CLI global error handling', () => {
  it('prints a clean error to stderr without a stack trace for action errors', () => {
    const home = mkdtempSync(join(tmpdir(), 'skill-switch-clierr-'));
    const result = runCli(['install', 'x', '--agent', 'no-such-agent', '--home', home]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('错误:');
    expect(result.stderr).toMatch(/agent/i);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/\n\s+at\s/);
  });

  it('--help still exits 0', () => {
    const result = runCli(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stderr).toBe('');
  });
});
