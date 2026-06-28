// P3-D5 governance 功能集成测试:
//   1. sync plan --out / apply --plan(声明变更则拒绝)
//   2. doctor --fix(missing/content-drift/extra-locked 修复,content-drift 先快照)
//   3. restore prune --keep-last / --older-than / --dry-run
//   4. import --apply(import 后直接 applySync)
// 全程用临时 home,不碰真实 agent 配置目录。
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeSkillFolderHash } from '../src/vendor/vercel-skills/local-lock.ts';
import { listSnapshots, snapshot } from '../src/core/backup.ts';
import { runDoctor, fixFindings } from '../src/core/doctor.ts';
import {
  applySync,
  getSkillsJsonPath,
  planSync,
  readDeclaration,
  readAndVerifyPlanArtifact,
  sha256Hex,
  writePlanArtifact,
  type SkillsDeclarationFile,
} from '../src/core/sync.ts';
import { getSkillsLockPath, readSkillsLock, upsertLockEntries } from '../src/core/lock.ts';
import { selectSnapshotsToRemove } from '../src/cli/commands/restore.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

// ── 辅助 ──

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

function runCliOk(args: string[]): string {
  const r = runCli(args);
  if (r.status !== 0) throw new Error(`CLI 失败(exit ${r.status}): ${r.stderr}\n${r.stdout}`);
  return r.stdout;
}

const homes: string[] = [];
function tmpHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'ss-p3gov-'));
  homes.push(h);
  return h;
}

afterEach(async () => {
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});

