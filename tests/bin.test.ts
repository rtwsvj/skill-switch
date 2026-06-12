// F11:package bin shim — 不引入打包器,直接用已有 tsx loader 启动 TS CLI。
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

describe('skill-switch bin shim', () => {
  it('is declared in package.json, executable, and can print help', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
    };
    expect(pkg.bin?.['skill-switch']).toBe('bin/skill-switch.mjs');

    const binPath = join(ROOT, pkg.bin!['skill-switch']!);
    expect(statSync(binPath).mode & 0o111).toBeGreaterThan(0);

    const stdout = execFileSync(binPath, ['--help'], { cwd: ROOT, encoding: 'utf8' });
    expect(stdout).toContain('Usage: skill-switch');
    expect(stdout).toContain('scan');
  });
});
