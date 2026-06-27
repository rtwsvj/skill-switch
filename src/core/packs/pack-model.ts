// Step3:套餐模型(pack-model.ts)
// 职责:
//   - validatePackManifest  — 结构校验,非法输入抛 PackManifestError
//   - loadPackManifest      — 从磁盘读取并校验
//   - writePackManifest     — 写入磁盘(pretty JSON + 尾换行)
//   - suggestionToManifest  — 把 Step2 建议转换为可携带的 PackManifest
//   - manifestToInstallPlan — 纯函数:提取有序 skill 列表供外部安装器消费
//   - diffManifest          — 对比两个清单的增删(供"更新套餐"流程使用)
//
// 无网络、无 spawn、无新依赖。不碰 CLI / install.ts。

import { readFile, writeFile } from 'node:fs/promises';
import type { PackManifest, PackSkillRef, PackSuggestion } from './types.ts';

// ── 错误类 ──────────────────────────────────────────────────────────────────

/** 套餐清单文件读取或结构校验失败时抛出。镜像 PolicyFileError 的风格。 */
export class PackManifestError extends Error {
  readonly path: string;
  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PackManifestError';
    this.path = path;
  }
}

// ── 合法枚举 ────────────────────────────────────────────────────────────────

const VALID_SOURCES = new Set<string>(['manual', 'discovered']);

// ── 结构校验 ────────────────────────────────────────────────────────────────

/**
 * 将原始值解析为 PackManifest 并做完整结构校验。
 * 校验规则:
 *   - 根节点必须是 JSON 对象
 *   - version === 1(精确相等)
 *   - name 非空字符串
 *   - source ∈ { manual, discovered }
 *   - skills 必须是数组,每项须含非空字符串 name;
 *     可选 repo/commit/ref 若存在必须是字符串
 *   - displayName/description/createdAt 若存在必须是字符串
 * 任何不符合则抛 PackManifestError(path 来自调用方,默认 '<unknown>')。
 */
export function validatePackManifest(raw: unknown, path = '<unknown>'): PackManifest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PackManifestError('套餐清单根节点必须是 JSON 对象', path);
  }

  const obj = raw as Record<string, unknown>;

  // version
  if (obj.version !== 1) {
    throw new PackManifestError(
      `套餐清单 version 必须是 1,实际值: ${JSON.stringify(obj.version)}`,
      path,
    );
  }

  // name
  if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
    throw new PackManifestError('套餐清单 name 必须是非空字符串', path);
  }

  // source
  if (typeof obj.source !== 'string' || !VALID_SOURCES.has(obj.source)) {
    throw new PackManifestError(
      `套餐清单 source 值非法:"${String(obj.source)}";合法值为 manual | discovered`,
      path,
    );
  }

  // skills
  if (!Array.isArray(obj.skills)) {
    throw new PackManifestError('套餐清单 skills 必须是数组', path);
  }
  for (let i = 0; i < (obj.skills as unknown[]).length; i++) {
    const entry = (obj.skills as unknown[])[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PackManifestError(`套餐清单 skills[${i}] 必须是对象`, path);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string' || e.name.trim().length === 0) {
      throw new PackManifestError(
        `套餐清单 skills[${i}].name 必须是非空字符串`,
        path,
      );
    }
    for (const optKey of ['repo', 'commit', 'ref'] as const) {
      if (optKey in e && typeof e[optKey] !== 'string') {
        throw new PackManifestError(
          `套餐清单 skills[${i}].${optKey} 若存在必须是字符串`,
          path,
        );
      }
    }
    // optional:若存在必须是布尔值
    if ('optional' in e && typeof e.optional !== 'boolean') {
      throw new PackManifestError(
        `套餐清单 skills[${i}].optional 若存在必须是布尔值`,
        path,
      );
    }
  }

  // 可选顶层字符串字段
  for (const optKey of ['displayName', 'description', 'createdAt'] as const) {
    if (optKey in obj && typeof obj[optKey] !== 'string') {
      throw new PackManifestError(
        `套餐清单 ${optKey} 若存在必须是字符串`,
        path,
      );
    }
  }

  // extends:若存在必须是字符串数组(父套餐清单路径)
  if ('extends' in obj && obj.extends !== undefined) {
    if (
      !Array.isArray(obj.extends) ||
      obj.extends.some((p) => typeof p !== 'string' || p.trim().length === 0)
    ) {
      throw new PackManifestError('套餐清单 extends 若存在必须是非空字符串数组', path);
    }
  }

  return obj as unknown as PackManifest;
}