async function makeSkillSource(storeDir: string, name: string, body = 'B.'): Promise<string> {
  const dir = join(storeDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d.\n---\n${body}\n`);
  return dir;
}

async function writeDecl(home: string, decl: SkillsDeclarationFile): Promise<void> {
  await mkdir(join(home, '.skill-switch'), { recursive: true });
  await writeFile(getSkillsJsonPath(home), `${JSON.stringify(decl, null, 2)}\n`);
}

// ─────────────────────────────────────────────
// 1. sync plan artifact
// ─────────────────────────────────────────────

describe('P3:sync plan artifact(plan/apply)', () => {
  let home: string;
  let store: string;
  let src: string;

  beforeEach(async () => {
    home = tmpHome();
    store = join(home, '.skill-switch', 'store');
    src = await makeSkillSource(store, 'alpha');
    await writeDecl(home, {
      version: 1,
      skills: [{ name: 'alpha', source: src, agents: ['claude-code'], enabled: true, mode: 'copy' }],
    });
  });

  it('writePlanArtifact 写出文件并含 declarationSha256', async () => {
    const declPath = getSkillsJsonPath(home);
    const declaration = await readDeclaration(declPath);
    const actions = await planSync(home, declaration);
    const outFile = join(home, 'plan.json');
    const artifact = await writePlanArtifact(outFile, declPath, actions);

    expect(artifact.version).toBe(1);
    expect(artifact.declarationSha256).toHaveLength(64); // sha256 hex
    expect(artifact.actions).toEqual(actions);

    const raw = await readFile(outFile, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.declarationSha256).toBe(artifact.declarationSha256);
  });

  it('readAndVerifyPlanArtifact 声明未改时正常返回', async () => {
    const declPath = getSkillsJsonPath(home);
    const declaration = await readDeclaration(declPath);
    const actions = await planSync(home, declaration);
    const outFile = join(home, 'plan.json');
    await writePlanArtifact(outFile, declPath, actions);

    const verified = await readAndVerifyPlanArtifact(outFile, declPath);
    expect(verified.actions).toEqual(actions);
  });

  it('readAndVerifyPlanArtifact 声明被改后抛错(拒绝 apply)', async () => {
    const declPath = getSkillsJsonPath(home);
    const declaration = await readDeclaration(declPath);
    const actions = await planSync(home, declaration);
    const outFile = join(home, 'plan.json');
    await writePlanArtifact(outFile, declPath, actions);

    // 修改声明文件
    const newDecl: SkillsDeclarationFile = {
      version: 1,
      skills: [{ name: 'alpha', source: src, agents: ['claude-code'], enabled: false, mode: 'copy' }],
    };
    await writeDecl(home, newDecl);

    await expect(readAndVerifyPlanArtifact(outFile, declPath)).rejects.toThrow('声明文件已被修改');
  });

  it('sha256Hex 对相同输入幂等', () => {
    const h1 = sha256Hex('hello world');
    const h2 = sha256Hex('hello world');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('CLI sync --out 写出 plan 文件', async () => {
    const outFile = join(home, 'my.plan');
    const stdout = runCliOk(['sync', '--home', home, '--out', outFile, '--json']);
    const parsed = JSON.parse(stdout) as { planFile: string; artifact: { version: number; actions: unknown[] } };
    expect(parsed.planFile).toBe(outFile);
    expect(parsed.artifact.version).toBe(1);

    const planRaw = await readFile(outFile, 'utf8');
    const plan = JSON.parse(planRaw);
    expect(plan.declarationSha256).toHaveLength(64);
  });

  it('CLI sync --plan 执行并落盘', async () => {
    const outFile = join(home, 'my.plan');
    runCliOk(['sync', '--home', home, '--out', outFile]);

    const target = join(home, '.claude', 'skills', 'alpha');
    // 目标尚不存在
    await expect(readFile(join(target, 'SKILL.md'), 'utf8')).rejects.toThrow();

    runCliOk(['sync', '--home', home, '--plan', outFile, '--json']);
    // 目标应已落盘
    const content = await readFile(join(target, 'SKILL.md'), 'utf8');
    expect(content).toContain('alpha');
  }, 30000);

  it('CLI sync --plan 声明改了则拒绝(exit 1)', async () => {
    const outFile = join(home, 'my.plan');
    runCliOk(['sync', '--home', home, '--out', outFile]);

    // 改声明
    await writeDecl(home, {
      version: 1,
      skills: [{ name: 'alpha', source: src, agents: ['claude-code'], enabled: false, mode: 'copy' }],
    });

    const r = runCli(['sync', '--home', home, '--plan', outFile]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('声明文件已被修改');
  }, 30000);

  it('现有 sync / sync --dry-run 行为不受影响', async () => {
    const r1 = runCli(['sync', '--home', home, '--dry-run', '--json']);
    expect(r1.status).toBe(0);
    const dry = JSON.parse(r1.stdout) as { dryRun: boolean; actions: unknown[] };
    expect(dry.dryRun).toBe(true);

    const r2 = runCliOk(['sync', '--home', home, '--json']);
    const applied = JSON.parse(r2) as { dryRun: boolean; actions: Array<{ kind: string }> };
    expect(applied.dryRun).toBe(false);
    expect(applied.actions.some((a) => a.kind === 'create')).toBe(true);
  }, 30000);
});

// ─────────────────────────────────────────────
// 2. doctor --fix
// ─────────────────────────────────────────────

describe('P3:doctor --fix 漂移自修复', () => {
  let home: string;
  let store: string;

  beforeEach(async () => {
    home = tmpHome();
    store = join(home, '.skill-switch', 'store');
  });

  it('content-drift:从 source 重铺,执行前先快照', async () => {
    const src = await makeSkillSource(store, 'beta');
    const decl: SkillsDeclarationFile = {
      version: 1,
      skills: [{ name: 'beta', source: src, agents: ['claude-code'], enabled: true, mode: 'copy' }],
    };
    await writeDecl(home, decl);
    await applySync(home, decl);
    const target = join(home, '.claude', 'skills', 'beta');
    const sha = await computeSkillFolderHash(target);

    // 写入锁(正确哈希)
    await upsertLockEntries(getSkillsLockPath(home), [{
      name: 'beta', agent: 'claude-code', source: src, sourceType: 'local', sha256: sha, mode: 'copy',
    }]);

    // 篡改磁盘内容
    await writeFile(join(target, 'SKILL.md'), 'TAMPERED\n');

    const report = await runDoctor(home);
    expect(report.findings.some((f) => f.kind === 'content-drift')).toBe(true);

    const declaration = await readDeclaration(getSkillsJsonPath(home));
    const fixReport = await fixFindings(home, report.findings, declaration);

    // 修复后:content 恢复
    const restored = await readFile(join(target, 'SKILL.md'), 'utf8');
    expect(restored).not.toContain('TAMPERED');
    expect(restored).toContain('beta');

    // 修复前已快照
    expect(fixReport.snapshotPaths.length).toBeGreaterThanOrEqual(1);
    expect(fixReport.fixes.some((f) => f.kind === 'content-drift' && f.status === 'fixed')).toBe(true);
  });

  it('extra-locked:清除孤儿锁条目', async () => {
    const src = await makeSkillSource(store, 'gamma');
    const decl: SkillsDeclarationFile = {
      version: 1,
      skills: [{ name: 'gamma', source: src, agents: ['claude-code'], enabled: true, mode: 'copy' }],
    };
    await writeDecl(home, decl);
    // 注入孤儿锁条目(delta 不在声明里)
    await upsertLockEntries(getSkillsLockPath(home), [
      { name: 'delta', agent: 'claude-code', source: '/gone', sourceType: 'local', sha256: 'deadbeef', mode: 'copy' },
    ]);
    await applySync(home, decl);
    const target = join(home, '.claude', 'skills', 'gamma');
    const sha = await computeSkillFolderHash(target);
    await upsertLockEntries(getSkillsLockPath(home), [{
      name: 'gamma', agent: 'claude-code', source: src, sourceType: 'local', sha256: sha, mode: 'copy',
    }]);

    const report = await runDoctor(home);
    expect(report.findings.some((f) => f.kind === 'extra-locked' && f.name === 'delta')).toBe(true);

    const declaration = await readDeclaration(getSkillsJsonPath(home));
    const fixReport = await fixFindings(home, report.findings, declaration);
    expect(fixReport.fixes.some((f) => f.kind === 'extra-locked' && f.status === 'fixed')).toBe(true);

    // 孤儿条目应已从锁文件中移除
    const lock = await readSkillsLock(getSkillsLockPath(home));
    expect(lock.skills.find((e) => e.name === 'delta')).toBeUndefined();
  });

  it('missing:只报告 manual,不写磁盘', async () => {
    const src = await makeSkillSource(store, 'alpha');
    const decl: SkillsDeclarationFile = {
      version: 1,
      skills: [{ name: 'alpha', source: src, agents: ['claude-code'], enabled: true, mode: 'copy' }],
    };
    await writeDecl(home, decl);
    // 不安装,直接 runDoctor → missing

    const report = await runDoctor(home);
    expect(report.findings.some((f) => f.kind === 'missing')).toBe(true);

    const declaration = await readDeclaration(getSkillsJsonPath(home));
    const fixReport = await fixFindings(home, report.findings, declaration);
    expect(fixReport.fixes.some((f) => f.kind === 'missing' && f.status === 'manual')).toBe(true);

    // target 磁盘上仍不存在
    const target = join(home, '.claude', 'skills', 'alpha');
    await expect(readFile(join(target, 'SKILL.md'), 'utf8')).rejects.toThrow();
  });

  it('CLI doctor --fix 修复 content-drift 并先快照', async () => {
    const src = await makeSkillSource(store, 'beta');
    const decl: SkillsDeclarationFile = {
      version: 1,
      skills: [{ name: 'beta', source: src, agents: ['claude-code'], enabled: true, mode: 'copy' }],
    };
    await writeDecl(home, decl);
    await applySync(home, decl);
    const target = join(home, '.claude', 'skills', 'beta');
    const sha = await computeSkillFolderHash(target);
    await upsertLockEntries(getSkillsLockPath(home), [{
      name: 'beta', agent: 'claude-code', source: src, sourceType: 'local', sha256: sha, mode: 'copy',
    }]);

    // 篡改
    await writeFile(join(target, 'SKILL.md'), 'TAMPERED\n');

    const r = runCli(['doctor', '--home', home, '--fix', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { findings: unknown[]; fix: { fixes: Array<{ status: string; kind: string }> } };
    expect(parsed.fix.fixes.some((f) => f.status === 'fixed' && f.kind === 'content-drift')).toBe(true);

    // 内容已恢复
    const content = await readFile(join(target, 'SKILL.md'), 'utf8');
    expect(content).not.toContain('TAMPERED');
  });

  it('CLI doctor --fix 不影响无漂移的 home(clean 路径不变)', async () => {
    const src = await makeSkillSource(store, 'beta');
    const decl: SkillsDeclarationFile = {
      version: 1,
      skills: [{ name: 'beta', source: src, agents: ['claude-code'], enabled: true, mode: 'copy' }],
    };
    await writeDecl(home, decl);
    await applySync(home, decl);
    const target = join(home, '.claude', 'skills', 'beta');
    const sha = await computeSkillFolderHash(target);
    await upsertLockEntries(getSkillsLockPath(home), [{
      name: 'beta', agent: 'claude-code', source: src, sourceType: 'local', sha256: sha, mode: 'copy',
    }]);

    const r = runCli(['doctor', '--home', home, '--fix']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('三方一致');
  });
});

// ─────────────────────────────────────────────
// 3. restore prune
// ─────────────────────────────────────────────

describe('P3:restore prune 快照生命周期', () => {
  let home: string;
  let store: string;
  let targetDir: string;

  beforeEach(async () => {
    home = tmpHome();
    store = join(home, '.skill-switch', 'backups');
    targetDir = join(home, '.claude', 'skills');
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'note.txt'), 'fixture\n');
  });

  /** 批量创建 n 个快照,返回 epochMs 最新在前的 SnapshotInfo[] */
  async function makeSnaps(n: number) {
    for (let i = 0; i < n; i++) {
      await snapshot(targetDir, { store, label: `snap-${i}` });
      // 稍等确保 epochMs 不同(毫秒级别)
      await new Promise((r) => setTimeout(r, 5));
    }
    return listSnapshots(store);
  }

  it('selectSnapshotsToRemove --keep-last:保留最近 N 个', async () => {
    const snaps = await makeSnaps(5);
    const toRemove = selectSnapshotsToRemove(snaps, 3, undefined);
    // 保留最近 3 个,删除最旧的 2 个
    expect(toRemove).toHaveLength(2);
    // 被删的都应是较旧的
    const keptTimes = snaps.slice(0, 3).map((s) => s.createdAt.getTime());
    for (const r of toRemove) {
      expect(keptTimes).not.toContain(r.createdAt.getTime());
    }
  });

  it('selectSnapshotsToRemove --older-than:只删超出时间的', () => {
    const now = Date.now();
    const snaps = [
      { path: '/a', label: 'a', createdAt: new Date(now - 10 * 86400_000) }, // 10天前
      { path: '/b', label: 'b', createdAt: new Date(now - 5 * 86400_000) },  // 5天前
      { path: '/c', label: 'c', createdAt: new Date(now - 1 * 86400_000) },  // 1天前
    ];
    const toRemove = selectSnapshotsToRemove(snaps, undefined, 7 * 86400_000); // 7天
    expect(toRemove).toHaveLength(1);
    expect(toRemove[0]!.path).toBe('/a');
  });

  it('selectSnapshotsToRemove 无选项返回空列表(防止误删全部)', () => {
    const snaps = [{ path: '/a', label: 'a', createdAt: new Date() }];
    expect(selectSnapshotsToRemove(snaps, undefined, undefined)).toEqual([]);
  });

  it('CLI restore prune --keep-last --dry-run 只列不删', async () => {
    await makeSnaps(4);
    // --json 必须放在 prune 子命令名称之前(restore 级别解析),以便从 parent opts 读取
    const r = runCli(['restore', '--json', 'prune', '--home', home, '--keep-last', '2', '--dry-run']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { dryRun: boolean; toRemove: unknown[] };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.toRemove).toHaveLength(2);
    // 快照数量不变(未删除)
    const after = await listSnapshots(store);
    expect(after).toHaveLength(4);
  });

  it('CLI restore prune --keep-last 2 真正删除', async () => {
    await makeSnaps(5);
    const r = runCli(['restore', '--json', 'prune', '--home', home, '--keep-last', '2']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { toRemove: unknown[] };
    expect(parsed.toRemove).toHaveLength(3);
    // 磁盘上只剩 2 个
    const after = await listSnapshots(store);
    expect(after).toHaveLength(2);
  });

  it('CLI restore prune 无选项 → exit 1 + 错误提示', () => {
    const r = runCli(['restore', 'prune', '--home', home]);
    expect(r.status).toBe(1);
    // 错误信息在 stderr(Commander 捕获后抛出的错误)
    expect(r.stderr + r.stdout).toContain('keep-last');
  });

  it('现有 restore list/restore --latest 行为不受影响', async () => {
    await snapshot(targetDir, { store, label: 'intact' });
    const r = runCli(['restore', '--home', home]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('intact');
  });
});

// ─────────────────────────────────────────────
// 4. import --apply
// ─────────────────────────────────────────────

describe('P3:import --apply 一条命令 bootstrap', () => {
  let home: string;
  let store: string;

  beforeEach(async () => {
    home = tmpHome();
    store = join(home, '.skill-switch', 'store');
  });

  it('import --apply 后 skill 落盘', async () => {
    const src = await makeSkillSource(store, 'omega');
    const bundle = {
      profile: 1,
      declaration: {
        version: 1,
        skills: [{ name: 'omega', source: src, agents: ['claude-code'], enabled: true, mode: 'copy' }],
      },
      lock: { version: 1, skills: [] },
    };
    const bundlePath = join(home, 'omega.ssp');
    await writeFile(bundlePath, JSON.stringify(bundle), 'utf8');

    // 强制用 --force 跳过已存在文件检测(新 home 其实不需要,保持测试风格一致)
    const stdout = runCliOk(['import', bundlePath, '--home', home, '--apply', '--force']);
    expect(stdout).toContain('import --apply 完成');

    // omega 应已落盘
    const content = await readFile(join(home, '.claude', 'skills', 'omega', 'SKILL.md'), 'utf8');
    expect(content).toContain('omega');
  });

  it('import --apply disabled skill 不落盘', async () => {
    const src = await makeSkillSource(store, 'omega');
    const bundle = {
      profile: 1,
      declaration: {
        version: 1,
        skills: [{ name: 'omega', source: src, agents: ['claude-code'], enabled: false, mode: 'copy' }],
      },
      lock: { version: 1, skills: [] },
    };
    const bundlePath = join(home, 'omega-disabled.ssp');
    await writeFile(bundlePath, JSON.stringify(bundle), 'utf8');

    runCliOk(['import', bundlePath, '--home', home, '--apply', '--force']);

    // disabled 的 skill 不应落盘
    await expect(readFile(join(home, '.claude', 'skills', 'omega', 'SKILL.md'), 'utf8')).rejects.toThrow();
  });

  it('import 不带 --apply 时不执行 sync(提示用户手动跑)', async () => {
    const src = await makeSkillSource(store, 'psi');
    const bundle = {
      profile: 1,
      declaration: {
        version: 1,
        skills: [{ name: 'psi', source: src, agents: ['claude-code'], enabled: true, mode: 'copy' }],
      },
      lock: { version: 1, skills: [] },
    };
    const bundlePath = join(home, 'psi.ssp');
    await writeFile(bundlePath, JSON.stringify(bundle), 'utf8');

    const stdout = runCliOk(['import', bundlePath, '--home', home]);
    expect(stdout).toContain('sync');          // 提示手动 sync
    expect(stdout).not.toContain('import --apply');

    // skill 未落盘
    await expect(readFile(join(home, '.claude', 'skills', 'psi', 'SKILL.md'), 'utf8')).rejects.toThrow();
  });
});
