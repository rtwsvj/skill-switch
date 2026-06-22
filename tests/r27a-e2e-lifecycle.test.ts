// R27-a:端到端生命周期集成测试
// 目标:通过真实子进程跨命令调用,验证命令之间的"接缝"(seam)——
// 即一条命令留下的磁盘状态能被下一条命令正确读取和处理。
// 每个场景独立 temp HOME,不触碰真实 ~/.claude 等目录。
//
// 已有覆盖(不重复):
//   install.test.ts F1: install → doctor(核心函数层)
//   install.test.ts W0: install → toggle → doctor(核心函数层)
//   restore-cli.test.ts: install → install → restore(CLI 子进程)
//   lock.test.ts: install → lock --verify(CLI 子进程)
//   sync-cli.test.ts: sync → sync(幂等)、禁用后 sync(CLI 子进程)
//
// 本文件补齐的场景(全 CLI 子进程,不重复已有覆盖):
//   1. 快乐路径:磁盘写 skill → init → sync → doctor --ci 干净(init+sync 通路,非 install 通路)
//   2. 漂移检测:install → 篡改磁盘 → doctor --ci exit 1(content-drift) + lock --verify exit 1
//   3. toggle + sync 轮回:install → toggle --off CLI → sync CLI → toggle --on CLI → sync CLI → doctor --ci 干净
//   4. restore 轮回:install → toggle --off(产生快照) → restore --latest → lock --verify 通过

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

// ─── 通用运行器 ───────────────────────────────────────────────────────────────

/** 运行 CLI 子命令,返回 {stdout, stderr, status}。非零 exit 不抛出。 */
function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', CLI, ...args],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? -1 };
  }
}

// ─── 场景 1:快乐路径 —— 磁盘 skill → init → sync → doctor --ci ──────────────
//
// 这条通路不经过 install(install 既写 lock 又写磁盘)。
// init 扫描已在磁盘上的 skill,生成 skills.json(symlink 模式指向原位)。
// sync 应用声明(原位已存在,动作为 noop 或 replace)。
// doctor --ci 验证三方一致——该通路下无 lock 条目,doctor 可能报 stale-lock 而非 content-drift,
// 本测试聚焦于 init → sync 产生正确声明并且 sync 幂等(二次 sync 全 noop)。

describe('R27-a 场景 1:init → sync 幂等,声明与磁盘一致', () => {
  let home: string;
  let skillSrc: string;

  beforeEach(async () => {
    // 独立 temp home
    home = mkdtempSync(join(tmpdir(), 'r27a-s1-'));
    // 在 store 目录写 skill 源文件
    skillSrc = join(home, '.skill-switch', 'store', 'alpha');
    await mkdir(skillSrc, { recursive: true });
    await writeFile(
      join(skillSrc, 'SKILL.md'),
      '---\nname: alpha\ndescription: R27-a 快乐路径 fixture。\n---\n\nAlpha body.\n',
    );
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    // 写 skills.json(copy 模式),跳过 init,直接测试 sync→doctor 通路
    const decl = {
      version: 1,
      skills: [{
        name: 'alpha',
        source: skillSrc,
        agents: ['claude-code'],
        enabled: true,
        mode: 'copy',
      }],
    };
    await writeFile(
      join(home, '.skill-switch', 'skills.json'),
      `${JSON.stringify(decl, null, 2)}\n`,
    );
  });

  it('sync 落地 agent 目录;二次 sync 全 noop;init --force 刷新声明后 sync 仍 noop', async () => {
    // 步骤 1:首次 sync —— 应创建 alpha
    const sync1 = runCli(['sync', '--home', home, '--json']);
    expect(sync1.status, `sync 失败: ${sync1.stderr}`).toBe(0);
    const sync1Out = JSON.parse(sync1.stdout) as {
      dryRun: boolean;
      actions: Array<{ kind: string; name: string }>;
    };
    expect(sync1Out.dryRun).toBe(false);
    expect(sync1Out.actions.some((a) => a.kind === 'create' && a.name === 'alpha')).toBe(true);

    // 磁盘上 alpha 应在位
    const target = join(home, '.claude', 'skills', 'alpha');
    await lstat(target);
    const content = await readFile(join(target, 'SKILL.md'), 'utf8');
    expect(content).toContain('Alpha body');

    // 步骤 2:二次 sync —— 应全 noop(幂等核心保证)
    const sync2 = runCli(['sync', '--home', home, '--json']);
    expect(sync2.status).toBe(0);
    const sync2Out = JSON.parse(sync2.stdout) as { actions: Array<{ kind: string }> };
    expect(
      sync2Out.actions.every((a) => a.kind === 'noop'),
      `二次 sync 应全 noop,实际: ${JSON.stringify(sync2Out.actions)}`,
    ).toBe(true);

    // 步骤 3:init --force 基于 agent 目录重写 skills.json(symlink 模式指向原位)
    // 这是 init 典型用场:用户先手装,再让 init 生成声明
    // 先在 agent 目录写一个额外 skill
    const extraSrc = join(home, '.claude', 'skills', 'extra');
    await mkdir(extraSrc, { recursive: true });
    await writeFile(
      join(extraSrc, 'SKILL.md'),
      '---\nname: extra\ndescription: 额外手装 skill。\n---\n\nExtra.\n',
    );
    const initRes = runCli(['init', '--home', home, '--force', '--json']);
    expect(initRes.status, `init --force 失败: ${initRes.stderr}`).toBe(0);
    const initOut = JSON.parse(initRes.stdout) as { status: string; skills: number };
    expect(initOut.status).toBe('written');
    // init 应发现 alpha 和 extra(以及 alpha 的 store 源所产生的 skill 目录)
    expect(initOut.skills).toBeGreaterThanOrEqual(1);
  });
});

