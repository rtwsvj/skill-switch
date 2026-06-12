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
]);

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

export function validateMetadata(
  metadata: Record<string, unknown>,
  dirName?: string,
): string[] {
  const errors: string[] = [...validateAllowedFields(metadata)];

  if (!('name' in metadata)) {
    errors.push('Missing required field in frontmatter: name');
  } else {
    errors.push(...validateName(metadata.name, dirName));
  }

  if (!('description' in metadata)) {
    errors.push('Missing required field in frontmatter: description');
  } else {
    errors.push(...validateDescription(metadata.description));
  }

  if ('compatibility' in metadata) {
    errors.push(...validateCompatibility(metadata.compatibility));
  }

  return errors;
}

export async function validateSkillDir(skillDir: string): Promise<string[]> {
  let info;
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
    return validateMetadata(data as Record<string, unknown>, basename(skillDir));
  } catch (cause) {
    return [cause instanceof Error ? cause.message : String(cause)];
  }
}
