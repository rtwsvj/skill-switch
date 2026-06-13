// F11:package bin shim — 不引入打包器,直接用已有 tsx loader 启动 TS CLI。
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

function binPath(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
  };
  expect(pkg.bin?.['skill-switch']).toBe('bin/skill-switch.mjs');
  return join(ROOT, pkg.bin!['skill-switch']!);
}

describe('skill-switch bin shim', () => {
  it('is declared in package.json, executable, and can print help', () => {
    const bin = binPath();
    expect(statSync(bin).mode & 0o111).toBeGreaterThan(0);

    const stdout = execFileSync(bin, ['--help'], { cwd: ROOT, encoding: 'utf8' });
    expect(stdout).toContain('Usage: skill-switch');
    expect(stdout).toContain('scan');
  });

  // 回归:全局 `skill-switch` 会在任意目录运行;tsx 必须相对脚本(仓库内)解析,
  // 不能相对 cwd,否则仓库外运行会 ERR_MODULE_NOT_FOUND: tsx。
  it('runs from a cwd outside the repo (tsx resolved relative to the shim)', () => {
    const bin = binPath();
    const stdout = execFileSync(bin, ['--help'], { cwd: tmpdir(), encoding: 'utf8' });
    expect(stdout).toContain('Usage: skill-switch');
  });
});
