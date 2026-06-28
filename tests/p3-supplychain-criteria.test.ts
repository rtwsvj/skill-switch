// P3-D4 供应链漂移:审批 criteria 分级 + 上游 commit 摘要 测试。
//
// 覆盖范围:
//   1. recordApproval 携带 criteria 字段写入
//   2. isApproved:无 requiredCriteria 时与旧版一致(任何审批通过)
//   3. isApproved:requiredCriteria=safe-to-deploy 时只认 safe-to-deploy 审批
//   4. isApproved:旧记录无 criteria 字段 + requiredCriteria=safe-to-deploy → false
//   5. buildUpstreamCommitSummary:用本地 file:// git fixture 验证摘要生成
//   6. buildUpstreamCommitSummary:commit 不存在时返回 undefined(不抛出)
//   7. drift CLI --criteria safe-to-deploy:只接受 safe-to-deploy 审批
//      (CLI 集成测试:直接写假 approval 文件,不依赖 git clone)
//
// 所有文件系统操作在 mkdtempSync 隔离目录下;git 测试用本地 bare repo(无网络)。

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// CLI 子进程冷启动约 9 秒(Node.js + ESM import);统一放宽超时。
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import type { DriftEntry } from '../src/core/drift.ts';
import {
  isApproved,
  loadApprovals,
  recordApproval,
} from '../src/core/drift-approvals.ts';
import { buildUpstreamCommitSummary } from '../src/core/diff-narrative.ts';

// ─── 常量 ─────────────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'skill-switch.mjs');

// ─── 辅助 ─────────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    stdio: 'pipe',
  });
}

function runDrift(
  extraArgs: string[],
  home: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(BIN, ['drift', '--home', home, ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env },
    encoding: 'utf8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

/** 构造假漂移条目 */
function fakeDriftEntry(overrides: Partial<DriftEntry> = {}): DriftEntry {
  return {
    name: 'my-skill',
    agent: 'claude-code',
    state: 'upstream-ahead',
    upstreamAhead: true,
    localModified: false,
    lockCommit: 'aaabbb',
    upstreamCommit: 'cccddd',
    detail: '上游 HEAD cccddd ≠ 锁定 aaabbb',
    ...overrides,
  };
}

// ─── 审批 criteria 分级 单元测试 ─────────────────────────────────────────────

describe('drift-approvals criteria 分级', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'criteria-test-'));
  });

  it('不带 criteria 的审批 + 不传 requiredCriteria → isApproved 返回 true(向后兼容)', async () => {
    const entry = fakeDriftEntry();
    await recordApproval(home, entry); // 无 criteria
    const store = await loadApprovals(home);
    expect(isApproved(store, entry)).toBe(true); // 不传 requiredCriteria
  });

  it('不带 criteria 的审批 + requiredCriteria=safe-to-run → isApproved 返回 true', async () => {
    const entry = fakeDriftEntry();
    await recordApproval(home, entry); // 无 criteria 字段
    const store = await loadApprovals(home);
    expect(isApproved(store, entry, 'safe-to-run')).toBe(true);
  });

  it('不带 criteria 的审批 + requiredCriteria=safe-to-deploy → isApproved 返回 false', async () => {
    const entry = fakeDriftEntry();
    await recordApproval(home, entry); // 旧记录,无 criteria
    const store = await loadApprovals(home);
    // 旧记录视为 safe-to-run,不满足 safe-to-deploy
    expect(isApproved(store, entry, 'safe-to-deploy')).toBe(false);
  });

  it('criteria=safe-to-run 的审批 + requiredCriteria=safe-to-deploy → false', async () => {
    const entry = fakeDriftEntry();
    await recordApproval(home, entry, undefined, 'safe-to-run');
    const store = await loadApprovals(home);
    expect(isApproved(store, entry, 'safe-to-deploy')).toBe(false);
  });

  it('criteria=safe-to-deploy 的审批 + requiredCriteria=safe-to-deploy → true', async () => {
    const entry = fakeDriftEntry();
    await recordApproval(home, entry, undefined, 'safe-to-deploy');
    const store = await loadApprovals(home);
    expect(isApproved(store, entry, 'safe-to-deploy')).toBe(true);
  });

  it('criteria=safe-to-deploy 的审批 + 不传 requiredCriteria → true(更高级别向下兼容)', async () => {
    const entry = fakeDriftEntry();
    await recordApproval(home, entry, undefined, 'safe-to-deploy');
    const store = await loadApprovals(home);
    expect(isApproved(store, entry)).toBe(true);
  });

  it('criteria 写入 JSON 文件后可读回', async () => {
    const entry = fakeDriftEntry();
    await recordApproval(home, entry, '部署前确认', 'safe-to-deploy');
    const store = await loadApprovals(home);
    const key = `claude-code::my-skill::upstream-ahead`;
    expect(store.approvals[key]?.criteria).toBe('safe-to-deploy');
    expect(store.approvals[key]?.note).toBe('部署前确认');
  });

  it('内容变化后 criteria 正确的审批也失效(哈希不匹配)', async () => {
    const entry = fakeDriftEntry();
    await recordApproval(home, entry, undefined, 'safe-to-deploy');
    const store = await loadApprovals(home);
    // 模拟上游再推一个 commit
    const evolved = fakeDriftEntry({ upstreamCommit: 'new999commit' });
    expect(isApproved(store, evolved, 'safe-to-deploy')).toBe(false);
  });
});

