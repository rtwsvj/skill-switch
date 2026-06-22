// S1.3:scan 核心对 home-basic 假 home 的验收测试。
// 关键容错:坏 frontmatter 记 error 字段,绝不抛出。
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanHome } from '../src/core/scan.ts';

const HOME_BASIC = join(import.meta.dirname, 'fixtures', 'home-basic');

describe('core/scan', () => {
  it('returns all 6 skill records from home-basic', async () => {
    const records = await scanHome(HOME_BASIC);
    expect(records).toHaveLength(6);
    expect(records.map((r) => r.dirName).sort()).toEqual([
      'broken-frontmatter',
      'code-review-helper',
      'commit-style',
      'deploy-checklist',
      'git-helper',
      'mismatched-name',
    ]);
  });

  it('records agent/path/name/description per skill', async () => {
    const records = await scanHome(HOME_BASIC);
    const gitHelper = records.find((r) => r.dirName === 'git-helper');
    expect(gitHelper).toBeDefined();
    expect(gitHelper!.agents).toContain('claude-code');
    expect(gitHelper!.relSkillsDir).toBe(join('.claude', 'skills'));
    expect(gitHelper!.dir).toBe(join(HOME_BASIC, '.claude', 'skills', 'git-helper'));
    expect(gitHelper!.path).toBe(
      join(HOME_BASIC, '.claude', 'skills', 'git-helper', 'SKILL.md'),
    );
    expect(gitHelper!.name).toBe('git-helper');
    expect(gitHelper!.description).toMatch(/git/i);
    expect(gitHelper!.error).toBeUndefined();

    const gemini = records.find((r) => r.dirName === 'code-review-helper');
    expect(gemini!.agents).toContain('gemini-cli');
  });

  it('records the absolute skill directory separately from the SKILL.md manifest path', async () => {
    const records = await scanHome(HOME_BASIC);

    for (const record of records) {
      expect(isAbsolute(record.dir)).toBe(true);
      expect(join(record.dir, 'SKILL.md')).toBe(record.path);
      expect((await stat(record.dir)).isDirectory()).toBe(true);
    }
  });

  it('universal skills are visible to multiple agents but recorded once', async () => {
    const records = await scanHome(HOME_BASIC);
    const universal = records.filter((r) => r.relSkillsDir === join('.agents', 'skills'));
    expect(universal.map((r) => r.dirName).sort()).toEqual([
      'deploy-checklist',
      'mismatched-name',
    ]);
    expect(universal[0]!.agents.length).toBeGreaterThan(1);
  });

  it('broken frontmatter yields an error field instead of throwing', async () => {
    const records = await scanHome(HOME_BASIC);
    const broken = records.find((r) => r.dirName === 'broken-frontmatter');
    expect(broken).toBeDefined();
    expect(broken!.error).toBeTruthy();
    expect(broken!.name).toBeUndefined();
  });

  it('captures name/directory mismatch verbatim (judgement belongs to lint)', async () => {
    const records = await scanHome(HOME_BASIC);
    const mismatched = records.find((r) => r.dirName === 'mismatched-name');
    expect(mismatched!.name).toBe('release-runbook');
    expect(mismatched!.error).toBeUndefined();
  });

  it('an empty home scans to an empty list (sandboxed HOME)', async () => {
    const records = await scanHome(homedir());
    expect(records).toEqual([]);
  });

  it('output is deterministically sorted (relSkillsDir, then dirName)', async () => {
    const records = await scanHome(HOME_BASIC);
    const keys = records.map((r) => `${r.relSkillsDir}|${r.dirName}`);
    expect(keys).toEqual([...keys].sort());
  });
});

// R29:回归——符号链接指向的技能目录必须仍被发现。
// R29-a 的 syscall 优化曾用 Dirent.isDirectory()(不跟随符号链接),
// 会漏掉「符号链接进 skills 目录的共享技能」(旧 stat-based 行为会发现它)。
// 此用例锁定:对符号链接条目走 stat 跟随判断,保留旧行为。
describe('core/scan: 符号链接技能目录', () => {
  const tmps: string[] = [];
  const mk = (p: string) => {
    const d = mkdtempSync(join(tmpdir(), p));
    tmps.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('发现符号链接指向的技能目录(与普通技能并存)', async () => {
    const home = mk('scan-sym-home-');
    const external = mk('scan-sym-ext-');

    // 外部真实技能目录
    const realSkill = join(external, 'shared-skill');
    mkdirSync(realSkill, { recursive: true });
    writeFileSync(
      join(realSkill, 'SKILL.md'),
      '---\nname: shared\ndescription: 经符号链接共享\n---\nbody\n',
    );

    const skillsDir = join(home, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    // 一个普通技能目录
    const normal = join(skillsDir, 'normal-skill');
    mkdirSync(normal, { recursive: true });
    writeFileSync(join(normal, 'SKILL.md'), '---\nname: normal\ndescription: 普通\n---\nb\n');
    // 一个符号链接技能目录
    symlinkSync(realSkill, join(skillsDir, 'linked-skill'), 'dir');

    const names = (await scanHome(home)).map((r) => r.dirName).sort();
    expect(names).toContain('normal-skill');
    expect(names).toContain('linked-skill'); // 关键:符号链接技能不能漏
  });

  it('符号链接指向非目录(普通文件)不被当作技能', async () => {
    const home = mk('scan-sym2-home-');
    const external = mk('scan-sym2-ext-');
    const realFile = join(external, 'not-a-dir.txt');
    writeFileSync(realFile, 'just a file');

    const skillsDir = join(home, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(realFile, join(skillsDir, 'file-link'), 'file');

    const names = (await scanHome(home)).map((r) => r.dirName);
    expect(names).not.toContain('file-link'); // 指向文件的符号链接不是技能目录
  });
});
