// WAL kill 矩阵(toggle / remove / sync):真子进程在权威写边界 SIGKILL 自杀,
// 断言 ①确实留下撕裂中间态 ②恢复后四方逐字节回到操作前,或(commit 后)保持
// 操作后状态 ③端到端重跑收敛 + stderr 含「已自动恢复」
// ④进程内失败补偿成功后 journal 已被 clear。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, type Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { journalPath, readPendingJournal, recoverPendingJournal } from '../src/core/journal.ts';
import { getSkillsLockPath } from '../src/core/lock.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from '../src/core/paths.ts';
import { removeSkill } from '../src/core/remove.ts';
import {
  applySync,
  getSkillsJsonPath,
  type SkillsDeclarationFile,
} from '../src/core/sync.ts';
import { toggleSkill } from '../src/core/toggle.ts';
import { installFromSource } from '../src/core/install.ts';

const HELPER = join(import.meta.dirname, 'helpers', 'wal-crash-mutation.mjs');
// 铁律:临时文件只建当前目录(worktree)内,不越出。
const TMP_ROOT = join(import.meta.dirname, '..', '.tmp-wal-w2');

let home: string;
let sourceDir: string;

function skillsRoot(): string {
  const location = getAgentSkillsLocations().find((l) => l.agent === 'claude-code')!;
  return resolveGlobalSkillsDir(home, location);
}

interface WorldState {
  declaration: string | null;
  lockfile: string | null;
  diskFoo: string | null;
  storeFoo: string | null;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function captureWorld(): Promise<WorldState> {
  const store = (name: string) =>
    join(home, '.skill-switch', 'store', 'claude-code', name, 'SKILL.md');
  return {
    declaration: await readOrNull(getSkillsJsonPath(home)),
    lockfile: await readOrNull(getSkillsLockPath(home)),
    diskFoo: await readOrNull(join(skillsRoot(), 'foo', 'SKILL.md')),
    storeFoo: await readOrNull(store('foo')),
  };
}

/** 全树捕获(排除 backups/journal/operation.lock 与源目录)。 */
async function captureTree(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const skip = new Set(['backups', 'journal', 'operation.lock']);
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (rel === '' && entry.name === 'src') continue;
      if (rel === '.skill-switch' && skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out[relPath] = 'DIR';
        await walk(full, relPath);
      } else if (entry.isFile()) {
        out[relPath] = await readFile(full, 'utf8');
      } else {
        out[relPath] = `SPECIAL:${entry.isSymbolicLink() ? 'symlink' : 'other'}`;
      }
    }
  }
  await walk(home, '');
  return out;
}

