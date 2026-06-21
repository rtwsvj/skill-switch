// S5.1:agentskills 官方校验规则移植。
// 来源:agentskills/agentskills skills-ref `src/skills_ref/validator.py`(Apache-2.0,
// 已在 THIRD_PARTY_NOTICES.md 登记 attribution)。逐函数对应:
//   _validate_metadata_fields → validateAllowedFields
//   _validate_name           → validateName(含 NFKC、unicode 字母数字、目录同名)
//   _validate_description    → validateDescription
//   _validate_compatibility  → validateCompatibility
//   validate_metadata        → validateMetadata
//   validate(skill_dir)      → validateSkillDir(存在性/SKILL.md/frontmatter 解析)
// 错误文案保持与上游同义(英文),便于对照规范与上游测试。
import { stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import matter from 'gray-matter';
import type { LintIssue } from './portability.ts';

export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_COMPATIBILITY_LENGTH = 500;

/** Agent Skills Spec 允许的 frontmatter 字段(与 validator.py ALLOWED_FIELDS 一致) */
export const ALLOWED_FIELDS = new Set([
  'name',
  'description',
  'license',
  'allowed-tools',
  'metadata',
  'compatibility',
  // 通用 agent-skill 惯例字段(非 agentskills.io 强制,但被广泛使用)
  'version',
  'tags',
  'triggers',
]);

/** 通用惯例中推荐的可选字段(有助于检索和分发) */
const RECOMMENDED_OPTIONAL_FIELDS = ['version', 'tags', 'triggers'] as const;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

// Python str.isalnum() 是 Unicode 感知的(L* + N* 类别);JS 等价用 \p{L}\p{N}
const NAME_CHARS = /^[\p{L}\p{N}-]+$/u;

function validateName(rawName: unknown, dirName?: string): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(rawName)) {
    errors.push("Field 'name' must be a non-empty string");
    return errors;
  }
  const name = rawName.trim().normalize('NFKC');

  if (name.length > MAX_SKILL_NAME_LENGTH) {
    errors.push(
      `Skill name '${name}' exceeds ${MAX_SKILL_NAME_LENGTH} character limit (${name.length} chars)`,
    );
  }
  if (name !== name.toLowerCase()) {
    errors.push(`Skill name '${name}' must be lowercase`);
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    errors.push('Skill name cannot start or end with a hyphen');
  }
  if (name.includes('--')) {
    errors.push('Skill name cannot contain consecutive hyphens');
  }
  if (!NAME_CHARS.test(name)) {
    errors.push(
      `Skill name '${name}' contains invalid characters. Only letters, digits, and hyphens are allowed.`,
    );
  }
  if (dirName !== undefined && dirName.normalize('NFKC') !== name) {
    errors.push(`Directory name '${dirName}' must match skill name '${name}'`);
  }
  return errors;
}

function validateDescription(description: unknown): string[] {
  if (!isNonEmptyString(description)) {
    return ["Field 'description' must be a non-empty string"];
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return [
      `Description exceeds ${MAX_DESCRIPTION_LENGTH} character limit (${description.length} chars)`,
    ];
  }
  return [];
}

function validateCompatibility(compatibility: unknown): string[] {
  if (typeof compatibility !== 'string') {
    return ["Field 'compatibility' must be a string"];
  }
  if (compatibility.length > MAX_COMPATIBILITY_LENGTH) {
    return [
      `Compatibility exceeds ${MAX_COMPATIBILITY_LENGTH} character limit (${compatibility.length} chars)`,
    ];
  }
  return [];
}

function validateAllowedFields(metadata: Record<string, unknown>): string[] {
  const extra = Object.keys(metadata)
    .filter((k) => !ALLOWED_FIELDS.has(k))
    .sort();
  if (extra.length === 0) return [];
  return [
    `Unexpected fields in frontmatter: ${extra.join(', ')}. Only ${[...ALLOWED_FIELDS].sort().join(', ')} are allowed.`,
  ];
}

