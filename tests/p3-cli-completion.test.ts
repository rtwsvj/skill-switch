// P3-D8:completion 命令存在性 + 帮助输出验证。
// 不依赖任何新依赖,全部用 Node 内置 + buildProgram()。
// ⚠ 子进程测试(execFileSync)需要 tsx 启动,单次约 8-12s;须设 testTimeout。
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../src/cli/program.ts';

// tsx 启动 + 加载约 8-12s;参照 r27a-e2e-lifecycle.test.ts 的做法统一放宽。
vi.setConfig({ testTimeout: 60_000 });

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

describe('completion command', () => {
  it('registers a "completion" top-level command', () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('completion');
  });

  it('completion command has a non-empty description', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'completion');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).not.toBe('');
  });

  it('--help lists "completion" in the help output', () => {
    const help = execFileSync(process.execPath, ['--import', 'tsx', CLI, '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(help).toContain('completion');
  });

  it('outputs a bash completion script', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', CLI, 'completion', 'bash'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    // 输出应包含 complete 命令和 skill-switch
    expect(output).toContain('skill-switch');
    expect(output).toContain('complete');
    // 应包含至少几个顶层命令名
    expect(output).toContain('audit');
    expect(output).toContain('status');
    expect(output).toContain('completion');
  });

  it('outputs a zsh completion script', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', CLI, 'completion', 'zsh'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(output).toContain('#compdef skill-switch');
    expect(output).toContain('audit');
  });

  it('outputs a fish completion script', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', CLI, 'completion', 'fish'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(output).toContain('skill-switch');
    expect(output).toContain('audit');
  });

  it('completion command has helpGroup set to 集成', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'completion');
    expect(cmd?.helpGroup()).toBe('集成');
  });
});