function runMutation(
  operation: 'toggle' | 'remove' | 'sync',
  env: Record<string, string>,
  crashAfter?: string,
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [HELPER], {
    env: {
      ...process.env,
      WAL_HOME: home,
      WAL_OPERATION: operation,
      ...env,
      ...(crashAfter ? { WAL_CRASH_AFTER: crashAfter } : {}),
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function expectKilled(result: ReturnType<typeof spawnSync>): void {
  expect(result.signal).toBe('SIGKILL');
}

async function installFoo(): Promise<void> {
  sourceDir = join(home, 'src');
  await mkdir(join(sourceDir, 'foo'), { recursive: true });
  await writeFile(join(sourceDir, 'foo', 'SKILL.md'), '---\nname: foo\n---\nfoo body\n');
  const result = await installFromSource(sourceDir, {
    home,
    agent: 'claude-code',
    mode: 'copy',
  });
  expect(result.installed.map((i) => i.name)).toEqual(['foo']);
  expect(await readPendingJournal(home)).toBeUndefined();
}

beforeEach(async () => {
  mkdirSync(TMP_ROOT, { recursive: true });
  // 用时间戳+随机避免并行冲突;目录落在 worktree 内。
  home = join(TMP_ROOT, `h-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(home, '.skill-switch'), { recursive: true });
  await installFoo();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ---------- toggle ----------

describe('WAL toggle kill matrix', () => {
  it('crash mid-apply (after write-declaration): rolls back to pre-state', async () => {
    const pre = await captureWorld();
    expect(pre.diskFoo).toContain('foo body');
    expect(JSON.parse(pre.declaration!).skills[0].enabled).toBe(true);

    expectKilled(runMutation('toggle', { WAL_NAME: 'foo', WAL_ENABLED: 'false' }, 'write-declaration'));

    // 撕裂:声明已翻位,磁盘 skill 还在。
    const torn = await captureWorld();
    expect(JSON.parse(torn.declaration!).skills[0].enabled).toBe(false);
    expect(torn.diskFoo).toContain('foo body');
    expect((await readPendingJournal(home))?.phase).toBe('applying');

    expect(await recoverPendingJournal(home)).toBe('rolled-back');
    expect(await captureWorld()).toEqual(pre);
  });

  it('crash after commit: rolls forward, world keeps post-state', async () => {
    expectKilled(runMutation('toggle', { WAL_NAME: 'foo', WAL_ENABLED: 'false' }, 'commit'));

    const post = await captureWorld();
    expect(JSON.parse(post.declaration!).skills[0].enabled).toBe(false);
    expect(post.diskFoo).toBeNull();

    expect(await recoverPendingJournal(home)).toBe('completed-commit');
    expect(await captureWorld()).toEqual(post);
  });

  it('end to end: crashed toggle followed by re-run converges + auto-recover message', async () => {
    expectKilled(runMutation('toggle', { WAL_NAME: 'foo', WAL_ENABLED: 'false' }, 'write-declaration'));

    const rerun = runMutation('toggle', { WAL_NAME: 'foo', WAL_ENABLED: 'false' });
    expect(rerun.status).toBe(0);
    expect(rerun.stderr).toContain('已自动恢复');

    const world = await captureWorld();
    expect(JSON.parse(world.declaration!).skills[0].enabled).toBe(false);
    expect(world.diskFoo).toBeNull();
    // store 保留(toggle 不动 store)
    expect(world.storeFoo).toContain('foo body');
    expect(await readPendingJournal(home)).toBeUndefined();
  });

  it('in-process compensation success clears journal', async () => {
    await expect(
      toggleSkill(home, 'foo', false, {
        onStep: async (id) => {
          if (id === 'apply-sync') throw new Error('injected toggle failure');
        },
      }),
    ).rejects.toThrow(/injected toggle failure/);

    // 补偿成功 → journal 已 clear,世界回到 toggle 前。
    expect(await readPendingJournal(home)).toBeUndefined();
    const world = await captureWorld();
    expect(JSON.parse(world.declaration!).skills[0].enabled).toBe(true);
    expect(world.diskFoo).toContain('foo body');
  });
});

// ---------- remove ----------

describe('WAL remove kill matrix', () => {
  it('crash mid-apply (after remove-target): rolls back to pre-state', async () => {
    const pre = await captureWorld();
    expect(pre.diskFoo).toContain('foo body');

    expectKilled(
      runMutation('remove', { WAL_NAME: 'foo', WAL_AGENT: 'claude-code' }, 'remove-target'),
    );

    // 撕裂:目标已删,声明/锁仍在。
    const torn = await captureWorld();
    expect(torn.diskFoo).toBeNull();
    expect(torn.declaration).toBe(pre.declaration);
    expect(torn.lockfile).toBe(pre.lockfile);
    expect((await readPendingJournal(home))?.phase).toBe('applying');

    expect(await recoverPendingJournal(home)).toBe('rolled-back');
    expect(await captureWorld()).toEqual(pre);
  });

  it('crash after commit: rolls forward, world keeps post-state', async () => {
    expectKilled(
      runMutation('remove', { WAL_NAME: 'foo', WAL_AGENT: 'claude-code' }, 'commit'),
    );

    const post = await captureWorld();
    expect(post.diskFoo).toBeNull();
    expect(post.declaration === null || !post.declaration.includes('foo')).toBe(true);
    // store 保留(remove 不清 store)
    expect(post.storeFoo).toContain('foo body');

    expect(await recoverPendingJournal(home)).toBe('completed-commit');
    expect(await captureWorld()).toEqual(post);
  });

  it('end to end: crashed remove followed by re-run converges + auto-recover message', async () => {
    expectKilled(
      runMutation('remove', { WAL_NAME: 'foo', WAL_AGENT: 'claude-code' }, 'write-lock'),
    );

    const rerun = runMutation('remove', { WAL_NAME: 'foo', WAL_AGENT: 'claude-code' });
    expect(rerun.status).toBe(0);
    expect(rerun.stderr).toContain('已自动恢复');

    const world = await captureWorld();
    expect(world.diskFoo).toBeNull();
    expect(world.storeFoo).toContain('foo body');
    expect(await readPendingJournal(home)).toBeUndefined();
  });

  it('in-process compensation success clears journal', async () => {
    await expect(
      removeSkill(home, 'foo', 'claude-code', {
        onStep: async (id) => {
          if (id === 'write-lock') throw new Error('injected remove failure');
        },
      }),
    ).rejects.toThrow(/injected remove failure/);

    expect(await readPendingJournal(home)).toBeUndefined();
    const world = await captureWorld();
    expect(world.diskFoo).toContain('foo body');
    expect(world.declaration).toContain('foo');
  });
});

// ---------- sync ----------

describe('WAL sync kill matrix', () => {
  /** 把声明改成 disabled 写盘,作为 applySync 的输入(不在 sync 事务内)。 */
  async function writeDisabledDeclaration(): Promise<void> {
    const path = getSkillsJsonPath(home);
    const raw = await readFile(path, 'utf8');
    const decl = JSON.parse(raw) as SkillsDeclarationFile;
    decl.skills = decl.skills.map((s) =>
      s.name === 'foo' ? { ...s, enabled: false } : s,
    );
    await writeFile(path, `${JSON.stringify(decl, null, 2)}\n`);
  }

  it('crash mid-apply (after apply-sync step boundary via applying then kill): rolls back', async () => {
    await writeDisabledDeclaration();
    const pre = await captureWorld();
    expect(JSON.parse(pre.declaration!).skills[0].enabled).toBe(false);
    expect(pre.diskFoo).toContain('foo body');

    // apply-sync 是单步写;崩在 applying 后、apply 完成前难精确卡,改用 apply-sync 步后
    // (写已完成但未 commit)验证回滚——此时 phase=applying,恢复 rolled-back。
    // 更贴近"中段":崩在 apply-sync 后尚未 commit。
    expectKilled(runMutation('sync', {}, 'apply-sync'));

    const torn = await captureWorld();
    // apply-sync 完成后磁盘应已按 disabled 移除
    expect(torn.diskFoo).toBeNull();
    expect((await readPendingJournal(home))?.phase).toBe('applying');

    expect(await recoverPendingJournal(home)).toBe('rolled-back');
    // 回滚:声明仍是 disabled(pre 已写),磁盘 skill 铺回
    expect(await captureWorld()).toEqual(pre);
  });

  it('crash after commit: rolls forward, world keeps post-state', async () => {
    await writeDisabledDeclaration();
    expectKilled(runMutation('sync', {}, 'commit'));

    const post = await captureWorld();
    expect(JSON.parse(post.declaration!).skills[0].enabled).toBe(false);
    expect(post.diskFoo).toBeNull();

    expect(await recoverPendingJournal(home)).toBe('completed-commit');
    expect(await captureWorld()).toEqual(post);
  });

  it('end to end: crashed sync followed by re-run converges + auto-recover message', async () => {
    await writeDisabledDeclaration();
    const preTree = await captureTree();

    expectKilled(runMutation('sync', {}, 'apply-sync'));
    // 撕裂后重跑:锁内自动回滚到 pre,再 apply 收敛到 post
    const rerun = runMutation('sync', {});
    expect(rerun.status).toBe(0);
    expect(rerun.stderr).toContain('已自动恢复');

    const world = await captureWorld();
    expect(world.diskFoo).toBeNull();
    expect(JSON.parse(world.declaration!).skills[0].enabled).toBe(false);
    expect(await readPendingJournal(home)).toBeUndefined();

    // preTree 是 apply 前(声明已 disabled、磁盘仍有 skill);post 磁盘已无 skill。
    // 确认不是卡在 pre:
    expect(await captureTree()).not.toEqual(preTree);
  });

  it('in-process recovery success clears journal', async () => {
    await writeDisabledDeclaration();
    const pre = await captureWorld();

    const decl = JSON.parse(await readFile(getSkillsJsonPath(home), 'utf8')) as SkillsDeclarationFile;
    await expect(
      applySync(home, decl, {
        onStep: async (id) => {
          if (id === 'apply-sync') throw new Error('injected sync failure');
        },
      }),
    ).rejects.toThrow(/injected sync failure/);

    // install 风格就地 recoverPendingJournal → journal clear,世界回到 apply 前
    expect(await readPendingJournal(home)).toBeUndefined();
    expect(await captureWorld()).toEqual(pre);
  });
});

describe('WAL mutation helper sanity', () => {
  it('helper runs a normal toggle to completion when no crash step is set', async () => {
    const result = runMutation('toggle', { WAL_NAME: 'foo', WAL_ENABLED: 'false' });
    expect(result.status).toBe(0);
    const world = await captureWorld();
    expect(world.diskFoo).toBeNull();
    expect(JSON.parse(world.declaration!).skills[0].enabled).toBe(false);
  });

  it('journal exists after mid-crash for all three operations', async () => {
    expectKilled(runMutation('toggle', { WAL_NAME: 'foo', WAL_ENABLED: 'false' }, 'write-declaration'));
    expect(existsSync(journalPath(home))).toBe(true);
    await recoverPendingJournal(home);

    // re-install baseline for remove
    await installFromSource(sourceDir, { home, agent: 'claude-code', mode: 'copy' });
    expectKilled(runMutation('remove', { WAL_NAME: 'foo', WAL_AGENT: 'claude-code' }, 'remove-target'));
    expect(existsSync(journalPath(home))).toBe(true);
    await recoverPendingJournal(home);

    // sync 同样留下 journal(补全"三操作"覆盖)。注意:全 noop 的 sync 不开
    // journal(R26-a 语义),必须先制造真实 drift——删掉磁盘上的 skill 目录。
    await installFromSource(sourceDir, { home, agent: 'claude-code', mode: 'copy' });
    await rm(join(skillsRoot(), 'foo'), { recursive: true, force: true });
    expectKilled(runMutation('sync', {}, 'apply-sync'));
    expect(existsSync(journalPath(home))).toBe(true);
  });
});

describe('W2.5 hardening (Codex review follow-ups)', () => {
  it('commit-phase failure never rolls the world back (clear fails after markCommit)', async () => {
    await installFromSource(sourceDir, { home, agent: 'claude-code', mode: 'copy' });
    await expect(
      toggleSkill(home, 'foo', false, {
        onStep: async (id) => {
          if (id === 'commit') throw new Error('injected post-commit failure');
        },
      }),
    ).rejects.toThrow(/injected post-commit failure/);

    // markCommit 已落盘=已提交:世界保持 post-state(disabled),journal 已清,不回滚。
    const world = await captureWorld();
    expect(world.diskFoo).toBeNull();
    expect(JSON.parse(world.declaration!).skills[0].enabled).toBe(false);
    expect(await readPendingJournal(home)).toBeUndefined();
  });

  it('codex mutations capture config.toml in preState and keep WAL snapshots out of user backups', async () => {
    const { mkdir: mkdirP, writeFile: writeFileP, readdir: readdirP } = await import('node:fs/promises');
    // codex 基线:声明一个 codex skill(store 源),config.toml 打开
    await installFromSource(sourceDir, { home, agent: 'codex', mode: 'copy' });
    const configPath = join(home, '.codex', 'config.toml');
    await mkdirP(join(home, '.codex'), { recursive: true });
    const configBefore = await readFile(configPath, 'utf8').catch(() => null);

    let sawExtraFiles = false;
    let walSnapshotPaths: string[] = [];
    await toggleSkill(home, 'foo', false, {
      onStep: async (id) => {
        if (id === 'prepare') {
          const journal = await readPendingJournal(home);
          sawExtraFiles = (journal?.preState.extraFiles ?? []).some(
            (f) => f.id === 'codex-config',
          );
          walSnapshotPaths = (journal?.preState.snapshots ?? []).map((s) => s.path);
        }
      },
    });

    expect(sawExtraFiles).toBe(true);
    // codex skills 根的 WAL 单拍快照只进 journal 私有目录,绝不污染用户 backups;
    // 非 codex agent 的条目按设计复用 snapshotAgents 的用户快照(在 backups),不受此限。
    const codexSnaps = walSnapshotPaths.filter((path) => path.includes('codex-skills'));
    expect(codexSnaps.length).toBeGreaterThan(0);
    for (const path of codexSnaps) {
      expect(path).toContain(`${home}/.skill-switch/journal/snapshots`);
      expect(path).not.toContain(`${home}/.skill-switch/backups`);
    }
    // 正常完成后 journal 与私有快照均已清理。
    expect(await readPendingJournal(home)).toBeUndefined();
    const journalDir = await readdirP(join(home, '.skill-switch', 'journal')).catch(() => []);
    expect(journalDir).toEqual([]);
    void configBefore;
    void writeFileP;
  });

  it('CLI-facing applySync reads declaration in-lock and refuses on stale plan artifact', async () => {
    await installFromSource(sourceDir, { home, agent: 'claude-code', mode: 'copy' });
    // 无声明参数:锁内自读,返回 actions+snapshots(CLI sync real path)。
    const result = await applySync(home);
    expect(Array.isArray(result.actions)).toBe(true);
    expect(Array.isArray(result.snapshots)).toBe(true);
    expect(await readPendingJournal(home)).toBeUndefined();

    // 过期 artifact:声明 sha 不匹配 → 拒绝且零写入。
    const artifactPath = join(home, 'stale-plan.json');
    const { writeFile: writeFileP } = await import('node:fs/promises');
    await writeFileP(artifactPath, JSON.stringify({
      version: 1,
      declarationSha256: 'f'.repeat(64),
      createdAt: new Date().toISOString(),
      actions: [],
    }));
    const pre = await captureWorld();
    await expect(
      applySync(home, undefined, { verifyPlanArtifactPath: artifactPath }),
    ).rejects.toThrow();
    expect(await captureWorld()).toEqual(pre);
    expect(await readPendingJournal(home)).toBeUndefined();
  });
});
