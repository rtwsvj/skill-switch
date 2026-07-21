// W3:doctor 集成 WAL journal 检查项。
// 只读报告 pending/corrupt;--fix 恢复可恢复 journal;损坏绝不自动动文件。
// 既有测试文件零改动——本文件为新增。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/core/doctor.ts';
import {
  journalPath,
  type OperationJournal,
} from '../src/core/journal.ts';
import { getSkillsLockPath, upsertLockEntries } from '../src/core/lock.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from '../src/core/paths.ts';
import { writeJsonState } from '../src/core/state-io.ts';
import { applySync, getSkillsJsonPath, type SkillsDeclarationFile } from '../src/core/sync.ts';
import { computeSkillFolderHash } from '../src/vendor/vercel-skills/local-lock.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

let home: string;

function baseJournal(overrides: Partial<OperationJournal> = {}): OperationJournal {
  return {
    version: 2,
    operation: 'install:claude-code',
    nonce: 'test-nonce',
    startedAt: new Date().toISOString(),
    phase: 'applying',
    preState: {
      declaration: { content: null },
      lockfile: { content: null },
      snapshots: [],
      targets: [],
      storeTargets: [],
    },
    steps: [],
    ...overrides,
  };
}

async function writeRawJournal(value: unknown): Promise<void> {
  await writeJsonState(journalPath(home), value);
}

function skillsRoot(): string {
  const location = getAgentSkillsLocations().find((l) => l.agent === 'claude-code')!;
  return resolveGlobalSkillsDir(home, location);
}

/** 三方一致的对齐 home(无漂移)。 */
async function alignedHome(): Promise<void> {
  const src = join(home, '.skill-switch', 'store', 'beta');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'SKILL.md'), '---\nname: beta\ndescription: d.\n---\nB.\n');
  const decl: SkillsDeclarationFile = {
    version: 1,
    skills: [{ name: 'beta', source: src, agents: ['claude-code'], enabled: true, mode: 'copy' }],
  };
  await mkdir(join(home, '.skill-switch'), { recursive: true });
  await writeFile(getSkillsJsonPath(home), `${JSON.stringify(decl, null, 2)}\n`);
  await applySync(home, decl);
  await upsertLockEntries(getSkillsLockPath(home), [
    {
      name: 'beta', agent: 'claude-code', source: src, sourceType: 'local',
      sha256: await computeSkillFolderHash(join(home, '.claude', 'skills', 'beta')), mode: 'copy',
    },
  ]);
}

function runDoctorCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', CLI, 'doctor', '--home', home, ...args],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? -1 };
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-doc-journal-'));
});

afterEach(async () => {
  // tmp 目录由 OS 回收;无需强制 rm(并行测试更稳)
});

// ─── core:runDoctor journal 字段 ─────────────────────────────────────────────

