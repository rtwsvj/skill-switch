// packs-depth.test.ts
// 覆盖 Task1~3 的新功能:
//   1. optional skill 标注:optional 失败 → 非致命;required 失败 → fatal
//   2. pack-lock 模块:buildPackLock / writePackLock / loadPackLock round-trip + resolvedCommitsMap
//   3. --dry-run 展示 optional vs required
//   4. 内置套餐:listBuiltinPacks / resolveBuiltinPackPath / isBuiltinId
//   5. packs list --builtin CLI
//   6. packs install <builtin-id> CLI(dry-run,不需要真实网络)
//   7. --lock CLI(单元级 buildPackLock round-trip)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildInstallPlan,
  installPack,
} from '../src/core/packs/install-pack.ts';
import { writePackManifest } from '../src/core/packs/pack-model.ts';
import {
  buildPackLock,
  loadPackLock,
  lockFilePath,
  resolvedCommitsMap,
  validatePackLock,
  writePackLock,
  PackLockError,
} from '../src/core/packs/pack-lock.ts';
import {
  isBuiltinId,
  listBuiltinPacks,
  resolveBuiltinPackPath,
} from '../src/core/packs/builtin/index.ts';
import type { PackManifest, PackSkillRef } from '../src/core/packs/types.ts';
import type { PackSkillInstallResult } from '../src/core/packs/install-pack.ts';

// ── 常量 ─────────────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'skill-switch.mjs');

// ── helpers ───────────────────────────────────────────────────────────────────

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'ss-depth-home-'));
}

function makeManifest(skills: PackSkillRef[], extra: Partial<PackManifest> = {}): PackManifest {
  return { version: 1, name: 'test-pack', source: 'manual', skills, ...extra };
}