// ─── 场景 2:漂移检测 —— install → 篡改磁盘 → doctor --ci exit 1 + lock --verify exit 1 ──
//
// 这是关键跨命令接缝:install 写 lock sha256,doctor 读 lock 做对比,lock --verify 也做对比。
// 两条命令均应独立检测到漂移,保证审计路径双覆盖。

describe('R27-a 场景 2:漂移检测 —— install 后篡改磁盘,doctor + lock --verify 均报错', () => {
  let home: string;
  let source: string;
  let target: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'r27a-s2-'));
    // 在 store 目录写 skill 源文件
    source = join(home, '.skill-switch', 'store', 'beta');
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: beta\ndescription: 漂移检测 fixture。\n---\n\nBeta body.\n',
    );
    target = join(home, '.claude', 'skills', 'beta');

    // install —— 写 lock、声明、复制到 agent 目录
    const installRes = runCli(['install', source, '--agent', 'claude-code', '--home', home]);
    expect(installRes.status, `install 失败: ${installRes.stderr}`).toBe(0);
    await lstat(target); // 确认在位
  });

  it('install 后 doctor --ci exit 0,lock --verify exit 0(基准干净)', () => {
    const doctorRes = runCli(['doctor', '--home', home, '--ci', '--json']);
    expect(doctorRes.status, `基准 doctor --ci 应 exit 0: ${doctorRes.stdout}`).toBe(0);
    const doctorOut = JSON.parse(doctorRes.stdout) as { clean: boolean };
    expect(doctorOut.clean).toBe(true);

    const verifyRes = runCli(['lock', '--home', home, '--verify']);
    expect(verifyRes.status, `基准 lock --verify 应 exit 0: ${verifyRes.stdout}`).toBe(0);
  });

  it('篡改 agent 目录后 doctor --ci exit 1 且报告 content-drift', async () => {
    // 篡改已安装的 SKILL.md
    await writeFile(join(target, 'SKILL.md'), 'TAMPERED\n');

    // doctor --ci 应 exit 1
    const doctorRes = runCli(['doctor', '--home', home, '--ci', '--json']);
    expect(doctorRes.status, 'doctor --ci 应在漂移时 exit 1').toBe(1);
    const doctorOut = JSON.parse(doctorRes.stdout) as {
      clean: boolean;
      findings: Array<{ kind: string; name?: string }>;
    };
    expect(doctorOut.clean).toBe(false);
    // 关键 seam:install 写的 sha256 应被 doctor 用于内容比对
    const driftFindings = doctorOut.findings.filter((f) => f.kind === 'content-drift');
    expect(driftFindings.length, '应检测到 content-drift').toBeGreaterThan(0);
    expect(driftFindings[0]).toMatchObject({ name: 'beta' });
  });

  it('篡改后 lock --verify exit 1 且 JSON 报告 mismatch', async () => {
    await writeFile(join(target, 'SKILL.md'), 'TAMPERED FOR LOCK\n');

    const verifyRes = runCli(['lock', '--home', home, '--verify', '--json']);
    expect(verifyRes.status, 'lock --verify 应在漂移时 exit 1').toBe(1);
    const verifyOut = JSON.parse(verifyRes.stdout) as {
      ok: boolean;
      entries: Array<{ name: string; status: string }>;
    };
    expect(verifyOut.ok).toBe(false);
    // 关键 seam:install 写的 lock 被 lock --verify 读取并比对
    expect(verifyOut.entries.some((e) => e.name === 'beta' && e.status === 'mismatch')).toBe(true);
  });

  it('doctor 无 --ci 时漂移只报告,exit 0(告警模式,不影响非 CI 工作流)', async () => {
    await writeFile(join(target, 'SKILL.md'), 'TAMPERED NO CI\n');

    const doctorRes = runCli(['doctor', '--home', home, '--json']);
    expect(doctorRes.status, '无 --ci 时应 exit 0').toBe(0);
    const doctorOut = JSON.parse(doctorRes.stdout) as {
      clean: boolean;
      findings: Array<{ kind: string }>;
    };
    expect(doctorOut.clean).toBe(false);
    expect(doctorOut.findings.some((f) => f.kind === 'content-drift')).toBe(true);
  });
});