// ─── buildUpstreamCommitSummary 单元测试 ──────────────────────────────────────

describe('buildUpstreamCommitSummary — 上游 commit 摘要', () => {
  let work: string;
  let repoDir: string;
  let v1commit: string;
  let v2commit: string;
  let v3commit: string;

  beforeEach(async () => {
    work = mkdtempSync(join(tmpdir(), 'commit-summary-'));
    repoDir = join(work, 'repo');
    await mkdir(join(repoDir, 'src'), { recursive: true });
    execFileSync('git', ['init', '-q', repoDir]);

    await writeFile(join(repoDir, 'README.md'), 'v1\n');
    git(repoDir, 'add', '-A');
    git(repoDir, 'commit', '-qm', 'feat: initial v1');
    v1commit = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    await writeFile(join(repoDir, 'README.md'), 'v2\n');
    git(repoDir, 'add', '-A');
    git(repoDir, 'commit', '-qm', 'feat: add v2 feature');
    v2commit = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    await writeFile(join(repoDir, 'README.md'), 'v3\n');
    git(repoDir, 'add', '-A');
    git(repoDir, 'commit', '-qm', 'fix: bugfix in v3');
    v3commit = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  });

  it('v1..v3 → 摘要包含 2 个 commit 的描述', async () => {
    const summary = await buildUpstreamCommitSummary(repoDir, v1commit, v3commit);
    expect(summary).toBeDefined();
    expect(summary!).toContain('上游新增 2 个 commit');
    expect(summary!).toContain('add v2 feature');
    expect(summary!).toContain('bugfix in v3');
  });

  it('v1..v2 → 摘要包含 1 个 commit', async () => {
    const summary = await buildUpstreamCommitSummary(repoDir, v1commit, v2commit);
    expect(summary).toBeDefined();
    expect(summary!).toContain('上游新增 1 个 commit');
  });

  it('相同 commit → 返回 undefined(无新 commit)', async () => {
    const summary = await buildUpstreamCommitSummary(repoDir, v3commit, v3commit);
    expect(summary).toBeUndefined();
  });

  it('参数缺失(空字符串)→ 返回 undefined', async () => {
    expect(await buildUpstreamCommitSummary(repoDir, '', v3commit)).toBeUndefined();
    expect(await buildUpstreamCommitSummary(repoDir, v1commit, '')).toBeUndefined();
    expect(await buildUpstreamCommitSummary('', v1commit, v3commit)).toBeUndefined();
  });

  it('commit 不存在于本地仓库 → 返回 undefined(不抛出)', async () => {
    // 假的 commit SHA;git log 会报错 → 静默跳过
    const summary = await buildUpstreamCommitSummary(repoDir, 'deadbeef00000000', v3commit);
    expect(summary).toBeUndefined();
  });

  it('超出 maxLines 时摘要中含"还有 N 条"', async () => {
    // 只有 2 个 commit(v1..v3),maxLines=1 时应截断
    const summary = await buildUpstreamCommitSummary(repoDir, v1commit, v3commit, 1);
    expect(summary).toBeDefined();
    expect(summary!).toContain('还有 1 条');
  });
});

