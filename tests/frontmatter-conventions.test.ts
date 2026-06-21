// S5.1-ext: SKILL.md frontmatter 惯例校验验收。
// 测试 checkFrontmatterConventions 新增的告警:
//   C1  缺失推荐可选字段(info 级,仅在无平台扩展字段时触发)
//   C2  version 非字符串 → warning
//   C3  tags 非数组 → warning
//   C4  tags 数组含非字符串元素 → warning
//   C5  triggers 类型非法 → warning
//   C6  触发门控:有平台扩展字段时不触发缺失提示
//   C7  合规 skill(有全部推荐字段)无任何告警
//   C8  lintSkillDir 集成:fixture 文件路径级验收
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFrontmatterConventions } from '../src/core/lint/spec-validator.ts';
import { lintSkillDir } from '../src/core/lint/lint-home.ts';

const FIX = join(import.meta.dirname, 'fixtures', 'skills-conventions');

// ─────────────────────────────────────────────────────────────────────────────
// 单元测试:checkFrontmatterConventions
// ─────────────────────────────────────────────────────────────────────────────

describe('checkFrontmatterConventions: 缺失可选字段提示 (C1 / C6)', () => {
  it('C1 仅有 name+description 时输出一条 info 级综合提示', () => {
    const issues = checkFrontmatterConventions({ name: 'x', description: 'd' });
    const infoIssue = issues.find((i) => i.rule === 'convention/missing-optional-fields');
    expect(infoIssue).toBeDefined();
    expect(infoIssue!.severity).toBe('info');
    expect(infoIssue!.message).toContain('version');
    expect(infoIssue!.message).toContain('tags');
    expect(infoIssue!.message).toContain('triggers');
  });

  it('C6 传入 hasPlatformExtensions=true 时不触发缺失提示', () => {
    const issues = checkFrontmatterConventions(
      { name: 'x', description: 'd', model: 'opus' },
      true, // hasPlatformExtensions
    );
    expect(issues.every((i) => i.rule !== 'convention/missing-optional-fields')).toBe(true);
  });

  it('有任意一个推荐字段时不再触发综合缺失提示', () => {
    // 只要有 version 就不触发"全部缺失"警告
    const issues = checkFrontmatterConventions({ name: 'x', description: 'd', version: '1.0.0' });
    expect(issues.every((i) => i.rule !== 'convention/missing-optional-fields')).toBe(true);
  });
});

describe('checkFrontmatterConventions: version 类型校验 (C2)', () => {
  it('C2 version 为数字时产生 warning', () => {
    const issues = checkFrontmatterConventions({ name: 'x', description: 'd', version: 2 });
    const w = issues.find((i) => i.rule === 'convention/version-not-string');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
    expect(w!.field).toBe('version');
    expect(w!.message).toContain('number');
  });

  it('C2 version 为对象时产生 warning', () => {
    const issues = checkFrontmatterConventions({ name: 'x', description: 'd', version: { major: 1 } });
    expect(issues.some((i) => i.rule === 'convention/version-not-string')).toBe(true);
  });

  it('version 为合法字符串时无告警', () => {
    const issues = checkFrontmatterConventions({ name: 'x', description: 'd', version: '1.0.0' });
    expect(issues.every((i) => i.rule !== 'convention/version-not-string')).toBe(true);
  });
});

describe('checkFrontmatterConventions: tags 类型校验 (C3 / C4)', () => {
  it('C3 tags 为字符串时产生 warning', () => {
    const issues = checkFrontmatterConventions({ name: 'x', description: 'd', tags: 'git, ci' });
    const w = issues.find((i) => i.rule === 'convention/tags-not-array');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
    expect(w!.field).toBe('tags');
  });

  it('C3 tags 为数字时产生 warning', () => {
    const issues = checkFrontmatterConventions({ name: 'x', description: 'd', tags: 42 });
    expect(issues.some((i) => i.rule === 'convention/tags-not-array')).toBe(true);
  });

  it('C4 tags 数组中含非字符串元素时产生 warning', () => {
    const issues = checkFrontmatterConventions({ name: 'x', description: 'd', tags: ['git', 99] });
    const w = issues.find((i) => i.rule === 'convention/tags-non-string-item');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
    expect(w!.field).toBe('tags');
  });

  it('tags 为全字符串数组时无告警', () => {
    const issues = checkFrontmatterConventions({ name: 'x', description: 'd', tags: ['git', 'ci'] });
    expect(issues.every((i) => !i.rule.startsWith('convention/tags'))).toBe(true);
  });

  it('tags 为空数组时无告警', () => {
    const issues = checkFrontmatterConventions({ name: 'x', description: 'd', tags: [] });
    expect(issues.every((i) => !i.rule.startsWith('convention/tags'))).toBe(true);
  });
});