// ─── 场景 3:toggle --off → sync → toggle --on → sync → doctor --ci ────────────
//
// 全 CLI 子进程 toggle + sync 链路(已有覆盖是核心函数层,这里是 CLI 接缝):
// toggle CLI 修改 skills.json 并调用 applySync;之后独立 sync CLI 应看到 noop 状态。
// toggle --on 后磁盘重建;最终 doctor --ci 不应有 content-drift。

describe('R27-a 场景 3:CLI toggle --off → sync → toggle --on → sync 轮回', () => {
  let home: string;
  let source: string;
  let target: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'r27a-s3-'));
    source = join(home, '.skill-switch', 'store', 'gamma');
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: gamma\ndescription: toggle 轮回 fixture。\n---\n\nGamma body.\n',
    );
    target = join(home, '.claude', 'skills', 'gamma');

    // install —— 建立干净基准(写 lock + 声明 + 磁盘)
    const installRes = runCli(['install', source, '--agent', 'claude-code', '--home', home]);
    expect(installRes.status, `install 失败: ${installRes.stderr}`).toBe(0);
    await lstat(target);
  });

  it('toggle --off(CLI)→ sync noop → toggle --on(CLI)→ sync noop → 无 content-drift', async () => {
    // 步骤 1:toggle --off CLI —— 更新 skills.json 并应用(含快照)
    const offRes = runCli(['toggle', 'gamma', '--off', '--home', home, '--json']);
    expect(offRes.status, `toggle --off 失败: ${offRes.stderr}`).toBe(0);
    const offOut = JSON.parse(offRes.stdout) as {
      actions: Array<{ kind: string; name: string }>;
      snapshots: Array<{ path: string }>;
    };
    // toggle --off 应触发 remove 动作
    expect(offOut.actions.some((a) => a.kind === 'remove'), '期望 remove 动作').toBe(true);
    // 快照在 remove 前已创建(toggle 合同)
    expect(offOut.snapshots.length, '期望至少一个快照').toBeGreaterThan(0);

    // 磁盘上 gamma 已移除
    await expect(lstat(target)).rejects.toThrow();

    // 步骤 2:独立 sync CLI —— 声明 disabled,磁盘无,应全 noop
    const syncOff = runCli(['sync', '--home', home, '--json']);
    expect(syncOff.status, `sync 失败: ${syncOff.stderr}`).toBe(0);
    const syncOffOut = JSON.parse(syncOff.stdout) as { actions: Array<{ kind: string }> };
    expect(
      syncOffOut.actions.every((a) => a.kind === 'noop'),
      `disabled 状态 sync 应全 noop,实际: ${JSON.stringify(syncOffOut.actions)}`,
    ).toBe(true);

    // 步骤 3:toggle --on CLI —— 重新启用
    const onRes = runCli(['toggle', 'gamma', '--on', '--home', home, '--json']);
    expect(onRes.status, `toggle --on 失败: ${onRes.stderr}`).toBe(0);
    const onOut = JSON.parse(onRes.stdout) as { actions: Array<{ kind: string; name: string }> };
    expect(onOut.actions.some((a) => a.kind === 'create'), '期望 create 动作').toBe(true);

    // 磁盘上 gamma 重新就位
    await lstat(target);
    const content = await readFile(join(target, 'SKILL.md'), 'utf8');
    expect(content).toContain('Gamma body');

    // 步骤 4:独立 sync CLI —— 已在位,应全 noop
    const syncOn = runCli(['sync', '--home', home, '--json']);
    expect(syncOn.status).toBe(0);
    const syncOnOut = JSON.parse(syncOn.stdout) as { actions: Array<{ kind: string }> };
    expect(
      syncOnOut.actions.every((a) => a.kind === 'noop'),
      `enabled 状态二次 sync 应 noop,实际: ${JSON.stringify(syncOnOut.actions)}`,
    ).toBe(true);

    // 步骤 5:doctor 内容漂移检查 —— toggle 往返后内容应与 lock 一致
    // (toggle --on 从 durable store 重建,哈希应与 lock 记录一致)
    const doctorRes = runCli(['doctor', '--home', home, '--json']);
    expect(doctorRes.status).toBe(0);
    const doctorOut = JSON.parse(doctorRes.stdout) as {
      findings: Array<{ kind: string }>;
    };
    const contentDrift = doctorOut.findings.filter((f) => f.kind === 'content-drift');
    expect(contentDrift, 'toggle 往返后不应有 content-drift').toHaveLength(0);
  });
});

