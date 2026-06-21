// A3: CLI 退出码契约测试
//
// README "Exit Codes" 约定:
//   - 只读命令能出报告就 exit 0
//   - audit 任意 critical/high 或评分 < 70 → exit 1
//   - doctor --ci 声明/锁/磁盘不一致 → exit 1
//   - lock --verify 缺失/未知/哈希不符 → exit 1
//   - 出错统一打印 `错误: <信息>` 到 stderr、exit 1、无堆栈
//
// 本文件专注那些在其他测试文件中尚无覆盖的 case。
// subprocess 模式与 audit-cli / doctor-cli / lock.test.ts 保持一致:
// execFileSync + tsx loader。
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

/** 运行 CLI,同时捕获 stdout / stderr / exit code,绝不抛。 */
function run(args: string[]): { stdout: string; stderr: string; status: number } {
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

/** 产生一个全新的空临时目录用作 fake-home。 */
function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'skill-switch-exit-contract-'));
}

// ---------------------------------------------------------------------------
// 出错格式契约:stderr 含 "错误:", exit 1, 无堆栈
// ---------------------------------------------------------------------------

describe('error format contract (stderr + exit 1 + no stack)', () => {
  it('install --mode 无效值 → 错误: + exit 1 + 无堆栈', () => {
    const home = tmpHome();
    const res = run(['install', '/nonexistent', '--agent', 'claude-code', '--mode', 'invalid-mode', '--home', home]);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^错误:/m);
    expect(res.stderr).toContain('invalid-mode');
    expect(`${res.stdout}${res.stderr}`).not.toMatch(/\n\s+at\s/);
  });

  it('lint --target 无效值 → 错误: + exit 1 + 无堆栈', () => {
    const home = tmpHome();
    const res = run(['lint', '--target', 'no-such-target', '--home', home]);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^错误:/m);
    expect(res.stderr).toContain('no-such-target');
    expect(`${res.stdout}${res.stderr}`).not.toMatch(/\n\s+at\s/);
  });

  it('stats --days 负值 → 错误: + exit 1 + 无堆栈', () => {
    const home = tmpHome();
    const res = run(['stats', '--days', '-1', '--home', home]);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^错误:/m);
    expect(`${res.stdout}${res.stderr}`).not.toMatch(/\n\s+at\s/);
  });

  it('stats --days 非数字 → 错误: + exit 1 + 无堆栈', () => {
    const home = tmpHome();
    const res = run(['stats', '--days', 'abc', '--home', home]);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^错误:/m);
    expect(`${res.stdout}${res.stderr}`).not.toMatch(/\n\s+at\s/);
  });

  it('toggle 无 --on/--off → 错误: + exit 1 + 无堆栈', () => {
    const home = tmpHome();
    const res = run(['toggle', 'some-skill', '--home', home]);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^错误:/m);
    expect(`${res.stdout}${res.stderr}`).not.toMatch(/\n\s+at\s/);
  });

  it('audit 不存在的路径 → 错误: + exit 1 + 无堆栈', () => {
    const res = run(['audit', '/no-such-path-skill-switch-test']);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^错误:/m);
    expect(`${res.stdout}${res.stderr}`).not.toMatch(/\n\s+at\s/);
  });

  // unknown command は Commander が処理する (exit 1 / "error: ..." to stderr)
  it('未知子命令 → exit 1, 无 stdout, 无堆栈', () => {
    const res = run(['no-such-subcommand-xyz']);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    // Commander 打 "error:" (英文) 而不是 "错误:" — 只检查 exit 1 + 无堆栈
    expect(`${res.stdout}${res.stderr}`).not.toMatch(/\n\s+at\s/);
  });
});

// ---------------------------------------------------------------------------
// 只读命令空 home 下 exit 0
// ---------------------------------------------------------------------------

describe('read-only commands exit 0 on empty home', () => {
  it('scan 空 home → exit 0', () => {
    const res = run(['scan', '--home', tmpHome()]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('drift 空 home → exit 0', () => {
    const res = run(['drift', '--home', tmpHome()]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('lock 空 home → exit 0', () => {
    const res = run(['lock', '--home', tmpHome()]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('stats 空 home → exit 0', () => {
    const res = run(['stats', '--home', tmpHome()]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('doctor 空 home(无 --ci) → exit 0', () => {
    const res = run(['doctor', '--home', tmpHome()]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('audit 空 home(--home 模式) → exit 0', () => {
    const res = run(['audit', '--home', tmpHome()]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('lock --verify 空 lock → exit 0(无条目即无不合格)', () => {
    const res = run(['lock', '--home', tmpHome(), '--verify']);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });
});

// ---------------------------------------------------------------------------
// audit exit 1 契约:已在 audit-cli.test.ts 覆盖阻断性,这里补回路 exit 0
// ---------------------------------------------------------------------------

describe('audit exit 0 on clean --home', () => {
  it('benign home → exit 0', () => {
    const home = join(import.meta.dirname, 'fixtures', 'home-audit-benign');
    const res = run(['audit', '--home', home]);
    expect(res.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// install --agent 未知 → 错误: + exit 1(回归:已有测试,此处作契约强化)
// ---------------------------------------------------------------------------

describe('install unknown --agent regression', () => {
  it('未知 --agent 值 → 错误: + exit 1 + 无堆栈', () => {
    const home = tmpHome();
    const res = run(['install', '/some/source', '--agent', 'no-such-agent', '--home', home]);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^错误:/m);
    expect(res.stderr).toMatch(/agent/i);
    expect(`${res.stdout}${res.stderr}`).not.toMatch(/\n\s+at\s/);
  });
});

// ---------------------------------------------------------------------------
// lock --verify missing 条目 → exit 1
// (已在 lock.test.ts 覆盖 mismatch;这里补 missing 场景)
// ---------------------------------------------------------------------------

describe('lock --verify exit 1 contract', () => {
  it('lock 文件中有条目但磁盘目录被删除 → exit 1', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const home = tmpHome();
    // 手写一个最简 skills.lock.json,指向不存在的磁盘位置
    const lockDir = join(home, '.skill-switch');
    await mkdir(lockDir, { recursive: true });
    const lockContent = JSON.stringify({
      version: 1,
      skills: [
        {
          name: 'ghost-skill',
          agent: 'claude-code',
          source: '/nowhere',
          sourceType: 'local',
          sha256: 'abc123',
          mode: 'copy',
        },
      ],
    });
    await writeFile(join(lockDir, 'skills.lock.json'), `${lockContent}\n`);

    const res = run(['lock', '--home', home, '--verify']);
    expect(res.status).toBe(1);
  });
});
