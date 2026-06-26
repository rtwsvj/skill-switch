// v0.5-3:项目策略文件(.skill-switch-policy.json)的类型定义、验证与加载逻辑。
// 纯 JSON,无新依赖。加载失败 → 抛 PolicyFileError(类比 StateFileError),由 CLI 层捕获后
// 打印友好错误并 exit 1,绝不 crash。

import { readFile } from 'node:fs/promises';
import type { Severity } from './types.ts';

/** 策略文件中合法的 failOn 严重度枚举值 */
const VALID_FAIL_ON = new Set<string>(['critical', 'high', 'medium', 'low']);

// ── 错误类 ────────────────────────────────────────────────────────────────────

export class PolicyFileError extends Error {
  readonly path: string;
  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PolicyFileError';
    this.path = path;
  }
}

// ── 类型定义 ──────────────────────────────────────────────────────────────────

/** 策略文件中一条抑制规则 */
export interface PolicySuppression {
  /** 要抑制的规则 ID,如 "exfil/curl-secret" */
  ruleId: string;
  /** 说明抑制原因,供审计留档 */
  reason?: string;
}

/** .skill-switch-policy.json 文件的完整结构 */
export interface PolicyFile {
  /**
   * 触发失败的最低严重度。只有严重度 >= 此值的 finding 才会导致非零退出码。
   * 默认值:不存在策略文件时等同于 "high"(维持现有行为)。
   */
  failOn?: Severity;
  /**
   * 被抑制的规则列表。命中的 finding 仍会出现在输出中,但不计入退出码决策。
   */
  suppress?: PolicySuppression[];
}

/** 完全解析后的策略(所有字段均有默认值) */
export interface ResolvedPolicy {
  /** 触发失败的最低严重度 */
  failOn: Severity;
  /** 被抑制的 ruleId 集合(快速查找) */
  suppressedRuleIds: ReadonlySet<string>;
  /** 原始抑制条目(保留 reason,供 JSON/SARIF 输出) */
  suppressions: PolicySuppression[];
}

// ── 默认策略(无文件时行为与旧版完全一致) ─────────────────────────────────────

/**
 * 无策略文件时使用的默认策略。
 * failOn = "high" 与旧版 BLOCKING_SEVERITIES = {critical, high} 行为相同。
 */
export const DEFAULT_POLICY: ResolvedPolicy = {
  failOn: 'high',
  suppressedRuleIds: new Set<string>(),
  suppressions: [],
};

// ── 验证 ──────────────────────────────────────────────────────────────────────

/**
 * 将原始 JSON 对象解析为 PolicyFile 并做结构校验。
 * 字段类型或枚举值非法时抛 PolicyFileError。
 */
export function validatePolicyFile(raw: unknown, filePath: string): PolicyFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyFileError('策略文件根节点必须是 JSON 对象', filePath);
  }

  const obj = raw as Record<string, unknown>;

  // failOn 校验
  if ('failOn' in obj) {
    if (typeof obj.failOn !== 'string' || !VALID_FAIL_ON.has(obj.failOn as string)) {
      throw new PolicyFileError(
        `策略文件 failOn 值非法:"${String(obj.failOn)}";合法值为 critical | high | medium | low`,
        filePath,
      );
    }
  }

  // suppress 校验
  if ('suppress' in obj) {
    if (!Array.isArray(obj.suppress)) {
      throw new PolicyFileError('策略文件 suppress 必须是数组', filePath);
    }
    for (let i = 0; i < (obj.suppress as unknown[]).length; i++) {
      const entry = (obj.suppress as unknown[])[i];
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new PolicyFileError(`策略文件 suppress[${i}] 必须是对象`, filePath);
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.ruleId !== 'string' || e.ruleId.length === 0) {
        throw new PolicyFileError(
          `策略文件 suppress[${i}].ruleId 必须是非空字符串`,
          filePath,
        );
      }
      if ('reason' in e && typeof e.reason !== 'string') {
        throw new PolicyFileError(
          `策略文件 suppress[${i}].reason 若存在必须是字符串`,
          filePath,
        );
      }
    }
  }

  return obj as unknown as PolicyFile;
}

/**
 * 将已验证的 PolicyFile 解析为 ResolvedPolicy。
 */
export function resolvePolicyFile(pf: PolicyFile): ResolvedPolicy {
  const failOn: Severity = pf.failOn ?? DEFAULT_POLICY.failOn;
  const suppressions: PolicySuppression[] = pf.suppress ?? [];
  const suppressedRuleIds = new Set<string>(suppressions.map((s) => s.ruleId));
  return { failOn, suppressedRuleIds, suppressions };
}

// ── 加载 ──────────────────────────────────────────────────────────────────────

/**
 * 从磁盘加载并解析策略文件。
 * - 文件不存在(ENOENT) → 返回 null(调用方使用 DEFAULT_POLICY)
 * - 文件存在但 JSON 损坏或结构非法 → 抛 PolicyFileError
 */
export async function loadPolicyFile(filePath: string): Promise<ResolvedPolicy | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new PolicyFileError(
      `无法读取策略文件 ${filePath}: ${(error as Error).message}`,
      filePath,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PolicyFileError(
      `策略文件 JSON 解析失败: ${(error as Error).message}`,
      filePath,
      { cause: error },
    );
  }

  const pf = validatePolicyFile(parsed, filePath);
  return resolvePolicyFile(pf);
}