// ── 磁盘 I/O ────────────────────────────────────────────────────────────────

/**
 * 从磁盘加载并校验套餐清单。
 * - ENOENT → PackManifestError
 * - 损坏 JSON → PackManifestError
 * - 结构非法 → PackManifestError(validatePackManifest 抛出)
 */
export async function loadPackManifest(filePath: string): Promise<PackManifest> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new PackManifestError(
      `无法读取套餐清单 ${filePath}: ${(error as Error).message}`,
      filePath,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PackManifestError(
      `套餐清单 JSON 解析失败: ${(error as Error).message}`,
      filePath,
      { cause: error },
    );
  }

  return validatePackManifest(parsed, filePath);
}

/**
 * 将套餐清单写入磁盘。
 * 格式:pretty JSON(2 格缩进)+ 尾换行。
 */
export async function writePackManifest(filePath: string, manifest: PackManifest): Promise<void> {
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(filePath, content, 'utf8');
}

// ── 建议 → 清单 ─────────────────────────────────────────────────────────────

export interface SuggestionToManifestOpts {
  /** 覆盖 source(默认 'discovered') */
  source?: 'manual' | 'discovered';
  /** 自定义显示名(默认用 suggestion.suggestedName) */
  displayName?: string;
  /** 清单描述 */
  description?: string;
  /**
   * 按 skill 名补充 repo/commit/ref 信息。
   * key = skill 名,value = 要合并的字段(可只填部分)。
   */
  skillRefs?: Record<string, Partial<PackSkillRef>>;
}

/**
 * 把 Step2 产出的 PackSuggestion 转换为可携带的 PackManifest。
 * - source 默认 'discovered'
 * - skills 顺序与 suggestion.skills 一致
 * - 若 opts.skillRefs 含对应 skill 的额外信息则合并
 * - createdAt 设为当前 ISO 时间
 */
export function suggestionToManifest(
  s: PackSuggestion,
  opts?: SuggestionToManifestOpts,
): PackManifest {
  const source = opts?.source ?? 'discovered';
  const skillRefs = opts?.skillRefs ?? {};

  const skills: PackSkillRef[] = s.skills.map((skillName) => {
    const extra = skillRefs[skillName] ?? {};
    const ref: PackSkillRef = { name: skillName };
    if (typeof extra.repo === 'string') ref.repo = extra.repo;
    if (typeof extra.commit === 'string') ref.commit = extra.commit;
    if (typeof extra.ref === 'string') ref.ref = extra.ref;
    return ref;
  });

  const manifest: PackManifest = {
    version: 1,
    name: s.suggestedName,
    source,
    skills,
    createdAt: new Date().toISOString(),
  };

  if (opts?.displayName !== undefined) manifest.displayName = opts.displayName;
  if (opts?.description !== undefined) manifest.description = opts.description;

  return manifest;
}

// ── 安装计划 ─────────────────────────────────────────────────────────────────

/**
 * 从 PackManifest 提取有序的 skill 安装列表。
 *
 * 纯函数:输入 manifest → 输出 { skills: PackSkillRef[] }。
 * 编排器(CLI/orchestrator)把此列表喂给现有的安装流水线;
 * 本函数本身不执行任何安装操作。
 *
 * 当前实现直接返回 manifest.skills 的浅拷贝(保持声明顺序)。
 * 日后如需拓扑排序或去重,只改此函数即可。
 */
export function manifestToInstallPlan(m: PackManifest): { skills: PackSkillRef[] } {
  return { skills: [...m.skills] };
}

// ── diff ─────────────────────────────────────────────────────────────────────

/**
 * 对比两个 PackManifest 的 skill 集合差异。
 * 返回按名称比较的增删列表(顺序无关)。
 * 用于"更新套餐"场景:展示新旧版本间哪些 skill 被加入/移除。
 */
export function diffManifest(
  a: PackManifest,
  b: PackManifest,
): { added: PackSkillRef[]; removed: PackSkillRef[] } {
  const namesA = new Set(a.skills.map((s) => s.name));
  const namesB = new Set(b.skills.map((s) => s.name));

  const added = b.skills.filter((s) => !namesA.has(s.name));
  const removed = a.skills.filter((s) => !namesB.has(s.name));

  return { added, removed };
}