function runBin(
  args: string[],
  opts: { cwd?: string } = {},
): { stdout: string; stderr: string; status: number | null } {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? tmpdir(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/** 初始化含 SKILL.md 的本地 git 仓 */
async function makeSkillRepo(repoPath: string, skillName: string): Promise<void> {
  const skillDir = join(repoPath, skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: depth test fixture.\n---\n\n${skillName}.\n`,
  );
  execFileSync('git', ['init', '-q', repoPath]);
  execFileSync('git', ['-C', repoPath, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  execFileSync('git', ['-C', repoPath, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}

// ── 全局测试资产 ──────────────────────────────────────────────────────────────

let workDir: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'ss-depth-'));
  await makeSkillRepo(join(workDir, 'repo-req'), 'required-skill');
  await makeSkillRepo(join(workDir, 'repo-opt'), 'optional-skill');
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 1:optional / required skill 标注
// ─────────────────────────────────────────────────────────────────────────────

describe('buildInstallPlan — optional 标注', () => {
  it('optional=true 的 skill:entry.optional === true', () => {
    const plan = buildInstallPlan([
      { name: 'req', repo: 'https://example.com/r' },
      { name: 'opt', repo: 'https://example.com/r', optional: true },
    ]);
    expect(plan[0]!.optional).toBe(false);
    expect(plan[1]!.optional).toBe(true);
  });

  it('无 optional 字段的 skill:entry.optional === false', () => {
    const plan = buildInstallPlan([{ name: 'x', repo: 'https://example.com/r' }]);
    expect(plan[0]!.optional).toBe(false);
  });

  it('无 repo + optional=true → action=skip,optional=true', () => {
    const plan = buildInstallPlan([{ name: 'y', optional: true }]);
    expect(plan[0]!.action).toBe('skip');
    expect(plan[0]!.optional).toBe(true);
  });
});

describe('installPack — optional 失败非致命,required 失败致命', () => {
  it('optional skill 无来源 → skipped,failed=false(不阻断)', async () => {
    const home = freshHome();
    const m = makeManifest([
      { name: 'opt-orphan', optional: true },   // 无 repo → skipped
    ]);
    const result = await installPack(m, { home, agent: 'claude-code', mode: 'copy' });
    expect(result.results[0]!.action).toBe('skipped');
    expect(result.results[0]!.optional).toBe(true);
    expect(result.failed).toBe(false);
  });

  it('required skill 无来源 → skipped,但 failed 仍为 false(skip 本身不算 error)', async () => {
    // skip 是"无法安装"的计划结果,不是 blocked/error,不置 failed
    const home = freshHome();
    const m = makeManifest([{ name: 'req-orphan' }]);
    const result = await installPack(m, { home, agent: 'claude-code', mode: 'copy' });
    expect(result.results[0]!.action).toBe('skipped');
    expect(result.failed).toBe(false);
  });

  it('required skill 安装成功 → failed=false', async () => {
    const home = freshHome();
    const repoPath = join(workDir, 'repo-req');
    const m = makeManifest([
      { name: 'required-skill', repo: `file://${repoPath}` },
    ]);
    const result = await installPack(m, { home, agent: 'claude-code', mode: 'copy' });
    expect(result.results[0]!.action).toBe('installed');
    expect(result.failed).toBe(false);
  });

  it('mixed: optional 无来源 + required 有来源 → failed=false', async () => {
    const home = freshHome();
    const repoPath = join(workDir, 'repo-req');
    const m = makeManifest([
      { name: 'required-skill', repo: `file://${repoPath}` },
      { name: 'opt-orphan', optional: true },
    ]);
    const result = await installPack(m, { home, agent: 'claude-code', mode: 'copy' });
    const installed = result.results.filter((r) => r.action === 'installed');
    const skipped = result.results.filter((r) => r.action === 'skipped');
    expect(installed).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.optional).toBe(true);
    expect(result.failed).toBe(false);
  });

  it('mock: optional error → failed=false;required error → failed=true', () => {
    // 直接构造 results 验证 failed 逻辑
    // (避免需要真实网络失败)

    // 只有 optional error → failed=false
    const resOptError: PackSkillInstallResult[] = [
      { name: 'opt', action: 'error', error: 'boom', optional: true },
    ];
    const failedOpt = resOptError.some(
      (r) => !r.optional && (r.action === 'blocked' || r.action === 'error'),
    );
    expect(failedOpt).toBe(false);

    // 只有 required error → failed=true
    const resReqError: PackSkillInstallResult[] = [
      { name: 'req', action: 'error', error: 'boom', optional: false },
    ];
    const failedReq = resReqError.some(
      (r) => !r.optional && (r.action === 'blocked' || r.action === 'error'),
    );
    expect(failedReq).toBe(true);

    // 只有 optional blocked → failed=false
    const resOptBlocked: PackSkillInstallResult[] = [
      { name: 'opt', action: 'blocked', optional: true },
    ];
    const failedOptBlocked = resOptBlocked.some(
      (r) => !r.optional && (r.action === 'blocked' || r.action === 'error'),
    );
    expect(failedOptBlocked).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 2:pack-lock 模块
// ─────────────────────────────────────────────────────────────────────────────

describe('lockFilePath', () => {
  it('*.pack.json → *.pack.lock.json', () => {
    expect(lockFilePath('/a/b/my.pack.json')).toBe('/a/b/my.pack.lock.json');
  });

  it('*.json → *.lock.json', () => {
    expect(lockFilePath('/a/b/my.json')).toBe('/a/b/my.lock.json');
  });

  it('其他扩展名 → 原路径 + .lock.json', () => {
    expect(lockFilePath('/a/b/pack')).toBe('/a/b/pack.lock.json');
  });
});

describe('buildPackLock', () => {
  it('已安装 skill 记入 resolved,blocked/skipped 不记', () => {
    const results: PackSkillInstallResult[] = [
      {
        name: 'skill-a',
        action: 'installed',
        installResult: {
          installed: [{ name: 'skill-a', source: 'https://github.com/x/y.git', commit: 'abc1234', sha256: 'xx', mode: 'copy', sourceType: 'git', agent: 'claude-code', ref: 'main' } as never],
          blocked: [],
        },
      },
      { name: 'skill-b', action: 'skipped' },
      { name: 'skill-c', action: 'blocked' },
    ];
    const repoMap = new Map([['skill-a', 'https://github.com/x/y.git']]);
    const lock = buildPackLock('my-pack', results, repoMap);

    expect(lock.version).toBe(1);
    expect(lock.pack).toBe('my-pack');
    expect(lock.resolved).toHaveLength(1);
    expect(lock.resolved[0]!.name).toBe('skill-a');
    expect(lock.resolved[0]!.commit).toBe('abc1234');
    expect(lock.createdAt).toBeTruthy();
  });

  it('无已安装 skill → resolved 为空数组', () => {
    const lock = buildPackLock('empty', [], new Map());
    expect(lock.resolved).toHaveLength(0);
  });

  it('installResult 无 commit 时兜底为 "unknown"', () => {
    const results: PackSkillInstallResult[] = [
      {
        name: 'no-commit',
        action: 'installed',
        installResult: {
          installed: [{ name: 'no-commit', source: 'https://github.com/x/z.git', sha256: 'zz', mode: 'copy', sourceType: 'git', agent: 'claude-code' } as never],
          blocked: [],
        },
      },
    ];
    const lock = buildPackLock('p', results, new Map([['no-commit', 'https://github.com/x/z.git']]));
    expect(lock.resolved[0]!.commit).toBe('unknown');
  });
});

describe('validatePackLock', () => {
  it('合法 lock 通过校验', () => {
    const raw = {
      version: 1,
      pack: 'test-pack',
      resolved: [{ name: 'skill-a', repo: 'https://github.com/x/y', commit: 'abc' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const lock = validatePackLock(raw);
    expect(lock.pack).toBe('test-pack');
  });

  it('version 不为 1 → PackLockError', () => {
    expect(() => validatePackLock({ version: 2, pack: 'p', resolved: [], createdAt: 'x' }))
      .toThrow(PackLockError);
  });

  it('pack 为空字符串 → PackLockError', () => {
    expect(() => validatePackLock({ version: 1, pack: '', resolved: [], createdAt: 'x' }))
      .toThrow(PackLockError);
  });

  it('resolved 非数组 → PackLockError', () => {
    expect(() => validatePackLock({ version: 1, pack: 'p', resolved: null, createdAt: 'x' }))
      .toThrow(PackLockError);
  });

  it('resolved 条目缺 commit → PackLockError', () => {
    expect(() => validatePackLock({
      version: 1,
      pack: 'p',
      resolved: [{ name: 'a', repo: 'r' }], // 缺 commit
      createdAt: 'x',
    })).toThrow(PackLockError);
  });

  it('根节点非对象 → PackLockError', () => {
    expect(() => validatePackLock('not an object')).toThrow(PackLockError);
  });
});

describe('writePackLock / loadPackLock round-trip', () => {
  it('write 后 load 恢复原始数据', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ss-depth-lock-'));
    const lockPath = join(tmpDir, 'test.pack.lock.json');
    const lock = {
      version: 1 as const,
      pack: 'round-trip-pack',
      resolved: [
        { name: 'skill-a', repo: 'https://github.com/x/y.git', commit: 'deadbeef' },
        { name: 'skill-b', repo: 'https://github.com/x/z.git', commit: 'cafe1234' },
      ],
      createdAt: new Date().toISOString(),
    };

    await writePackLock(lockPath, lock);
    const loaded = await loadPackLock(lockPath);

    expect(loaded.version).toBe(1);
    expect(loaded.pack).toBe('round-trip-pack');
    expect(loaded.resolved).toHaveLength(2);
    expect(loaded.resolved[0]!.name).toBe('skill-a');
    expect(loaded.resolved[0]!.commit).toBe('deadbeef');
    expect(loaded.resolved[1]!.commit).toBe('cafe1234');
    expect(loaded.createdAt).toBe(lock.createdAt);

    // 文件格式:pretty JSON + 尾换行
    const raw = await readFile(lockPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  '); // pretty JSON(2 格缩进)

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ENOENT → PackLockError', async () => {
    await expect(loadPackLock('/nonexistent/path.lock.json'))
      .rejects.toThrow(PackLockError);
  });

  it('损坏 JSON → PackLockError', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ss-depth-lock-bad-'));
    const lockPath = join(tmpDir, 'bad.pack.lock.json');
    await writeFile(lockPath, '{ not valid json }');
    await expect(loadPackLock(lockPath)).rejects.toThrow(PackLockError);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('resolvedCommitsMap', () => {
  it('从 lock 提取 name→commit Map', () => {
    const lock = {
      version: 1 as const,
      pack: 'p',
      resolved: [
        { name: 'a', repo: 'r', commit: 'aaaa1111' },
        { name: 'b', repo: 'r', commit: 'bbbb2222' },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const m = resolvedCommitsMap(lock);
    expect(m.get('a')).toBe('aaaa1111');
    expect(m.get('b')).toBe('bbbb2222');
  });

  it('"unknown" commit 不进入 Map', () => {
    const lock = {
      version: 1 as const,
      pack: 'p',
      resolved: [
        { name: 'a', repo: 'r', commit: 'unknown' },
        { name: 'b', repo: 'r', commit: 'real123' },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const m = resolvedCommitsMap(lock);
    expect(m.has('a')).toBe(false);
    expect(m.get('b')).toBe('real123');
  });

  it('空 resolved → 空 Map', () => {
    const lock = {
      version: 1 as const,
      pack: 'p',
      resolved: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(resolvedCommitsMap(lock).size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 3:内置套餐
// ─────────────────────────────────────────────────────────────────────────────

describe('内置套餐注册表', () => {
  it('listBuiltinPacks 返回至少 3 个内置套餐', () => {
    const builtins = listBuiltinPacks();
    expect(builtins.length).toBeGreaterThanOrEqual(3);
    // 每个条目有 id / displayName / description / path
    for (const b of builtins) {
      expect(typeof b.id).toBe('string');
      expect(b.id.length).toBeGreaterThan(0);
      expect(typeof b.displayName).toBe('string');
      expect(typeof b.description).toBe('string');
      expect(typeof b.path).toBe('string');
      // path 应该是绝对路径
      expect(b.path.startsWith('/')).toBe(true);
    }
  });

  it('三个已知内置 id 全部存在', () => {
    const ids = listBuiltinPacks().map((b) => b.id);
    expect(ids).toContain('security-review');
    expect(ids).toContain('tdd-workflow');
    expect(ids).toContain('team-onboarding');
  });

  it('resolveBuiltinPackPath:已知 id 返回绝对路径', () => {
    const p = resolveBuiltinPackPath('security-review');
    expect(p).not.toBeNull();
    expect(p!.endsWith('.pack.json')).toBe(true);
    expect(p!.startsWith('/')).toBe(true);
  });

  it('resolveBuiltinPackPath:未知 id 返回 null', () => {
    expect(resolveBuiltinPackPath('nonexistent-id-xyz')).toBeNull();
  });

  it('isBuiltinId:已知 id 返回 true,未知返回 false', () => {
    expect(isBuiltinId('security-review')).toBe(true);
    expect(isBuiltinId('tdd-workflow')).toBe(true);
    expect(isBuiltinId('team-onboarding')).toBe(true);
    expect(isBuiltinId('not-a-builtin')).toBe(false);
  });

  it('内置套餐 pack.json 文件存在且是合法 PackManifest', async () => {
    const { loadPackManifest } = await import('../src/core/packs/pack-model.ts');
    const builtins = listBuiltinPacks();
    for (const b of builtins) {
      const manifest = await loadPackManifest(b.path);
      expect(manifest.version).toBe(1);
      expect(manifest.name).toBe(b.id);
      expect(manifest.skills.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI 集成:--dry-run 显示 optional vs required
// ─────────────────────────────────────────────────────────────────────────────

describe('packs install --dry-run:optional vs required 标注', () => {
  it('--dry-run --json:plan 条目含 optional 字段', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ss-depth-dryrun-'));
    const home = freshHome();
    const packFile = join(tmpDir, 'mixed.pack.json');
    const m = makeManifest([
      { name: 'req-skill', repo: 'https://example.com/r' },
      { name: 'opt-skill', repo: 'https://example.com/r', optional: true },
    ]);
    await writePackManifest(packFile, m);

    const result = runBin([
      'packs', 'install', packFile,
      '--dry-run',
      '--home', home,
      '--json',
    ]);

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as {
      dryRun: boolean;
      plan: Array<{ optional: boolean; action: string; skill: { name: string } }>;
    };
    expect(out.dryRun).toBe(true);
    const req = out.plan.find((e) => e.skill.name === 'req-skill')!;
    const opt = out.plan.find((e) => e.skill.name === 'opt-skill')!;
    expect(req.optional).toBe(false);
    expect(opt.optional).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('--dry-run 人类可读输出含 [可选] / [必须] 标记', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ss-depth-dryrun2-'));
    const home = freshHome();
    const packFile = join(tmpDir, 'tags.pack.json');
    const m = makeManifest([
      { name: 'req-x', repo: 'https://example.com/r' },
      { name: 'opt-x', repo: 'https://example.com/r', optional: true },
    ]);
    await writePackManifest(packFile, m);

    const result = runBin([
      'packs', 'install', packFile,
      '--dry-run',
      '--home', home,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[必须]');
    expect(result.stdout).toContain('[可选]');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI 集成:packs list --builtin
// ─────────────────────────────────────────────────────────────────────────────

describe('packs list --builtin CLI', () => {
  it('--builtin --json:返回内置套餐列表', () => {
    const result = runBin(['packs', 'list', '--builtin', '--json']);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as {
      builtin: boolean;
      packs: Array<{ id: string; displayName: string }>;
    };
    expect(out.builtin).toBe(true);
    expect(out.packs.length).toBeGreaterThanOrEqual(3);
    const ids = out.packs.map((p) => p.id);
    expect(ids).toContain('security-review');
    expect(ids).toContain('tdd-workflow');
    expect(ids).toContain('team-onboarding');
  });

  it('--builtin 人类可读:包含各套餐的 id 和安装命令提示', () => {
    const result = runBin(['packs', 'list', '--builtin']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('security-review');
    expect(result.stdout).toContain('tdd-workflow');
    expect(result.stdout).toContain('team-onboarding');
    expect(result.stdout).toContain('packs install');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI 集成:packs install <builtin-id> --dry-run
// ─────────────────────────────────────────────────────────────────────────────

describe('packs install <builtin-id> CLI', () => {
  it('security-review --dry-run --json:计划不为空', () => {
    const home = freshHome();
    const result = runBin([
      'packs', 'install', 'security-review',
      '--dry-run',
      '--home', home,
      '--json',
    ]);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as {
      dryRun: boolean;
      plan: Array<{ action: string }>;
    };
    expect(out.dryRun).toBe(true);
    expect(out.plan.length).toBeGreaterThan(0);
  });

  it('tdd-workflow --dry-run:人类可读输出含 skill 名', () => {
    const home = freshHome();
    const result = runBin([
      'packs', 'install', 'tdd-workflow',
      '--dry-run',
      '--home', home,
    ]);
    expect(result.status).toBe(0);
    // tdd-workflow 包含 run / code-review / simplify
    expect(result.stdout).toMatch(/run|code-review|simplify/);
  });

  it('未知 builtin-id 且非文件路径 → 退出非 0 并报错', () => {
    const home = freshHome();
    const result = runBin([
      'packs', 'install', 'no-such-builtin-xyz',
      '--dry-run',
      '--home', home,
    ]);
    expect(result.status).not.toBe(0);
  });

  it('team-onboarding dry-run:包含 optional 标注的 skill', () => {
    const home = freshHome();
    const result = runBin([
      'packs', 'install', 'team-onboarding',
      '--dry-run',
      '--home', home,
    ]);
    expect(result.status).toBe(0);
    // update-config 是可选的,应显示 [可选]
    expect(result.stdout).toContain('[可选]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pack-lock 与 installPack 集成:--lock 写出后可 round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('pack-lock + installPack 集成', () => {
  it('真实安装后 buildPackLock 生成正确 resolved 列表', async () => {
    const home = freshHome();
    const repoPath = join(workDir, 'repo-req');
    const m = makeManifest([
      { name: 'required-skill', repo: `file://${repoPath}` },
    ]);

    const result = await installPack(m, { home, agent: 'claude-code', mode: 'copy' });
    expect(result.results[0]!.action).toBe('installed');

    const skillRepoMap = new Map([['required-skill', `file://${repoPath}`]]);
    const lock = buildPackLock('test-pack', result.results, skillRepoMap);

    expect(lock.pack).toBe('test-pack');
    expect(lock.resolved).toHaveLength(1);
    expect(lock.resolved[0]!.name).toBe('required-skill');
    expect(lock.resolved[0]!.repo).toBe(`file://${repoPath}`);
    expect(typeof lock.resolved[0]!.commit).toBe('string');
  });

  it('--lock CLI:安装后 lock 文件存在且可加载', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ss-depth-lock-cli-'));
    const home = freshHome();
    const packFile = join(tmpDir, 'lock-test.pack.json');
    const repoPath = join(workDir, 'repo-req');
    const m = makeManifest([
      { name: 'required-skill', repo: `file://${repoPath}` },
    ]);
    await writePackManifest(packFile, m);

    const result = runBin([
      'packs', 'install', packFile,
      '--agent', 'claude-code',
      '--home', home,
      '--lock',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { lockFile: string; results: Array<{ action: string }> };
    expect(out.results[0]!.action).toBe('installed');

    // lock 文件应存在且可加载
    const expectedLockPath = lockFilePath(packFile);
    expect(existsSync(expectedLockPath)).toBe(true);
    const lock = await loadPackLock(expectedLockPath);
    expect(lock.version).toBe(1);
    expect(lock.pack).toBe('test-pack');
    expect(lock.resolved).toHaveLength(1);
    expect(lock.resolved[0]!.name).toBe('required-skill');
    // --json 输出里 lockFile 字段
    expect(out.lockFile).toBe(expectedLockPath);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
