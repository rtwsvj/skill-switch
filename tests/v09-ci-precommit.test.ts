// v0.9 `skill-switch ci --pre-commit` 命令验收测试。
// 覆盖:
//   1. --pre-commit 默认用法:写出合法 YAML .pre-commit-config.yaml,含 skill-switch hook
//   2. 防覆盖保护:已有文件时不传 --force → exit 1;传 --force → 覆盖成功
//   3. --out 自定义路径
//   4. --json 输出格式:含 status / preCommitPath / filesWritten
//   5. 普通 ci(不传 --pre-commit)行为不变:仍写 workflow 文件
//
// 所有 CLI 调用通过 bin shim(bin/skill-switch.mjs)在临时目录下执行。

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'skill-switch.mjs');

// ── 临时目录管理 ─────────────────────────────────────────────────────────────

const TMP_DIRS: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v09-precommit-'));
  TMP_DIRS.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of TMP_DIRS) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

// ── CLI 辅助 ─────────────────────────────────────────────────────────────────

function runBin(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf8',
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? -1 };
  }
}

// ── 1. 默认用法 ──────────────────────────────────────────────────────────────

describe('skill-switch ci --pre-commit 默认用法', () => {
  it('exit 0,写出 .pre-commit-config.yaml', () => {
    const dir = makeTmpDir();
    const { status } = runBin(['ci', '--pre-commit'], dir);
    expect(status).toBe(0);
    expect(existsSync(join(dir, '.pre-commit-config.yaml'))).toBe(true);
  });

  it('输出文件是可解析 YAML(含关键顶层键 repos:)', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--pre-commit'], dir);
    const content = readFileSync(join(dir, '.pre-commit-config.yaml'), 'utf8');
    // 含 repos: 顶层键
    expect(content).toMatch(/^repos:/m);
  });

  it('含 repo: local', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--pre-commit'], dir);
    const content = readFileSync(join(dir, '.pre-commit-config.yaml'), 'utf8');
    expect(content).toContain('repo: local');
  });

  it('含 skill-switch-audit hook id', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--pre-commit'], dir);
    const content = readFileSync(join(dir, '.pre-commit-config.yaml'), 'utf8');
    expect(content).toContain('id: skill-switch-audit');
  });

  it('entry 调用 npx @rtwsvj/skill-switch audit --configs', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--pre-commit'], dir);
    const content = readFileSync(join(dir, '.pre-commit-config.yaml'), 'utf8');
    expect(content).toContain('npx @rtwsvj/skill-switch audit --configs');
  });

  it('language: system', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--pre-commit'], dir);
    const content = readFileSync(join(dir, '.pre-commit-config.yaml'), 'utf8');
    expect(content).toContain('language: system');
  });

  it('pass_filenames: false', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--pre-commit'], dir);
    const content = readFileSync(join(dir, '.pre-commit-config.yaml'), 'utf8');
    expect(content).toContain('pass_filenames: false');
  });

  it('stdout 含"已写入 pre-commit 配置"', () => {
    const dir = makeTmpDir();
    const { stdout } = runBin(['ci', '--pre-commit'], dir);
    expect(stdout).toContain('已写入 pre-commit 配置');
  });

  it('stdout 含 pip install pre-commit 提示', () => {
    const dir = makeTmpDir();
    const { stdout } = runBin(['ci', '--pre-commit'], dir);
    expect(stdout).toContain('pip install pre-commit');
  });

  it('stdout 含 pre-commit install 提示', () => {
    const dir = makeTmpDir();
    const { stdout } = runBin(['ci', '--pre-commit'], dir);
    expect(stdout).toContain('pre-commit install');
  });

  it('不写 .github/workflows/ 目录', () => {
    const dir = makeTmpDir();
    runBin(['ci', '--pre-commit'], dir);
    expect(existsSync(join(dir, '.github', 'workflows', 'skill-switch.yml'))).toBe(false);
  });
});

// ── 2. 防覆盖保护 ────────────────────────────────────────────────────────────

describe('ci --pre-commit 防覆盖保护', () => {
  it('已有 .pre-commit-config.yaml 时不传 --force → exit 1 + stderr 含"已存在"', () => {
    const dir = makeTmpDir();
    // 先写一次
    runBin(['ci', '--pre-commit'], dir);
    // 第二次应失败
    const { status, stderr } = runBin(['ci', '--pre-commit'], dir);
    expect(status).toBe(1);
    expect(stderr).toContain('已存在');
  });

  it('--force 可覆盖已有文件', () => {
    const dir = makeTmpDir();
    // 先写一次正常内容
    runBin(['ci', '--pre-commit'], dir);
    // 用 --force 覆盖
    const { status } = runBin(['ci', '--pre-commit', '--force'], dir);
    expect(status).toBe(0);
    // 文件仍存在且内容合法
    const content = readFileSync(join(dir, '.pre-commit-config.yaml'), 'utf8');
    expect(content).toContain('repo: local');
  });

  it('无 --force 时文件内容不被修改', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, '.pre-commit-config.yaml');
    writeFileSync(filePath, 'custom: existing content', 'utf8');
    runBin(['ci', '--pre-commit'], dir); // 无 --force,应失败
    const afterContent = readFileSync(filePath, 'utf8');
    expect(afterContent).toBe('custom: existing content');
  });
});