describe('checkFrontmatterConventions: triggers 类型校验 (C5)', () => {
  it('C5 triggers 为数字时产生 warning', () => {
    const issues = checkFrontmatterConventions({ name: 'x', description: 'd', triggers: 123 });
    const w = issues.find((i) => i.rule === 'convention/triggers-invalid-type');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
    expect(w!.field).toBe('triggers');
  });

  it('C5 triggers 数组含非字符串元素时产生 warning', () => {
    const issues = checkFrontmatterConventions({
      name: 'x',
      description: 'd',
      triggers: ['use when asked', 42],
    });
    expect(issues.some((i) => i.rule === 'convention/triggers-invalid-type')).toBe(true);
  });

  it('triggers 为字符串时无告警', () => {
    const issues = checkFrontmatterConventions({
      name: 'x',
      description: 'd',
      triggers: 'use when the user asks about deploys',
    });
    expect(issues.every((i) => i.rule !== 'convention/triggers-invalid-type')).toBe(true);
  });

  it('triggers 为全字符串数组时无告警', () => {
    const issues = checkFrontmatterConventions({
      name: 'x',
      description: 'd',
      triggers: ['use when asked about ci', 'use when asked about deploys'],
    });
    expect(issues.every((i) => i.rule !== 'convention/triggers-invalid-type')).toBe(true);
  });
});

describe('checkFrontmatterConventions: 合规 skill 无告警 (C7)', () => {
  it('C7 所有推荐字段均存在且类型正确时无任何告警', () => {
    const issues = checkFrontmatterConventions({
      name: 'deploy-helper',
      description: 'Use when deploying to production.',
      version: '2.0.0',
      tags: ['deploy', 'ci'],
      triggers: 'use when asked about production deployments',
    });
    expect(issues).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 集成测试:lintSkillDir + fixture 文件 (C8)
// ─────────────────────────────────────────────────────────────────────────────

describe('lintSkillDir: frontmatter 惯例 — fixture 级集成 (C8)', () => {
  it('well-formed-optional: 无任何 specErrors 或 issues', async () => {
    const result = await lintSkillDir(join(FIX, 'well-formed-optional'), 'claude-code');
    expect(result.specErrors).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('bare-no-optional: 产生 convention/missing-optional-fields info', async () => {
    const result = await lintSkillDir(join(FIX, 'bare-no-optional'), 'claude-code');
    expect(result.specErrors).toEqual([]);
    const info = result.issues.find((i) => i.rule === 'convention/missing-optional-fields');
    expect(info).toBeDefined();
    expect(info!.severity).toBe('info');
  });

  it('malformed-tags: 产生 convention/tags-not-array warning', async () => {
    const result = await lintSkillDir(join(FIX, 'malformed-tags'), 'claude-code');
    expect(result.specErrors).toEqual([]);
    const w = result.issues.find((i) => i.rule === 'convention/tags-not-array');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
  });

  it('malformed-version: 产生 convention/version-not-string warning', async () => {
    const result = await lintSkillDir(join(FIX, 'malformed-version'), 'claude-code');
    expect(result.specErrors).toEqual([]);
    const w = result.issues.find((i) => i.rule === 'convention/version-not-string');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
  });

  it('malformed-triggers: 产生 convention/triggers-invalid-type warning', async () => {
    const result = await lintSkillDir(join(FIX, 'malformed-triggers'), 'claude-code');
    expect(result.specErrors).toEqual([]);
    const w = result.issues.find((i) => i.rule === 'convention/triggers-invalid-type');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warning');
  });

  it('malformed-version: 告警级别为 warning,不算 error,exit code 应为 0', async () => {
    // LintIssue.severity=warning 不触发 hasErrors
    const result = await lintSkillDir(join(FIX, 'malformed-version'), 'claude-code');
    const hasErrors = result.specErrors.length > 0 || result.issues.some((i) => i.severity === 'error');
    expect(hasErrors).toBe(false);
  });
});
