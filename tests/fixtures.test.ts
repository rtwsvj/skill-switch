// S1.1 fixture 契约测试:锁定 home-basic 假 home 的结构不变量,
// 后续 S1.3 scan、S1.4 CLI 的验收都建立在这些不变量上。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';

const HOME_BASIC = join(import.meta.dirname, 'fixtures', 'home-basic');

// agent 目录 → 该目录下应有的 skill 目录名
const EXPECTED_LAYOUT: Record<string, string[]> = {
  '.claude/skills': ['git-helper', 'commit-style', 'broken-frontmatter'],
  '.agents/skills': ['deploy-checklist', 'mismatched-name'],
  '.gemini/skills': ['code-review-helper'],
};

describe('fixtures: home-basic', () => {
  it('covers 3 agent dirs and 6 skills', () => {
    const all = Object.entries(EXPECTED_LAYOUT).flatMap(([dir, skills]) =>
      skills.map((s) => join(HOME_BASIC, dir, s, 'SKILL.md')),
    );
    expect(all).toHaveLength(6);
    for (const file of all) {
      expect(existsSync(file), `missing ${file}`).toBe(true);
    }
  });

  it('broken-frontmatter sample actually fails YAML parsing', () => {
    const raw = readFileSync(
      join(HOME_BASIC, '.claude/skills/broken-frontmatter/SKILL.md'),
      'utf8',
    );
    expect(() => matter(raw)).toThrow();
  });

  it('mismatched-name sample declares a name different from its directory', () => {
    const raw = readFileSync(
      join(HOME_BASIC, '.agents/skills/mismatched-name/SKILL.md'),
      'utf8',
    );
    const { data } = matter(raw);
    expect(typeof data.name).toBe('string');
    expect(data.name).not.toBe('mismatched-name');
  });

  it('all other samples parse cleanly with name === directory', () => {
    const clean: Array<[string, string]> = [
      ['.claude/skills', 'git-helper'],
      ['.claude/skills', 'commit-style'],
      ['.agents/skills', 'deploy-checklist'],
      ['.gemini/skills', 'code-review-helper'],
    ];
    for (const [dir, skill] of clean) {
      const raw = readFileSync(join(HOME_BASIC, dir, skill, 'SKILL.md'), 'utf8');
      const { data } = matter(raw);
      expect(data.name, `${skill} frontmatter name`).toBe(skill);
      expect(typeof data.description).toBe('string');
      expect((data.description as string).length).toBeGreaterThan(0);
      expect((data.description as string).length).toBeLessThanOrEqual(1024);
    }
  });
});
