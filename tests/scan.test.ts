// S1.3:scan 核心对 home-basic 假 home 的验收测试。
// 关键容错:坏 frontmatter 记 error 字段,绝不抛出。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
    expect(gitHelper!.path).toBe(
      join(HOME_BASIC, '.claude', 'skills', 'git-helper', 'SKILL.md'),
    );
    expect(gitHelper!.name).toBe('git-helper');
    expect(gitHelper!.description).toMatch(/git/i);
    expect(gitHelper!.error).toBeUndefined();

    const gemini = records.find((r) => r.dirName === 'code-review-helper');
    expect(gemini!.agents).toContain('gemini-cli');
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
