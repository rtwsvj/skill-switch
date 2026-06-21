// W2-a:init CLI 验收 — 草拟 skills.json、不覆盖、--force、--dry-run、--home 隔离。
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDraftDeclaration } from '../src/cli/commands/init.ts';
import { scanHome } from '../src/core/scan.ts';
import { getSkillsJsonPath } from '../src/core/sync.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');
const HOME_BASIC = join(import.meta.dirname, 'fixtures', 'home-basic');

/** 带状态码的子进程运行器(不会在非零 exit 时抛异常)。 */
function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'skill-switch-init-'));
}

// 临时 home,含一个合法 skill
let homeWithSkill: string;

beforeAll(async () => {
  homeWithSkill = freshHome();
  // 写一个最小 skill
  const skillDir = join(homeWithSkill, '.claude', 'skills', 'hello-init');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: hello-init\ndescription: fixture skill for init tests.\n---\n\nHello!\n',
  );
});

afterAll(() => {
  // 临时目录由 OS 自动回收,这里不强制删以免影响并行测试
});

// ---------------------------------------------------------------------------
// 单元:buildDraftDeclaration
// ---------------------------------------------------------------------------

describe('buildDraftDeclaration', () => {
  it('produces version:1 and skills array from scan records', async () => {
    const records = await scanHome(HOME_BASIC);
    const draft = buildDraftDeclaration(records);
    expect(draft.version).toBe(1);
    expect(Array.isArray(draft.skills)).toBe(true);
  });

  it('skips records that have a parse error', async () => {
    const records = await scanHome(HOME_BASIC);
    const draft = buildDraftDeclaration(records);
    // home-basic 的 broken-frontmatter 有 error,不应出现在声明里
    const names = draft.skills.map((s) => s.name);
    expect(names).not.toContain('broken-frontmatter');
  });

  it('every skill in the draft has enabled:true and mode:symlink', async () => {
    const records = await scanHome(HOME_BASIC);
    const draft = buildDraftDeclaration(records);
    for (const skill of draft.skills) {
      expect(skill.enabled).toBe(true);
      expect(skill.mode).toBe('symlink');
    }
  });

  it('skills are sorted alphabetically by name', async () => {
    const records = await scanHome(HOME_BASIC);
    const draft = buildDraftDeclaration(records);
    const names = draft.skills.map((s) => s.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('agents array is non-empty for every skill', async () => {
    const records = await scanHome(HOME_BASIC);
    const draft = buildDraftDeclaration(records);
    for (const skill of draft.skills) {
      expect(skill.agents.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// CLI:init 基础流程
// ---------------------------------------------------------------------------

describe('init CLI', () => {
  it('writes skills.json on a fresh home with installed skills', async () => {
    const home = freshHome();
    const skillDir = join(home, '.claude', 'skills', 'my-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: test\n---\n\nContent.\n',
    );

    const { status } = runCli(['init', '--home', home]);
    expect(status).toBe(0);

    const skillsJson = getSkillsJsonPath(home);
    const content = await readFile(skillsJson, 'utf8');
    const parsed = JSON.parse(content) as { version: number; skills: Array<{ name: string }> };
    expect(parsed.version).toBe(1);
    expect(parsed.skills.some((s) => s.name === 'my-skill')).toBe(true);
  });

  it('exit 0 even when no skills found (empty home)', () => {
    const home = freshHome();
    const { status, stdout } = runCli(['init', '--home', home]);
    expect(status).toBe(0);
    // 空家园写出 0 个 skill 的声明
    expect(stdout).toContain('0');
  });

  it('does NOT clobber an existing skills.json without --force', async () => {
    const home = freshHome();
    const skillsJson = getSkillsJsonPath(home);
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    const original = JSON.stringify({ version: 1, skills: [{ name: 'keep-me' }] });
    await writeFile(skillsJson, original);

    const { status, stdout } = runCli(['init', '--home', home]);
    expect(status).toBe(0);
    // 文件内容没变
    const after = await readFile(skillsJson, 'utf8');
    expect(JSON.parse(after)).toEqual(JSON.parse(original));
    // 打印了提示
    expect(stdout).toMatch(/已有|exists|跳过|skip/i);
  });

  it('--force overwrites an existing skills.json', async () => {
    const home = freshHome();
    const skillDir = join(home, '.claude', 'skills', 'force-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: force-skill\ndescription: force test\n---\n\nOK.\n',
    );

    const skillsJson = getSkillsJsonPath(home);
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(skillsJson, JSON.stringify({ version: 1, skills: [{ name: 'stale' }] }));

    const { status } = runCli(['init', '--home', home, '--force']);
    expect(status).toBe(0);

    const after = JSON.parse(await readFile(skillsJson, 'utf8')) as {
      skills: Array<{ name: string }>;
    };
    expect(after.skills.some((s) => s.name === 'force-skill')).toBe(true);
    expect(after.skills.some((s) => s.name === 'stale')).toBe(false);
  });

  it('--dry-run prints the draft but writes nothing', async () => {
    const home = freshHome();
    const skillDir = join(home, '.claude', 'skills', 'dry-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: dry-skill\ndescription: dry run test\n---\n\nOK.\n',
    );

    const { status, stdout } = runCli(['init', '--home', home, '--dry-run']);
    expect(status).toBe(0);
    // stdout 应包含草稿 JSON
    expect(stdout).toContain('version');
    expect(stdout).toContain('skills');

    // skills.json 不应被创建
    const skillsJson = getSkillsJsonPath(home);
    await expect(stat(skillsJson)).rejects.toThrow();
  });

  it('--dry-run does NOT clobber an existing skills.json either', async () => {
    const home = freshHome();
    const skillsJson = getSkillsJsonPath(home);
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    const original = JSON.stringify({ version: 1, skills: [{ name: 'keep-me' }] });
    await writeFile(skillsJson, original);

    const { status } = runCli(['init', '--home', home, '--dry-run']);
    expect(status).toBe(0);
    const after = await readFile(skillsJson, 'utf8');
    expect(after).toBe(original);
  });

  it('--json outputs machine-readable JSON on success', async () => {
    const home = freshHome();
    const { status, stdout } = runCli(['init', '--home', home, '--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { status: string; skills: number };
    expect(parsed.status).toBe('written');
    expect(typeof parsed.skills).toBe('number');
  });

  it('--json with existing skills.json outputs exists status', async () => {
    const home = freshHome();
    const skillsJson = getSkillsJsonPath(home);
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(skillsJson, JSON.stringify({ version: 1, skills: [] }));

    const { status, stdout } = runCli(['init', '--home', home, '--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { status: string };
    expect(parsed.status).toBe('exists');
  });

  it('--json --dry-run outputs dryRun:true and the draft', async () => {
    const home = freshHome();
    const { status, stdout } = runCli(['init', '--home', home, '--dry-run', '--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { dryRun: boolean; draft: unknown };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.draft).toBeDefined();
  });

  it('--home isolation: two parallel homes do not interfere', async () => {
    const homeA = freshHome();
    const homeB = freshHome();

    // homeA gets a skill, homeB does not
    const skillDir = join(homeA, '.claude', 'skills', 'isolated-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: isolated-skill\ndescription: isolation test\n---\n\nOK.\n',
    );

    runCli(['init', '--home', homeA]);
    runCli(['init', '--home', homeB]);

    const afterA = JSON.parse(
      await readFile(getSkillsJsonPath(homeA), 'utf8'),
    ) as { skills: Array<{ name: string }> };
    const afterB = JSON.parse(
      await readFile(getSkillsJsonPath(homeB), 'utf8'),
    ) as { skills: Array<{ name: string }> };

    expect(afterA.skills.some((s) => s.name === 'isolated-skill')).toBe(true);
    expect(afterB.skills.some((s) => s.name === 'isolated-skill')).toBe(false);
  });
});