// ── 3. --out 自定义路径 ───────────────────────────────────────────────────────

describe('ci --pre-commit --out 自定义路径', () => {
  it('写到指定文件路径', () => {
    const dir = makeTmpDir();
    const customPath = join(dir, 'my-hooks.yaml');
    const { status } = runBin(['ci', '--pre-commit', '--out', customPath], dir);
    expect(status).toBe(0);
    expect(existsSync(customPath)).toBe(true);
  });

  it('自定义路径文件含正确 hook 内容', () => {
    const dir = makeTmpDir();
    const customPath = join(dir, 'my-hooks.yaml');
    runBin(['ci', '--pre-commit', '--out', customPath], dir);
    const content = readFileSync(customPath, 'utf8');
    expect(content).toContain('repo: local');
    expect(content).toContain('skill-switch-audit');
  });

  it('默认路径 .pre-commit-config.yaml 未被写入', () => {
    const dir = makeTmpDir();
    const customPath = join(dir, 'my-hooks.yaml');
    runBin(['ci', '--pre-commit', '--out', customPath], dir);
    expect(existsSync(join(dir, '.pre-commit-config.yaml'))).toBe(false);
  });

  it('已有文件且 --out 时仍遵守防覆盖保护', () => {
    const dir = makeTmpDir();
    const customPath = join(dir, 'my-hooks.yaml');
    writeFileSync(customPath, 'existing', 'utf8');
    const { status, stderr } = runBin(['ci', '--pre-commit', '--out', customPath], dir);
    expect(status).toBe(1);
    expect(stderr).toContain('已存在');
  });
});

// ── 4. --json 输出 ────────────────────────────────────────────────────────────

describe('ci --pre-commit --json', () => {
  it('输出合法 JSON', () => {
    const dir = makeTmpDir();
    const { stdout } = runBin(['ci', '--pre-commit', '--json'], dir);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('JSON 含 status: ok', () => {
    const dir = makeTmpDir();
    const { stdout } = runBin(['ci', '--pre-commit', '--json'], dir);
    const result = JSON.parse(stdout) as { status: string };
    expect(result.status).toBe('ok');
  });

  it('JSON 含 preCommitPath(字符串)', () => {
    const dir = makeTmpDir();
    const { stdout } = runBin(['ci', '--pre-commit', '--json'], dir);
    const result = JSON.parse(stdout) as { preCommitPath: string };
    expect(typeof result.preCommitPath).toBe('string');
    expect(result.preCommitPath.length).toBeGreaterThan(0);
  });

  it('JSON 含 filesWritten 数组,且不为空', () => {
    const dir = makeTmpDir();
    const { stdout } = runBin(['ci', '--pre-commit', '--json'], dir);
    const result = JSON.parse(stdout) as { filesWritten: string[] };
    expect(Array.isArray(result.filesWritten)).toBe(true);
    expect(result.filesWritten.length).toBeGreaterThan(0);
  });

  it('filesWritten[0] 指向实际写出的文件', () => {
    const dir = makeTmpDir();
    const { stdout } = runBin(['ci', '--pre-commit', '--json'], dir);
    const result = JSON.parse(stdout) as { filesWritten: string[] };
    expect(existsSync(result.filesWritten[0]!)).toBe(true);
  });
});

// ── 5. 普通 ci(不传 --pre-commit)行为不变 ──────────────────────────────────

describe('普通 ci(不传 --pre-commit)行为保持不变', () => {
  it('写出 .github/workflows/skill-switch.yml,exit 0', () => {
    const dir = makeTmpDir();
    const { status } = runBin(['ci'], dir);
    expect(status).toBe(0);
    expect(existsSync(join(dir, '.github', 'workflows', 'skill-switch.yml'))).toBe(true);
  });

  it('不写 .pre-commit-config.yaml', () => {
    const dir = makeTmpDir();
    runBin(['ci'], dir);
    expect(existsSync(join(dir, '.pre-commit-config.yaml'))).toBe(false);
  });

  it('workflow 文件含正确 uses: 引脚', () => {
    const dir = makeTmpDir();
    runBin(['ci'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    expect(content).toContain('rtwsvj/skill-switch@v0.8.0');
  });

  it('workflow 文件含 security-events: write(sarif 默认格式)', () => {
    const dir = makeTmpDir();
    runBin(['ci'], dir);
    const content = readFileSync(join(dir, '.github', 'workflows', 'skill-switch.yml'), 'utf8');
    expect(content).toContain('security-events: write');
  });

  it('stdout 含"已写入工作流文件"', () => {
    const dir = makeTmpDir();
    const { stdout } = runBin(['ci'], dir);
    expect(stdout).toContain('已写入工作流文件');
  });
});
