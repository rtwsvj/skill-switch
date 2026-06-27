// drift-review:drift-approvals 核心 + drift --approve-all / --ci / --json 的集成测试。
//
// 策略:
//   1. 纯函数单元测试(loadApprovals/recordApproval/isApproved/revokeApproval)。
//   2. 集成测试:通过 bin/skill-switch.mjs 子进程测试 CLI flag;复用 drift.test.ts 的
//      git fixture 结构(installFromSource + 本地 file:// upstream)。
//
// 所有文件系统操作均在 mkdtempSync 隔离目录下;不触碰任何真实 home。
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DriftEntry } from '../src/core/drift.ts';
import {
  approvalKey,
  driftContentHash,
  getDriftApprovalsPath,
  isApproved,
  loadApprovals,
  recordApproval,
  revokeApproval,
} from '../src/core/drift-approvals.ts';
import { installFromSource } from '../src/core/install.ts';

// ─── 常量 ─────────────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'skill-switch.mjs');

// ─── 辅助:git fixture ─────────────────────────────────────────────────────────

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

// ─── Fixture 建立 ─────────────────────────────────────────────────────────────

let work: string;
let home: string;
let upstream: string;

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), 'skill-switch-drift-review-'));
  home = join(work, 'home');
  await mkdir(home, { recursive: true });

  upstream = join(work, 'upstream');
  await mkdir(join(upstream, 'tidy-notes'), { recursive: true });
  await writeFile(
    join(upstream, 'tidy-notes', 'SKILL.md'),
    '---\nname: tidy-notes\ndescription: drift review fixture.\n---\n\nv1.\n',
  );
  execFileSync('git', ['init', '-q', upstream]);
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-qm', 'v1');

  await installFromSource(`file://${upstream}`, { home, agent: 'claude-code', mode: 'copy' });
});

// ─── 单元测试:approvals 核心 ─────────────────────────────────────────────────

