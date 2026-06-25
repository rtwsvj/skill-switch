// v0.7-1:基线模式(baseline mode)——把当前 finding 快照为"已接受",仅新 finding 影响退出码。
//
// ── 指纹方案 ──────────────────────────────────────────────────────────────────
// 指纹 = sha256( ruleId + '\0' + relFile + '\0' + normalize(excerpt) )
//
// 刻意 **不纳入行号**:插入空行不改变 excerpt 内容,指纹因此不变 → 行号漂移容忍。
// normalize(excerpt) = excerpt.trim() 后将连续空白压缩为单个空格,
//   排除 trailing spaces / mixed-indent 等无语义差异。
//
// 冲突率:sha256 截断到 hex 64 chars,单项目几百条 finding 的碰撞概率可忽略不计。

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { AuditFinding } from './types.ts';

// ── 指纹计算 ──────────────────────────────────────────────────────────────────

/**
 * 将 excerpt 规范化:去首尾空白,内部连续空白压缩为单个空格。
 * 规范化后与行号无关,因此插入空行不改变同一 finding 的指纹。
 */
export function normalizeExcerpt(excerpt: string): string {
  return excerpt.trim().replace(/\s+/g, ' ');
}

/**
 * 计算单条 finding 的指纹。
 * 输入:ruleId、相对文件路径、excerpt(原始)。
 * 输出:64 位十六进制 sha256 字符串。
 *
 * 刻意排除 line 字段,使指纹对行号漂移(e.g. 在 finding 上方插入空行)免疫。
 */
export function fingerprintFinding(finding: Pick<AuditFinding, 'ruleId' | 'file' | 'excerpt'>): string {
  const payload = `${finding.ruleId}\0${finding.file}\0${normalizeExcerpt(finding.excerpt)}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ── 基线文件格式 ──────────────────────────────────────────────────────────────
//
// { "version": 1, "generatedAt": "<ISO 8601>", "fingerprints": ["hex64", ...] }
// fingerprints 已排序去重,便于 diff 和人工复核。

export const BASELINE_VERSION = 1;

export interface BaselineFile {
  version: number;
  generatedAt: string;
  /** 已排序、去重的 sha256 hex 指纹列表 */
  fingerprints: string[];
}

// ── 错误类 ────────────────────────────────────────────────────────────────────

export class BaselineFileError extends Error {
  readonly path: string;
  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BaselineFileError';
    this.path = path;
  }
}

// ── 生成基线 ──────────────────────────────────────────────────────────────────

/**
 * 从 finding 列表生成基线文件对象。
 * 指纹去重、排序,便于 git diff 和人工复核。
 */
export function buildBaselineFile(findings: AuditFinding[]): BaselineFile {
  const fps = [...new Set(findings.map(fingerprintFinding))].sort();
  return {
    version: BASELINE_VERSION,
    generatedAt: new Date().toISOString(),
    fingerprints: fps,
  };
}

/**
 * 将基线写入磁盘(JSON,2 空格缩进,末尾换行)。
 * 写入失败会向上抛出 node fs 错误,由 CLI 层捕获。
 */
export async function writeBaselineFile(filePath: string, baseline: BaselineFile): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
}

// ── 加载基线 ──────────────────────────────────────────────────────────────────

/**
 * 从磁盘加载基线文件并返回指纹集合。
 * - 文件不存在(ENOENT) → 抛 BaselineFileError(调用方判为 exit 1 + 友好错误)
 * - JSON 损坏或结构非法 → 抛 BaselineFileError
 */
export async function loadBaselineFile(filePath: string): Promise<ReadonlySet<string>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BaselineFileError(`基线文件不存在: ${filePath}`, filePath, { cause: error });
    }
    throw new BaselineFileError(
      `无法读取基线文件 ${filePath}: ${(error as Error).message}`,
      filePath,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BaselineFileError(
      `基线文件 JSON 解析失败: ${(error as Error).message}`,
      filePath,
      { cause: error },
    );
  }

  return validateAndExtractFingerprints(parsed, filePath);
}

/**
 * 校验基线文件结构并提取指纹集合。
 * 结构非法时抛 BaselineFileError。
 */
export function validateAndExtractFingerprints(raw: unknown, filePath: string): ReadonlySet<string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BaselineFileError('基线文件根节点必须是 JSON 对象', filePath);
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.version !== 'number') {
    throw new BaselineFileError('基线文件缺少 version 字段(必须是数字)', filePath);
  }
  if (!Array.isArray(obj.fingerprints)) {
    throw new BaselineFileError('基线文件 fingerprints 字段必须是数组', filePath);
  }

  const fps = obj.fingerprints as unknown[];
  for (let i = 0; i < fps.length; i++) {
    if (typeof fps[i] !== 'string') {
      throw new BaselineFileError(`基线文件 fingerprints[${i}] 必须是字符串`, filePath);
    }
  }

  return new Set(fps as string[]);
}