describe('runDoctor journal 检查项', () => {
  it('无 journal → status=ok,clean 不受影响', async () => {
    await alignedHome();
    const report = await runDoctor(home);
    expect(report.clean).toBe(true);
    expect(report.journal.status).toBe('ok');
    expect(report.journal.detail).toContain('无待恢复');
  });

  it('applying journal → status=pending,文案含「被中断」', async () => {
    await alignedHome();
    await writeRawJournal(baseJournal({ phase: 'applying', operation: 'toggle:beta' }));
    const report = await runDoctor(home);
    expect(report.journal.status).toBe('pending');
    expect(report.journal.operation).toBe('toggle:beta');
    expect(report.journal.phase).toBe('applying');
    expect(report.journal.detail).toContain('被中断');
    expect(report.journal.detail).toContain('doctor --fix');
    // clean 只表三方一致,journal 不改 clean
    expect(report.clean).toBe(true);
    // 只读路径绝不删除 journal
    expect(existsSync(journalPath(home))).toBe(true);
  });

  it('损坏 journal(非 JSON)→ status=corrupt,文件不动', async () => {
    await alignedHome();
    await mkdir(join(home, '.skill-switch', 'journal'), { recursive: true });
    const path = journalPath(home);
    await writeFile(path, 'not json at all {{{');
    const before = await readFile(path, 'utf8');

    const report = await runDoctor(home);
    expect(report.journal.status).toBe('corrupt');
    expect(report.journal.detail).toMatch(/损坏|不认识/);
    expect(report.journal.path).toBe(path);
    // 只读:文件内容字节不变
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});

// ─── doctor --fix 恢复 ─────────────────────────────────────────────────────

describe('doctor --fix journal 恢复', () => {
  it('pending applying journal:--fix 后 journal 消失、状态回滚', async () => {
    await alignedHome();
    const declaration = getSkillsJsonPath(home);
    const lockfile = getSkillsLockPath(home);
    const preDecl = await readFile(declaration, 'utf8');
    const preLock = await readFile(lockfile, 'utf8');

    // 模拟 install 中途崩溃:磁盘已半写 skill,声明尚未改(仍合法);journal phase=applying
    const target = join(skillsRoot(), 'crashed-skill');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), 'half written\n');

    await writeRawJournal(baseJournal({
      operation: 'install:claude-code',
      phase: 'applying',
      preState: {
        declaration: { content: preDecl },
        lockfile: { content: preLock },
        snapshots: [],
        targets: [{ agent: 'claude-code', name: 'crashed-skill', existedBefore: false }],
        storeTargets: [],
      },
    }));

    // 只读先确认警告
    const before = await runDoctor(home);
    expect(before.clean).toBe(true);
    expect(before.journal.status).toBe('pending');
    expect(before.journal.detail).toContain('被中断');

    const { stdout, status } = runDoctorCli(['--fix']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/已恢复|写操作日志/);
    // journal 已清除
    expect(existsSync(journalPath(home))).toBe(false);
    // 声明保持事务前原文
    expect(await readFile(declaration, 'utf8')).toBe(preDecl);
    // 半写 target 删除
    expect(existsSync(target)).toBe(false);

    const after = await runDoctor(home);
    expect(after.journal.status).toBe('ok');
  });

  it('损坏 journal:--fix 拒绝恢复且不 crash,文件保留', async () => {
    await alignedHome();
    await mkdir(join(home, '.skill-switch', 'journal'), { recursive: true });
    const path = journalPath(home);
    await writeFile(path, 'CORRUPT{{{');
    const before = await readFile(path, 'utf8');

    const { stdout, status } = runDoctorCli(['--fix']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/损坏|写操作日志/);
    expect(existsSync(path)).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});

// ─── CLI --json 字段 ─────────────────────────────────────────────────────────

describe('doctor CLI --json journal 字段', () => {
  it('无 journal → journal.status=ok', async () => {
    await alignedHome();
    const { stdout, status } = runDoctorCli(['--json']);
    expect(status).toBe(0);
    const report = JSON.parse(stdout) as {
      clean: boolean;
      journal: { status: string; detail: string };
    };
    expect(report.clean).toBe(true);
    expect(report.journal.status).toBe('ok');
    expect(report.journal.detail).toContain('无待恢复');
  });

  it('pending journal → journal.status=pending + operation', async () => {
    await alignedHome();
    await writeRawJournal(baseJournal({ operation: 'remove:claude-code:beta' }));
    const { stdout, status } = runDoctorCli(['--json']);
    expect(status).toBe(0);
    const report = JSON.parse(stdout) as {
      journal: { status: string; operation?: string; detail: string; phase?: string };
    };
    expect(report.journal.status).toBe('pending');
    expect(report.journal.operation).toBe('remove:claude-code:beta');
    expect(report.journal.detail).toContain('被中断');
  });

  it('损坏 journal → journal.status=corrupt', async () => {
    await alignedHome();
    await mkdir(join(home, '.skill-switch', 'journal'), { recursive: true });
    await writeFile(journalPath(home), 'not-json');
    const { stdout, status } = runDoctorCli(['--json']);
    expect(status).toBe(0);
    const report = JSON.parse(stdout) as {
      journal: { status: string; path?: string; detail: string };
    };
    expect(report.journal.status).toBe('corrupt');
    expect(report.journal.path).toBe(journalPath(home));
  });
});
