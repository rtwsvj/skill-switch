// M0-5.9:skill name policy —— 安全护栏 + 规范命名。
import { describe, expect, it } from 'vitest';
import { isCanonicalSkillName, isSafeSkillName } from '../src/core/skill-name.ts';

describe('isSafeSkillName (security guard)', () => {
  it('accepts ordinary names', () => {
    for (const n of ['foo', 'foo-bar', 'foo_bar', 'foo.bar', 'a', 'Skill1']) {
      expect(isSafeSkillName(n), n).toBe(true);
    }
  });

  it('rejects path traversal / separators / absolutes / control chars', () => {
    for (const n of ['foo/bar', 'foo\\bar', '/abs', '..', '.', '.hidden', 'a\0b', 'a\nb', 'a\tb', 'a\x7fb']) {
      expect(isSafeSkillName(n), JSON.stringify(n)).toBe(false);
    }
  });

  it('rejects trailing dot and Windows reserved device names (any case, with extension)', () => {
    for (const n of ['foo.', 'CON', 'con', 'Con', 'CON.md', 'nul.txt', 'PRN', 'AUX', 'COM1', 'LPT9']) {
      expect(isSafeSkillName(n), n).toBe(false);
    }
  });

  it('rejects non-strings and empty', () => {
    for (const n of [null, undefined, 42, '', {}]) {
      expect(isSafeSkillName(n)).toBe(false);
    }
  });
});

describe('isCanonicalSkillName (stricter, for new installs/imports)', () => {
  it('accepts canonical kebab/snake/dotted names', () => {
    for (const n of ['foo', 'foo-bar', 'foo_bar', 'foo.bar', 'a1', 'Skill-2.0_x']) {
      expect(isCanonicalSkillName(n), n).toBe(true);
    }
  });

  it('rejects spaces, unicode, leading non-alphanumeric, reserved, trailing dot, over-length', () => {
    for (const n of ['foo bar', 'föö', '-foo', '.foo', 'CON', 'foo.', 'a'.repeat(81), 'foo/bar']) {
      expect(isCanonicalSkillName(n), n).toBe(false);
    }
  });
});
