// S5.1:skills-ref validator.py → TS 移植的逐条对照验收。
//
// ┌─ 对照表(validator.py 行号基于已核实快照,177 行版)──────────────────────
// │ R1  额外字段拒绝          _validate_metadata_fields  (L104-115)
// │ R2  name 必填             validate_metadata           (L131)
// │ R3  name 非空字符串       _validate_name              (L33-35)
// │ R4  name ≤64             _validate_name              (L39-43)
// │ R5  name 必须小写         _validate_name              (L45-46)
// │ R6  首尾连字符禁止        _validate_name              (L48-49)
// │ R7  连续连字符禁止        _validate_name              (L51-52)
// │ R8  仅 unicode 字母数字-  _validate_name              (L54-58)
// │ R9  name=目录名(NFKC)     _validate_name              (L60-66)
// │ R10 description 必填      validate_metadata           (L136)
// │ R11 description 非空      _validate_description       (L73-75)
// │ R12 description ≤1024    _validate_description       (L77-81)
// │ R13 compatibility 须字符串 _validate_compatibility    (L88-90)
// │ R14 compatibility ≤500   _validate_compatibility     (L92-97)
// │ R15 目录存在/是目录/有 SKILL.md/frontmatter 可解析  validate (L150-177)
// └──────────────────────────────────────────────────────────────────────
// 每条规则:1 个命中用例 + 1 个通过反例。
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateMetadata, validateSkillDir } from '../src/core/lint/spec-validator.ts';

const HOME_BASIC = join(import.meta.dirname, 'fixtures', 'home-basic');

const ok = { name: 'good-skill', description: 'A valid description.' };

function errsOf(meta: Record<string, unknown>, dir?: string): string[] {
  return validateMetadata(meta, dir);
}

describe('spec-validator: metadata rules (R1–R14)', () => {
  it('R1 rejects unexpected fields / accepts all allowed fields', () => {
    expect(errsOf({ ...ok, model: 'opus' }).join()).toContain('Unexpected fields');
    expect(
      errsOf({
        ...ok,
        license: 'MIT',
        'allowed-tools': 'Bash',
        metadata: { a: 'b' },
        compatibility: 'all',
      }),
    ).toEqual([]);
  });

  it('R2/R3 name required and non-empty string', () => {
    expect(errsOf({ description: 'd' }).join()).toContain('Missing required field in frontmatter: name');
    expect(errsOf({ ...ok, name: '  ' }).join()).toContain("'name' must be a non-empty string");
    expect(errsOf({ ...ok, name: 42 }).join()).toContain("'name' must be a non-empty string");
  });

  it('R4 name length 64 boundary', () => {
    expect(errsOf({ ...ok, name: 'a'.repeat(65) }).join()).toContain('exceeds 64');
    expect(errsOf({ ...ok, name: 'a'.repeat(64) })).toEqual([]);
  });

  it('R5 lowercase enforced', () => {
    expect(errsOf({ ...ok, name: 'MySkill' }).join()).toContain('must be lowercase');
    expect(errsOf({ ...ok, name: 'myskill' })).toEqual([]);
  });

  it('R6/R7 hyphen placement', () => {
    expect(errsOf({ ...ok, name: '-x' }).join()).toContain('start or end with a hyphen');
    expect(errsOf({ ...ok, name: 'x-' }).join()).toContain('start or end with a hyphen');
    expect(errsOf({ ...ok, name: 'a--b' }).join()).toContain('consecutive hyphens');
    expect(errsOf({ ...ok, name: 'a-b' })).toEqual([]);
  });

  it('R8 unicode letters/digits allowed, others rejected (i18n parity with isalnum)', () => {
    expect(errsOf({ ...ok, name: 'a_b' }).join()).toContain('invalid characters');
    expect(errsOf({ ...ok, name: 'a b' }).join()).toContain('invalid characters');
    expect(errsOf({ ...ok, name: '中文-skill' })).toEqual([]); // i18n 名称合法
  });

  it('R9 directory name must match (NFKC-normalized)', () => {
    expect(errsOf({ ...ok, name: 'release-runbook' }, 'mismatched-name').join()).toContain(
      "must match skill name",
    );
    expect(errsOf({ ...ok, name: 'good-skill' }, 'good-skill')).toEqual([]);
  });

  it('R10/R11/R12 description required / non-empty / ≤1024', () => {
    expect(errsOf({ name: 'x' }).join()).toContain('Missing required field in frontmatter: description');
    expect(errsOf({ ...ok, description: '' }).join()).toContain("'description' must be a non-empty string");
    expect(errsOf({ ...ok, description: 'a'.repeat(1025) }).join()).toContain('exceeds 1024');
    expect(errsOf({ ...ok, description: 'a'.repeat(1024) })).toEqual([]);
  });

  it('R13/R14 compatibility string / ≤500', () => {
    expect(errsOf({ ...ok, compatibility: 7 }).join()).toContain("'compatibility' must be a string");
    expect(errsOf({ ...ok, compatibility: 'a'.repeat(501) }).join()).toContain('exceeds 500');
    expect(errsOf({ ...ok, compatibility: 'a'.repeat(500) })).toEqual([]);
  });
});

describe('spec-validator: directory-level (R15)', () => {
  it('missing path / missing SKILL.md / parse error / clean pass', async () => {
    expect(await validateSkillDir('/no/such/dir')).toEqual(['Path does not exist: /no/such/dir']);

    expect(
      (await validateSkillDir(join(HOME_BASIC, '.claude'))).join(),
    ).toContain('Missing required file: SKILL.md');

    const broken = await validateSkillDir(
      join(HOME_BASIC, '.claude', 'skills', 'broken-frontmatter'),
    );
    expect(broken).toHaveLength(1); // YAML 解析错误原样返回

    expect(
      await validateSkillDir(join(HOME_BASIC, '.claude', 'skills', 'git-helper')),
    ).toEqual([]);
  });

  it('flags the mismatched-name fixture exactly like the spec says', async () => {
    const errors = await validateSkillDir(
      join(HOME_BASIC, '.agents', 'skills', 'mismatched-name'),
    );
    expect(errors.join()).toContain("Directory name 'mismatched-name' must match skill name 'release-runbook'");
  });
});
