// WAL kill 矩阵(install):真子进程在每个权威写边界 SIGKILL 自杀,
// 断言 ①确实留下撕裂中间态 ②恢复后四方(声明/锁/store/agent 磁盘)逐字节回到
// 操作前,或(commit 后)保持操作后状态 ③端到端重跑收敛到完整成功态。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, type Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { journalPath, readPendingJournal, recoverPendingJournal } from '../src/core/journal.ts';
import { getSkillsLockPath } from '../src/core/lock.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from '../src/core/paths.ts';
import { getSkillsJsonPath } from '../src/core/sync.ts';

const HELPER = join(import.meta.dirname, 'helpers', 'wal-crash-install.mjs');

let home: string;
let sourceV1: string;
let sourceV2: string;

function skillsRoot(): string {
  const location = getAgentSkillsLocations().find((l) => l.agent === 'claude-code')!;
  return resolveGlobalSkillsDir(home, location);
}

interface WorldState {
  declaration: string | null;
  lockfile: string | null;
  diskFoo: string | null;
  diskBar: string | null;
  storeFoo: string | null;
  storeBar: string | null;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** 四方状态一次性捕获,便于逐字节对比。 */
async function captureWorld(): Promise<WorldState> {
  const store = (name: string) =>
    join(home, '.skill-switch', 'store', 'claude-code', name, 'SKILL.md');
  return {
    declaration: await readOrNull(getSkillsJsonPath(home)),
    lockfile: await readOrNull(getSkillsLockPath(home)),
    diskFoo: await readOrNull(join(skillsRoot(), 'foo', 'SKILL.md')),
    diskBar: await readOrNull(join(skillsRoot(), 'bar', 'SKILL.md')),
    storeFoo: await readOrNull(store('foo')),
    storeBar: await readOrNull(store('bar')),
  };
}

/**
 * 全树捕获:home 下除 backups(pre-install 用户快照按设计保留)、journal(事务
 * 内部产物)与源目录外的完整目录树 {相对路径 → 内容或 'DIR'},用于逐字节级
 * 世界状态对比(Codex 核验要求:六个文件的抽样对比不足以证明"逐字节一致")。
 */
async function captureTree(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  // operation.lock 是瞬态协调产物:SIGKILL 后残留属正确行为(死进程锁由下一
  // 操作回收),不属于要对比的"世界状态"。
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
      if (rel === '' && (entry.name === 'src-v1' || entry.name === 'src-v2')) continue;
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

function runInstall(
  source: string,
  crashAfter?: string,
  agent = 'claude-code',
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [HELPER], {
    env: {
      ...process.env,
      WAL_HOME: home,
      WAL_SOURCE: source,
      WAL_AGENT: agent,
      ...(crashAfter ? { WAL_CRASH_AFTER: crashAfter } : {}),
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function expectKilled(result: ReturnType<typeof spawnSync>): void {
  expect(result.signal).toBe('SIGKILL');
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'wal-kill-'));
  mkdirSync(join(home, '.skill-switch'), { recursive: true });
  // v1 源:单 skill foo;v2 源:foo 内容更新 + 新增 bar(声明/锁/store/磁盘四方全变)。
  sourceV1 = join(home, 'src-v1');
  sourceV2 = join(home, 'src-v2');
  await mkdir(join(sourceV1, 'foo'), { recursive: true });
  await writeFile(join(sourceV1, 'foo', 'SKILL.md'), '---\nname: foo\n---\nv1 body\n');
  await mkdir(join(sourceV2, 'foo'), { recursive: true });
  await mkdir(join(sourceV2, 'bar'), { recursive: true });
  await writeFile(join(sourceV2, 'foo', 'SKILL.md'), '---\nname: foo\n---\nv2 body\n');
  await writeFile(join(sourceV2, 'bar', 'SKILL.md'), '---\nname: bar\n---\nbar body\n');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function installV1AndCapture(): Promise<WorldState> {
  const v1 = runInstall(sourceV1);
  expect(v1.status).toBe(0);
  expect(await readPendingJournal(home)).toBeUndefined();
  return captureWorld();
}

describe('WAL install kill matrix', () => {
  it('crash after prepare: journal cleared, world byte-identical to pre-state', async () => {
    const pre = await installV1AndCapture();
    expectKilled(runInstall(sourceV2, 'prepare'));
    expect(existsSync(journalPath(home))).toBe(true);
    expect(await recoverPendingJournal(home)).toBe('cleared-prepare');
    expect(await captureWorld()).toEqual(pre);
  });

  it('crash mid-apply (bar written first by sort order, foo untouched): rolls back to pre-state', async () => {
    const pre = await installV1AndCapture();
    const crashed = runInstall(sourceV2, 'disk-write:bar');
    expectKilled(crashed);

    // 撕裂中间态确凿:bar(字母序在前)磁盘已写、声明还是 v1。
    const torn = await captureWorld();
    expect(torn.diskBar).toContain('bar body');
    expect(torn.declaration).toBe(pre.declaration);
    expect((await readPendingJournal(home))?.phase).toBe('applying');

    expect(await recoverPendingJournal(home)).toBe('rolled-back');
    expect(await captureWorld()).toEqual(pre);
  });

  it('crash after write-lock (declaration not yet written): rolls back to pre-state', async () => {
    const pre = await installV1AndCapture();
    const crashed = runInstall(sourceV2, 'write-lock');
    expectKilled(crashed);

    const torn = await captureWorld();
    expect(torn.lockfile).not.toBe(pre.lockfile); // lock 已写 v2
    expect(torn.declaration).toBe(pre.declaration); // 声明仍 v1 → 确凿撕裂

    expect(await recoverPendingJournal(home)).toBe('rolled-back');
    expect(await captureWorld()).toEqual(pre);
  });

  it('crash after commit: rolls forward, world keeps post-state', async () => {
    await installV1AndCapture();
    const crashed = runInstall(sourceV2, 'commit');
    expectKilled(crashed);

    const post = await captureWorld();
    expect(post.diskFoo).toContain('v2 body');
    expect(post.diskBar).toContain('bar body');

    expect(await recoverPendingJournal(home)).toBe('completed-commit');
    expect(await captureWorld()).toEqual(post);
  });

  it('end to end: crashed install followed by a plain re-run converges to full v2', async () => {
    await installV1AndCapture();
    expectKilled(runInstall(sourceV2, 'write-lock'));

    // 直接重跑:锁内自动恢复(回滚到 v1)后本次安装继续,最终收敛 v2。
    const rerun = runInstall(sourceV2);
    expect(rerun.status).toBe(0);
    expect(rerun.stderr).toContain('已自动恢复');

    const world = await captureWorld();
    expect(world.diskFoo).toContain('v2 body');
    expect(world.diskBar).toContain('bar body');
    expect(world.storeBar).toContain('bar body');
    expect(world.declaration).toContain('bar');
    expect(world.lockfile).toContain('bar');
    expect(await readPendingJournal(home)).toBeUndefined();
  });

  it('full-tree byte comparison: mid-apply crash rollback restores the entire tree', async () => {
    const v1 = runInstall(sourceV1);
    expect(v1.status).toBe(0);
    const preTree = await captureTree();

    expectKilled(runInstall(sourceV2, 'write-declaration'));
    expect(await recoverPendingJournal(home)).toBe('rolled-back');
    expect(await captureTree()).toEqual(preTree);
  });

  it('codex agent: crash recovery works for the .codex/skills root', async () => {
    const v1 = runInstall(sourceV1, undefined, 'codex');
    expect(v1.status).toBe(0);
    const preTree = await captureTree();

    expectKilled(runInstall(sourceV2, 'write-lock', 'codex'));
    expect((await readPendingJournal(home))?.phase).toBe('applying');
    expect(await recoverPendingJournal(home)).toBe('rolled-back');
    expect(await captureTree()).toEqual(preTree);
  });

  it('interrupted rollback is idempotent: partial manual rollback then recover converges', async () => {
    const v1 = runInstall(sourceV1);
    expect(v1.status).toBe(0);
    const preTree = await captureTree();

    expectKilled(runInstall(sourceV2, 'write-lock'));
    // 模拟"回滚进行到一半再崩":先手工删掉一个 target(回滚的第一步动作),
    // journal 原样保留 → 再走完整恢复,结果必须仍与 pre 全树一致。
    await rm(join(skillsRoot(), 'bar'), { recursive: true, force: true });
    expect(await recoverPendingJournal(home)).toBe('rolled-back');
    expect(await captureTree()).toEqual(preTree);
  });

  it('fresh-home install crash rolls back to empty world', async () => {
    // 首次安装(无 v1 基线):崩溃后回滚 = 声明/锁/store/磁盘全部不存在。
    expectKilled(runInstall(sourceV2, 'disk-write:foo'));
    expect(await recoverPendingJournal(home)).toBe('rolled-back');
    const world = await captureWorld();
    expect(world).toEqual({
      declaration: null,
      lockfile: null,
      diskFoo: null,
      diskBar: null,
      storeFoo: null,
      storeBar: null,
    });
  });
});

describe('WAL helper sanity', () => {
  it('helper runs a normal install to completion when no crash step is set', async () => {
    const result = runInstall(sourceV1);
    expect(result.status).toBe(0);
    const world = await captureWorld();
    expect(world.diskFoo).toContain('v1 body');
  });
});
