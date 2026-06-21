// W7-a watch 命令测试 — 只用 --once 保证确定性;不测真实 fs.watch 事件流。
// 三组覆盖:1) 已声明 skill 不被标为 unmanaged;2) 未声明 skill 被标为 unmanaged;
//           3) --json 输出结构校验;4) --home 隔离(操作 temp 目录,不碰真实配置)。
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { getSkillsJsonPath, type SkillsDeclarationFile } from '../src/core/sync.ts';
import { runWatchScan } from '../src/core/watch.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-watch-'));
});

/** 在 home 下创建一个真实的 skill 目录(含 SKILL.md)。 */
async function makeSkillOnDisk(
  relSkillsDir: string,
  dirName: string,
  skillName?: string,
): Promise<void> {
  const skillDir = join(home, relSkillsDir, dirName);
  await mkdir(skillDir, { recursive: true });
  const name = skillName ?? dirName;
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Test skill ${name}.\n---\nBody.\n`,
  );
}

/** 写 skills.json 声明。 */
async function writeDeclaration(decl: SkillsDeclarationFile): Promise<void> {
  await mkdir(join(home, '.skill-switch'), { recursive: true });
  await writeFile(getSkillsJsonPath(home), `${JSON.stringify(decl, null, 2)}\n`);
}

/** 以真实子进程运行 skill-switch watch --once。 */
function runCliOnce(extraArgs: string[] = []): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', CLI, 'watch', '--home', home, '--once', ...extraArgs],
      { cwd: ROOT, encoding: 'utf8' },
    );
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

// ---------------------------------------------------------------------------
// core unit tests (runWatchScan)
// ---------------------------------------------------------------------------

describe('core/runWatchScan', () => {
  it('已声明的 skill 状态为 managed', async () => {
    await makeSkillOnDisk('.claude/skills', 'my-skill');
    await writeDeclaration({
      version: 1,
      skills: [
        {
          name: 'my-skill',
          source: join(home, '.claude', 'skills', 'my-skill'),
          agents: ['claude-code'],
          enabled: true,
          mode: 'copy',
        },
      ],
    });

    const report = await runWatchScan(home);
    const entry = report.entries.find((e) => e.name === 'my-skill');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('managed');
    expect(report.unmanaged).toBe(0);
  });

  it('未声明但在磁盘上的 skill 状态为 unmanaged', async () => {
    await makeSkillOnDisk('.claude/skills', 'rogue-skill');
    // 空声明
    await writeDeclaration({ version: 1, skills: [] });

    const report = await runWatchScan(home);
    const entry = report.entries.find((e) => e.name === 'rogue-skill');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('unmanaged');
    expect(report.unmanaged).toBe(1);
    expect(report.total).toBe(1);
  });

  it('disabled 声明也算 managed(disabled 状态由 sync 管控,不代表绕过治理层)', async () => {
    await makeSkillOnDisk('.claude/skills', 'disabled-skill');
    await writeDeclaration({
      version: 1,
      skills: [
        {
          name: 'disabled-skill',
          source: join(home, '.claude', 'skills', 'disabled-skill'),
          agents: ['claude-code'],
          enabled: false,
          mode: 'copy',
        },
      ],
    });

    const report = await runWatchScan(home);
    const entry = report.entries.find((e) => e.name === 'disabled-skill');
    expect(entry?.status).toBe('managed');
    expect(report.unmanaged).toBe(0);
  });

  it('混合场景:managed + unmanaged 各计其数', async () => {
    await makeSkillOnDisk('.claude/skills', 'declared');
    await makeSkillOnDisk('.claude/skills', 'sneaky');
    await writeDeclaration({
      version: 1,
      skills: [
        {
          name: 'declared',
          source: join(home, '.claude', 'skills', 'declared'),
          agents: ['claude-code'],
          enabled: true,
          mode: 'copy',
        },
      ],
    });

    const report = await runWatchScan(home);
    expect(report.total).toBe(2);
    expect(report.unmanaged).toBe(1);
    const managed = report.entries.filter((e) => e.status === 'managed');
    const unmanaged = report.entries.filter((e) => e.status === 'unmanaged');
    expect(managed.map((e) => e.name)).toContain('declared');
    expect(unmanaged.map((e) => e.name)).toContain('sneaky');
  });

  it('没有任何 skill 时返回空报告', async () => {
    await writeDeclaration({ version: 1, skills: [] });

    const report = await runWatchScan(home);
    expect(report.total).toBe(0);
    expect(report.unmanaged).toBe(0);
    expect(report.entries).toEqual([]);
  });

  it('声明不存在时视为空声明(StateFileError 转为空)', async () => {
    // 没有 .skill-switch/skills.json;readDeclaration → 默认空
    await makeSkillOnDisk('.claude/skills', 'orphan');

    const report = await runWatchScan(home);
    const entry = report.entries.find((e) => e.name === 'orphan');
    expect(entry?.status).toBe('unmanaged');
  });
});

// ---------------------------------------------------------------------------
// CLI integration tests (subprocess, --once)
// ---------------------------------------------------------------------------

describe('watch CLI --once', () => {
  it('已声明 skill:exit 0,输出显示已托管标签', async () => {
    await makeSkillOnDisk('.claude/skills', 'ok-skill');
    await writeDeclaration({
      version: 1,
      skills: [
        {
          name: 'ok-skill',
          source: join(home, '.claude', 'skills', 'ok-skill'),
          agents: ['claude-code'],
          enabled: true,
          mode: 'copy',
        },
      ],
    });

    const { stdout, status } = runCliOnce();
    expect(status).toBe(0);
    expect(stdout).toContain('已托管');
    expect(stdout).toContain('ok-skill');
  });

  it('未声明 skill:exit 0(纯报告),输出显示未托管标签', async () => {
    await makeSkillOnDisk('.claude/skills', 'bypass-skill');
    await writeDeclaration({ version: 1, skills: [] });

    const { stdout, status } = runCliOnce();
    expect(status).toBe(0);
    expect(stdout).toContain('未托管');
    expect(stdout).toContain('bypass-skill');
  });

  it('--json 输出可解析,含必要字段', async () => {
    await makeSkillOnDisk('.claude/skills', 'alpha');
    await makeSkillOnDisk('.claude/skills', 'beta');
    await writeDeclaration({
      version: 1,
      skills: [
        {
          name: 'alpha',
          source: join(home, '.claude', 'skills', 'alpha'),
          agents: ['claude-code'],
          enabled: true,
          mode: 'copy',
        },
      ],
    });

    const { stdout, status } = runCliOnce(['--json']);
    expect(status).toBe(0);

    const parsed = JSON.parse(stdout) as {
      home: string;
      total: number;
      unmanaged: number;
      entries: Array<{ name: string; status: string }>;
      timestamp: string;
    };
    expect(parsed.home).toBe(home);
    expect(parsed.total).toBe(2);
    expect(parsed.unmanaged).toBe(1);
    expect(typeof parsed.timestamp).toBe('string');

    const alpha = parsed.entries.find((e) => e.name === 'alpha');
    const beta = parsed.entries.find((e) => e.name === 'beta');
    expect(alpha?.status).toBe('managed');
    expect(beta?.status).toBe('unmanaged');
  });

  it('--home 隔离:temp home 只看 temp 目录,不混入真实配置', async () => {
    // 空声明 + 无 skill:应该返回 total=0
    await writeDeclaration({ version: 1, skills: [] });

    const { stdout, status } = runCliOnce(['--json']);
    expect(status).toBe(0);

    const parsed = JSON.parse(stdout) as { home: string; total: number };
    expect(parsed.home).toBe(home);
    // 隔离的 temp home 里没有 skill
    expect(parsed.total).toBe(0);
  });
});
