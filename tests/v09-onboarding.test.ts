// S9.0 onboarding DX 测试:--help QUICK START 块、命令分组标题、scan 空状态提示。
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'skill-switch.mjs');

describe('--help 包含 QUICK START 与命令分组', () => {
  it('--help 输出包含 QUICK START 标题', () => {
    const out = execFileSync(BIN, ['--help'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('QUICK START');
  });

  it('--help 包含示例命令 status', () => {
    const out = execFileSync(BIN, ['--help'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('skill-switch status');
  });

  it('--help 包含示例命令 audit --configs', () => {
    const out = execFileSync(BIN, ['--help'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('audit --configs');
  });

  it('--help 包含 packs suggest', () => {
    const out = execFileSync(BIN, ['--help'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('packs suggest');
  });

  it('--help 包含 --home sandbox 提示', () => {
    const out = execFileSync(BIN, ['--help'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('sandbox');
  });

  it('--help 包含命令分组标题(盘点、安全、治理)', () => {
    const out = execFileSync(BIN, ['--help'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('盘点');
    expect(out).toContain('安全');
    expect(out).toContain('治理');
    expect(out).toContain('套餐');
  });
});

describe('scan 空状态提示', () => {
  it('空 home 时 scan 输出包含 install 或 packs suggest 提示', () => {
    const home = mkdtempSync(join(tmpdir(), 'skill-switch-empty-'));
    const out = execFileSync(BIN, ['scan', '--home', home], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toMatch(/install|packs suggest/);
  });
});

describe('status 注册在 program 命令列表中', () => {
  it('--help 输出包含 status 命令', () => {
    const out = execFileSync(BIN, ['--help'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('status');
  });
});