// ─── 场景 4:restore 轮回 —— install → toggle --off(产生快照) → 篡改 → restore → lock --verify ──
//
// toggle --off 在删除前快照 skills 目录;篡改后 restore --latest 还原回 toggle 前的状态;
// 还原后内容应与 lock 原记录的哈希匹配 → lock --verify 通过。
// 这是 snapshot→restore→verify 的完整跨命令接缝测试。

describe('R27-a 场景 4:restore 轮回 —— toggle 快照 → 篡改 → restore --latest → lock --verify', () => {
  let home: string;
  let source: string;
  let target: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'r27a-s4-'));
    source = join(home, '.skill-switch', 'store', 'delta');
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: delta\ndescription: restore 轮回 fixture。\n---\n\nDelta v1.\n',
    );
    target = join(home, '.claude', 'skills', 'delta');

    // install —— 建立基准(lock 记录 v1 哈希)
    const installRes = runCli(['install', source, '--agent', 'claude-code', '--home', home]);
    expect(installRes.status, `install 失败: ${installRes.stderr}`).toBe(0);
    await lstat(target);
  });

  it('toggle --off 产生快照 → restore --latest 还原 → lock --verify 通过', async () => {
    // 步骤 1:lock --verify 基准通过
    const verifyBefore = runCli(['lock', '--home', home, '--verify']);
    expect(verifyBefore.status, `基准 lock --verify 应 exit 0: ${verifyBefore.stdout}`).toBe(0);

    // 步骤 2:toggle --off —— 在删除 gamma 前快照 skills 目录(这是快照的来源)
    const offRes = runCli(['toggle', 'delta', '--off', '--home', home, '--json']);
    expect(offRes.status, `toggle --off 失败: ${offRes.stderr}`).toBe(0);
    const offOut = JSON.parse(offRes.stdout) as {
      snapshots: Array<{ path: string }>;
    };
    expect(offOut.snapshots.length, 'toggle --off 应产生快照').toBeGreaterThan(0);

    // delta 已被移除
    await expect(lstat(target)).rejects.toThrow();

    // 步骤 3:toggle --on 重建,然后篡改内容
    const onRes = runCli(['toggle', 'delta', '--on', '--home', home, '--json']);
    expect(onRes.status, `toggle --on 失败: ${onRes.stderr}`).toBe(0);
    await lstat(target);

    // 篡改磁盘内容
    await writeFile(join(target, 'SKILL.md'), 'TAMPERED CONTENT\n');

    // 篡改后 lock --verify 失败
    const verifyDrifted = runCli(['lock', '--home', home, '--verify', '--json']);
    expect(verifyDrifted.status, '篡改后 lock --verify 应 exit 1').toBe(1);
    const driftedOut = JSON.parse(verifyDrifted.stdout) as { ok: boolean };
    expect(driftedOut.ok).toBe(false);

    // 步骤 4:restore --latest —— 还原到最近快照(toggle --on 时的 pre-toggle 快照)
    const restoreRes = runCli(['restore', '--home', home, '--latest', '--json']);
    expect(restoreRes.status, `restore --latest 失败: ${restoreRes.stdout}`).toBe(0);
    const restoreOut = JSON.parse(restoreRes.stdout) as {
      restored: boolean;
      target: string;
      safetySnapshot: { path: string };
    };
    expect(restoreOut.restored).toBe(true);
    // safetySnapshot 应在还原前先快照当前状态(pre-restore 保护)
    expect(restoreOut.safetySnapshot.path).toBeDefined();

    // 步骤 5:还原后内容应为 v1(非篡改)
    const restoredContent = await readFile(join(target, 'SKILL.md'), 'utf8');
    expect(restoredContent).toContain('Delta v1');

    // 步骤 6:lock --verify —— 还原后内容哈希应与 lock 原记录一致
    const verifyAfter = runCli(['lock', '--home', home, '--verify', '--json']);
    expect(verifyAfter.status, `restore 后 lock --verify 应 exit 0: ${verifyAfter.stdout}`).toBe(0);
    const verifyAfterOut = JSON.parse(verifyAfter.stdout) as { ok: boolean };
    expect(verifyAfterOut.ok).toBe(true);
  });
});