/**
 * 检查 frontmatter 是否符合通用 agent-skill 惯例(非 agentskills.io 强制规范)。
 * 返回 LintIssue[] 而非 string[],以便调用层与其他 issues 合并输出。
 *
 * 检查范围:
 *   1. 推荐可选字段缺失提示(仅当 metadata 无平台扩展字段时触发,避免对已有告警的 skill 重复噪音)
 *   2. 可选字段存在但类型明显错误时告警(如 tags 不是数组,version 不是字符串)
 *
 * @param metadata   已解析的 frontmatter 对象
 * @param hasPlatformExtensions  调用层已检测到平台专有字段时传 true,用于门控缺失提示
 */
export function checkFrontmatterConventions(
  metadata: Record<string, unknown>,
  hasPlatformExtensions = false,
): LintIssue[] {
  const issues: LintIssue[] = [];

  // ── 1. 推荐可选字段缺失提示 ──────────────────────────────────────────────
  // 仅当 skill 未使用平台专有扩展字段时才提示,避免对"已有特殊用途"的 skill 发出额外噪音。
  if (!hasPlatformExtensions) {
    const missingOptional = RECOMMENDED_OPTIONAL_FIELDS.filter((f) => !(f in metadata));
    if (missingOptional.length === RECOMMENDED_OPTIONAL_FIELDS.length) {
      // 全部推荐字段均缺失——给一条综合提示
      issues.push({
        severity: 'info',
        rule: 'convention/missing-optional-fields',
        message: `建议补充可选字段 ${RECOMMENDED_OPTIONAL_FIELDS.join(', ')} 以改善检索和分发体验`,
      });
    }
  }

  // ── 2. 可选字段类型校验(字段存在但类型明显错误) ──────────────────────────
  if ('version' in metadata && typeof metadata.version !== 'string') {
    issues.push({
      severity: 'warning',
      rule: 'convention/version-not-string',
      field: 'version',
      message: `字段 'version' 应为字符串(如 "1.0.0"),当前类型为 ${typeof metadata.version}`,
    });
  }

  if ('tags' in metadata) {
    if (!Array.isArray(metadata.tags)) {
      issues.push({
        severity: 'warning',
        rule: 'convention/tags-not-array',
        field: 'tags',
        message: `字段 'tags' 应为字符串列表(如 [git, ci]),当前类型为 ${typeof metadata.tags}`,
      });
    } else if (metadata.tags.some((t) => typeof t !== 'string')) {
      issues.push({
        severity: 'warning',
        rule: 'convention/tags-non-string-item',
        field: 'tags',
        message: `字段 'tags' 列表中含非字符串元素,所有标签应为字符串`,
      });
    }
  }

  if ('triggers' in metadata) {
    const t = metadata.triggers;
    const valid = typeof t === 'string' || (Array.isArray(t) && t.every((x) => typeof x === 'string'));
    if (!valid) {
      issues.push({
        severity: 'warning',
        rule: 'convention/triggers-invalid-type',
        field: 'triggers',
        message: `字段 'triggers' 应为字符串或字符串列表,当前类型为 ${Array.isArray(t) ? 'array(含非字符串)' : typeof t}`,
      });
    }
  }

  return issues;
}

export function validateMetadata(
  metadata: unknown,
  dirName?: string,
): string[] {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return ['Frontmatter metadata must be an object'];
  }

  const record = metadata as Record<string, unknown>;
  const errors: string[] = [...validateAllowedFields(record)];

  if (!('name' in record)) {
    errors.push('Missing required field in frontmatter: name');
  } else {
    errors.push(...validateName(record.name, dirName));
  }

  if (!('description' in record)) {
    errors.push('Missing required field in frontmatter: description');
  } else {
    errors.push(...validateDescription(record.description));
  }

  if ('compatibility' in record) {
    errors.push(...validateCompatibility(record.compatibility));
  }

  return errors;
}

export async function validateSkillDir(skillDir: string): Promise<string[]> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(skillDir);
  } catch {
    return [`Path does not exist: ${skillDir}`];
  }
  if (!info.isDirectory()) return [`Not a directory: ${skillDir}`];

  const skillMd = join(skillDir, 'SKILL.md');
  let raw: string;
  try {
    raw = await readFile(skillMd, 'utf8');
  } catch {
    return ['Missing required file: SKILL.md'];
  }

  try {
    // 空 options 绕过 gray-matter 全局缓存(见 core/scan.ts 的教训)
    const { data } = matter(raw, {});
    return validateMetadata(data, basename(skillDir));
  } catch (cause) {
    return [cause instanceof Error ? cause.message : String(cause)];
  }
}