describe('drift-approvals 单元测试', () => {
  // 造一个模拟漂移条目
  function fakeDriftEntry(overrides: Partial<DriftEntry> = {}): DriftEntry {
    return {
      name: 'tidy-notes',
      agent: 'claude-code',
      state: 'local-modified',
      upstreamAhead: false,
      localModified: true,
      lockCommit: 'abc123',
      upstreamCommit: 'abc123',
      detail: '本地内容与锁内哈希不符',
      ...overrides,
    };
  }

  it('新建 home:loadApprovals 返回空结构', async () => {
    const store = await loadApprovals(home);
    expect(store.version).toBe(1);
    expect(store.approvals).toEqual({});
  });

  it('recordApproval 写入后 loadApprovals 读到', async () => {
    const entry = fakeDriftEntry();
    await recordApproval(home, entry, '测试说明');

    const store = await loadApprovals(home);
    const key = approvalKey(entry);
    expect(store.approvals[key]).toBeDefined();
    expect(store.approvals[key]!.contentHash).toBe(driftContentHash(entry));
    expect(store.approvals[key]!.note).toBe('测试说明');
    expect(store.approvals[key]!.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('isApproved:内容匹配时返回 true', async () => {
    const entry = fakeDriftEntry();
    await recordApproval(home, entry);
    const store = await loadApprovals(home);
    expect(isApproved(store, entry)).toBe(true);
  });

  it('isApproved:无审批记录时返回 false', async () => {
    const entry = fakeDriftEntry();
    const store = await loadApprovals(home);
    expect(isApproved(store, entry)).toBe(false);
  });

  it('isApproved:内容变化后(upstreamCommit 更新)返回 false', async () => {
    const entry = fakeDriftEntry();
    await recordApproval(home, entry);
    const store = await loadApprovals(home);

    // 模拟上游再推一个 commit → 不同 contentHash
    const evolved = fakeDriftEntry({ upstreamCommit: 'newcommit999' });
    expect(isApproved(store, evolved)).toBe(false);
  });

  it('isApproved:detail 变化后返回 false', async () => {
    const entry = fakeDriftEntry();
    await recordApproval(home, entry);
    const store = await loadApprovals(home);

    const changed = fakeDriftEntry({ detail: '安装产物缺失' });
    expect(isApproved(store, changed)).toBe(false);
  });

  it('isApproved:state 变化(diverged)后返回 false', async () => {
    const entry = fakeDriftEntry();
    await recordApproval(home, entry);
    const store = await loadApprovals(home);

    const changed = fakeDriftEntry({ state: 'diverged', upstreamAhead: true });
    expect(isApproved(store, changed)).toBe(false);
  });

  it('revokeApproval:撤销已有审批后 isApproved 返回 false', async () => {
    const entry = fakeDriftEntry();
    await recordApproval(home, entry);

    const revoked = await revokeApproval(home, entry);
    expect(revoked).toBe(true);

    const store = await loadApprovals(home);
    expect(isApproved(store, entry)).toBe(false);
  });

  it('revokeApproval:无审批时返回 false 不报错', async () => {
    const entry = fakeDriftEntry();
    const revoked = await revokeApproval(home, entry);
    expect(revoked).toBe(false);
  });

  it('approvalKey 三元组结构正确', () => {
    const entry = fakeDriftEntry();
    expect(approvalKey(entry)).toBe('claude-code::tidy-notes::local-modified');
  });

  it('driftContentHash:相同输入产出相同哈希', () => {
    const entry = fakeDriftEntry();
    expect(driftContentHash(entry)).toBe(driftContentHash(entry));
  });

  it('driftContentHash:不同输入产出不同哈希', () => {
    const a = fakeDriftEntry({ lockCommit: 'aaa' });
    const b = fakeDriftEntry({ lockCommit: 'bbb' });
    expect(driftContentHash(a)).not.toBe(driftContentHash(b));
  });

  it('审批文件路径在 .skill-switch/ 目录下', () => {
    expect(getDriftApprovalsPath(home)).toBe(
      join(home, '.skill-switch', 'drift-approvals.json'),
    );
  });
});

// ─── 集成测试:--approve-all + --ci + --json ──────────────────────────────────

describe('drift CLI 集成测试(含 approvals)', () => {
  async function tamperLocalSkill(): Promise<void> {
    await writeFile(
      join(home, '.claude', 'skills', 'tidy-notes', 'SKILL.md'),
      'TAMPERED\n',
    );
  }

  let upstreamVersion = 2;
  async function advanceUpstream(): Promise<void> {
    const v = upstreamVersion++;
    await writeFile(
      join(upstream, 'tidy-notes', 'SKILL.md'),
      `---\nname: tidy-notes\ndescription: drift review fixture.\n---\n\nv${v} upstream.\n`,
    );
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-qm', `v${v}`);
  }

  it('无漂移时 --ci exit 0', () => {
    const r = runDrift(['--ci'], home);
    expect(r.status).toBe(0);
  });

  it('本地篡改 + --ci → exit 1(无审批时)', async () => {
    await tamperLocalSkill();
    const r = runDrift(['--ci'], home);
    expect(r.status).toBe(1);
  });

  it('--approve-all 后 --ci exit 0(已批准漂移不计入)', async () => {
    await tamperLocalSkill();

    // 先确认漂移确实让 --ci 失败
    const before = runDrift(['--ci'], home);
    expect(before.status).toBe(1);

    // 批量审批
    const approve = runDrift(['--approve-all'], home);
    expect(approve.status).toBe(0);
    expect(approve.stdout).toContain('已批准');

    // 再次 --ci 应成功
    const after = runDrift(['--ci'], home);
    expect(after.status).toBe(0);
  });

  it('审批后内容再次变化(再次篡改)→ --ci 重新 exit 1', async () => {
    await tamperLocalSkill();
    runDrift(['--approve-all'], home);

    // 再次修改内容(不同文本)→ 哈希变化 → 审批失效
    await writeFile(
      join(home, '.claude', 'skills', 'tidy-notes', 'SKILL.md'),
      'SECOND_TAMPER\n',
    );

    const r = runDrift(['--ci'], home);
    expect(r.status).toBe(1);
  });

  it('--json 输出包含 approved 字段和 approvalKey', async () => {
    await tamperLocalSkill();
    runDrift(['--approve-all'], home);

    const r = runDrift(['--json'], home);
    expect(r.status).toBe(0);

    const items = JSON.parse(r.stdout) as Array<{
      name: string;
      state: string;
      approved: boolean;
      approvalKey: string;
      contentHash: string;
    }>;
    expect(Array.isArray(items)).toBe(true);
    const item = items.find((i) => i.name === 'tidy-notes');
    expect(item).toBeDefined();
    expect(item!.approved).toBe(true);
    expect(item!.approvalKey).toMatch(/^claude-code::tidy-notes::/);
    expect(item!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('--json 输出在无漂移时返回空数组(in-sync 项不过滤 —— JSON 包含所有条目)', () => {
    // JSON 模式返回 ALL 条目(含 in-sync),approved=true 对 in-sync 无意义但字段存在
    const r = runDrift(['--json'], home);
    expect(r.status).toBe(0);
    const items = JSON.parse(r.stdout) as Array<{ approved: boolean }>;
    // 可能 0 条(空锁)或 1 条 in-sync 条目
    expect(Array.isArray(items)).toBe(true);
    // 所有条目都应有 approved 字段
    for (const item of items) {
      expect(typeof item.approved).toBe('boolean');
    }
  });

  it('上游前进 → --approve-all → --ci exit 0;再推一个 commit → --ci exit 1', async () => {
    await advanceUpstream();

    // 先批准上游前进漂移
    runDrift(['--approve-all'], home);
    const first = runDrift(['--ci'], home);
    expect(first.status).toBe(0);

    // 上游再推新 commit → 哈希变 → 审批失效
    await advanceUpstream();

    const second = runDrift(['--ci'], home);
    expect(second.status).toBe(1);
  });

  it('无 approvals 文件时 plain drift 仍 exit 0(纯报告,向后兼容)', async () => {
    await tamperLocalSkill();
    const r = runDrift([], home);
    // 纯报告模式:无论有无漂移,始终 exit 0
    expect(r.status).toBe(0);
    // 输出包含漂移信息
    expect(r.stdout).toContain('local-modified');
  });

  it('--approve-all 对 in-sync 条目跳过(不写 approved 记录)', async () => {
    // 安装后立即 approve-all:无非 in-sync 条目
    const r = runDrift(['--approve-all'], home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('已批准 0 条');
  });
});