// ─── drift CLI --criteria 集成测试(不依赖 git clone) ────────────────────────
//
// 策略:手动搭建一个最小化的 home 目录结构,直接用 recordApproval 写入审批文件,
// 同时构造一个带漂移条目的 skills.lock.json(模拟 local-modified 漂移),
// 这样 checkDrift 可以检测到漂移而不需要通过 installFromSource/git clone。
// CLI 测试仅验证 --criteria 标志的退出码语义。

describe('drift CLI --criteria safe-to-deploy 集成测试', () => {
  // 直接导入 drift-approvals 的写函数(已在顶部导入)
  // 注:此测试绕过 installFromSource,手动构建最小化 home 目录。

  let home: string;
  // 一个一致的 fake DriftEntry,对应手动构造的 lock 条目
  // 注:CLI checkDrift 会读 lock 文件后 hash 本地内容,本地内容不存在 → local-modified
  // 所以 state=local-modified,要触发 --ci exit 1 需要 isApproved 返回 false。

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'criteria-cli-'));
    // 构造 .skill-switch 目录
    await mkdir(join(home, '.skill-switch'), { recursive: true });

    // 构造最小 skills.lock.json:一个 local 来源的 skill(没有 git 上游)
    // checkDrift 会检测本地安装产物缺失 → local-modified
    const lock = {
      version: 1,
      skills: [
        {
          name: 'crit-skill',
          agent: 'claude-code',
          source: '/fake/local/path',
          sourceType: 'local',
          sha256: 'fakehash1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          mode: 'copy',
        },
      ],
    };
    await writeFile(
      join(home, '.skill-switch', 'skills.lock.json'),
      JSON.stringify(lock, null, 2),
    );
    // 注意:不创建实际的 skill 目录 → checkDrift 会检测到"安装产物缺失" → local-modified
  });

  // 辅助:构造与 checkDrift 实际产生的漂移条目等价的 fake entry
  // (用于 recordApproval 写入审批,与 CLI 的 isApproved 查询匹配)
  // 实际 checkDrift 产生的 entry:
  //   state=local-modified, detail='安装产物缺失', lockCommit=undefined, upstreamCommit=undefined
  function criteriaFakeEntry(): DriftEntry {
    return {
      name: 'crit-skill',
      agent: 'claude-code',
      state: 'local-modified',
      upstreamAhead: false,
      localModified: true,
      lockCommit: undefined,
      upstreamCommit: undefined,
      lockSha256: 'fakehash1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      localSha256: undefined,
      detail: '安装产物缺失',
    };
  }

  it('无审批 + --ci → exit 1', () => {
    const r = runDrift(['--ci'], home);
    expect(r.status).toBe(1);
  });

  it('无 criteria 审批 + --ci(无 requiredCriteria)→ exit 0', async () => {
    await recordApproval(home, criteriaFakeEntry());
    const r = runDrift(['--ci'], home);
    expect(r.status).toBe(0);
  });

  it('无 criteria 审批 + --ci --criteria safe-to-deploy → exit 1', async () => {
    // 写入没有 criteria 字段的审批(旧记录)
    await recordApproval(home, criteriaFakeEntry());
    const r = runDrift(['--ci', '--criteria', 'safe-to-deploy'], home);
    expect(r.status).toBe(1);
  });

  it('safe-to-deploy 审批 + --ci --criteria safe-to-deploy → exit 0', async () => {
    await recordApproval(home, criteriaFakeEntry(), undefined, 'safe-to-deploy');
    const r = runDrift(['--ci', '--criteria', 'safe-to-deploy'], home);
    expect(r.status).toBe(0);
  });

  it('safe-to-deploy 审批 + --ci --criteria safe-to-run → exit 0', async () => {
    await recordApproval(home, criteriaFakeEntry(), undefined, 'safe-to-deploy');
    const r = runDrift(['--ci', '--criteria', 'safe-to-run'], home);
    expect(r.status).toBe(0);
  });

  it('safe-to-run 审批 + --ci --criteria safe-to-deploy → exit 1', async () => {
    await recordApproval(home, criteriaFakeEntry(), undefined, 'safe-to-run');
    const r = runDrift(['--ci', '--criteria', 'safe-to-deploy'], home);
    expect(r.status).toBe(1);
  });

  it('--criteria 非法值被忽略 → 与无 criteria 行为一致', async () => {
    await recordApproval(home, criteriaFakeEntry());
    // unknown 值被忽略 → requiredCriteria = undefined → 通过
    const r = runDrift(['--ci', '--criteria', 'unknown-level'], home);
    expect(r.status).toBe(0);
  });
});
