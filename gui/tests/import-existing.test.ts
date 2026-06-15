// F-A3:importableSkills —— 识别磁盘上还没纳入声明管理的技能。
import { describe, expect, it } from 'vitest';
import { importableSkills } from '../src/App';
import type { SkillRecord } from '../src/data';

function rec(partial: Partial<SkillRecord> & { dirName: string; agents: string[] }): SkillRecord {
  return {
    relSkillsDir: '.claude/skills',
    dir: `/h/${partial.dirName}`,
    path: `/h/${partial.dirName}/SKILL.md`,
    name: partial.dirName,
    ...partial,
  };
}

describe('F-A3 importableSkills', () => {
  it('flags an on-disk skill whose agent pair is not declared', () => {
    const declared = new Set<string>(); // 什么都没声明
    const skills = [rec({ dirName: 'foo', agents: ['claude-code'] })];
    expect(importableSkills(skills, declared).map((s) => s.dirName)).toEqual(['foo']);
  });

  it('does not flag a skill already declared for all its agents', () => {
    const declared = new Set(['claude-code/foo']);
    const skills = [rec({ dirName: 'foo', agents: ['claude-code'] })];
    expect(importableSkills(skills, declared)).toEqual([]);
  });

  it('flags a skill that is declared for one agent but not another', () => {
    const declared = new Set(['claude-code/foo']); // codex 未声明
    const skills = [rec({ dirName: 'foo', agents: ['claude-code', 'codex'] })];
    expect(importableSkills(skills, declared).map((s) => s.dirName)).toEqual(['foo']);
  });

  it('skips skills with parse errors', () => {
    const declared = new Set<string>();
    const skills = [rec({ dirName: 'broken', agents: ['claude-code'], error: 'bad frontmatter' })];
    expect(importableSkills(skills, declared)).toEqual([]);
  });
});
