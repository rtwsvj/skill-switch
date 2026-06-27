// pack-lock.ts — 套餐 lockfile 模块
// 职责:
//   - PackLock 类型定义(lock 文件的数据结构)
//   - buildPackLock    — 纯函数:从安装结果构建 lock 对象
//   - validatePackLock — 结构校验,非法输入抛 PackLockError
//   - loadPackLock     — 从磁盘读取并校验
//   - writePackLock    — 写入磁盘(pretty JSON + 尾换行)
//   - lockFilePath     — 纯函数:根据 pack 文件路径推导同级 lock 文件路径
//   - resolvedCommitsMap — 纯函数:从 lock 提取 name→commit Map,供 installPack 消费
//
// 无网络、无 spawn、无新依赖。纯函数 + 最小 I/O。

import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { PackSkillInstallResult } from './install-pack.ts';

// ── 错误类 ──────────────────────────────────────────────────────────────────

export class PackLockError extends Error {
  readonly path: string;
  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PackLockError';
    this.path = path;
  }
}

// ── 数据结构 ─────────────────────────────────────────────────────────────────

/**
 * 单个已解析 skill 的记录:记录安装时实际用的 commit。
 * commit 可能是安装器从远端解析出来的精确 SHA,也可能是用户在 pack.json 里写的 ref。
 */
export interface PackLockEntry {
  /** skill 名 */
  name: string;
  /** 来源仓库 URL */
  repo: string;
  /**
   * 安装时实际解析的 commit SHA(或 ref 字符串)。
   * 若安装器未返回 commit 则保留 repo + name 组合,仍可做版本追踪。
   */
  commit: string;
}

/**
 * 套餐 lockfile 结构:记录某次安装里每个 skill 的精确来源。
 * 写入 <pack>.pack.lock.json,与 pack.json 同级。
 */
export interface PackLock {
  /** 格式版本,固定为 1 */
  version: 1;
  /** 套餐名(来自 PackManifest.name) */
  pack: string;
  /** 已成功安装的 skill 列表(resolved commit) */
  resolved: PackLockEntry[];
  /** lock 文件生成时间(ISO 8601) */
  createdAt: string;
}

// ── 路径推导 ─────────────────────────────────────────────────────────────────

/**
 * 纯函数:根据 pack 文件路径推导同级 lock 文件路径。
 *
 * 规则:
 *   - xxx.pack.json → xxx.pack.lock.json
 *   - xxx.json      → xxx.lock.json
 *   - 其他扩展名    → <原路径>.lock.json
 */
export function lockFilePath(packPath: string): string {
  if (packPath.endsWith('.pack.json')) {
    return packPath.replace(/\.pack\.json$/, '.pack.lock.json');
  }
  const ext = extname(packPath);
  if (ext === '.json') {
    return packPath.replace(/\.json$/, '.lock.json');
  }
  return `${packPath}.lock.json`;
}

// ── 构建 lock ────────────────────────────────────────────────────────────────

/**
 * 纯函数:从安装结果列表构建 PackLock。
 *
 * 规则:
 *   - 只纳入 action='installed' 的结果(blocked/error/skipped 不计入 resolved)
 *   - commit 优先取 installResult 里的第一个已安装条目的 commit;
 *     若无 commit 则取 ref;若都没有则用 'unknown'
 *   - repo 取 installResult?.installed[0].source 或 skill 的 repo
 *
 * @param packName 套餐名(来自 PackManifest.name)
 * @param results  installPack 返回的 results 数组
 * @param skillRepoMap  name→repo 映射(来自 PackSkillRef 列表),兜底用
 */
export function buildPackLock(
  packName: string,
  results: PackSkillInstallResult[],
  skillRepoMap: Map<string, string>,
): PackLock {
  const resolved: PackLockEntry[] = [];

  for (const r of results) {
    if (r.action !== 'installed') continue;

    // 从 installResult 取 repo 和 commit
    const installed = r.installResult?.installed ?? [];
    const firstInstalled = installed[0];

    const repo =
      (firstInstalled as { source?: string } | undefined)?.source ??
      skillRepoMap.get(r.name) ??
      '';

    // 尝试从 lock.skills 里找 commit(installResult 里可能没有直接 commit 字段)
    // installResult.installed 是 SkillEntry[];SkillEntry 上有 commit 字段
    const commit =
      (firstInstalled as { commit?: string } | undefined)?.commit ??
      (firstInstalled as { ref?: string } | undefined)?.ref ??
      'unknown';

    resolved.push({ name: r.name, repo, commit });
  }

  return {
    version: 1,
    pack: packName,
    resolved,
    createdAt: new Date().toISOString(),
  };
}

// ── 校验 ────────────────────────────────────────────────────────────────────

/**
 * 结构校验:将原始值解析为 PackLock。
 * 不合法时抛 PackLockError。
 */
export function validatePackLock(raw: unknown, path = '<unknown>'): PackLock {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PackLockError('套餐 lock 文件根节点必须是 JSON 对象', path);
  }

  const obj = raw as Record<string, unknown>;

  if (obj.version !== 1) {
    throw new PackLockError(
      `套餐 lock 文件 version 必须是 1,实际值: ${JSON.stringify(obj.version)}`,
      path,
    );
  }

  if (typeof obj.pack !== 'string' || obj.pack.trim().length === 0) {
    throw new PackLockError('套餐 lock 文件 pack 必须是非空字符串', path);
  }

  if (!Array.isArray(obj.resolved)) {
    throw new PackLockError('套餐 lock 文件 resolved 必须是数组', path);
  }

  for (let i = 0; i < obj.resolved.length; i++) {
    const entry = (obj.resolved as unknown[])[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PackLockError(`套餐 lock 文件 resolved[${i}] 必须是对象`, path);
    }
    const e = entry as Record<string, unknown>;
    for (const key of ['name', 'repo', 'commit'] as const) {
      if (typeof e[key] !== 'string') {
        throw new PackLockError(
          `套餐 lock 文件 resolved[${i}].${key} 必须是字符串`,
          path,
        );
      }
    }
  }

  if (typeof obj.createdAt !== 'string' || obj.createdAt.trim().length === 0) {
    throw new PackLockError('套餐 lock 文件 createdAt 必须是非空字符串', path);
  }

  return obj as unknown as PackLock;
}

// ── 磁盘 I/O ─────────────────────────────────────────────────────────────────

/**
 * 从磁盘加载并校验 pack lock 文件。
 * - ENOENT → PackLockError
 * - 损坏 JSON → PackLockError
 * - 结构非法 → PackLockError
 */
export async function loadPackLock(filePath: string): Promise<PackLock> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new PackLockError(
      `无法读取套餐 lock 文件 ${filePath}: ${(error as Error).message}`,
      filePath,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PackLockError(
      `套餐 lock 文件 JSON 解析失败: ${(error as Error).message}`,
      filePath,
      { cause: error },
    );
  }

  return validatePackLock(parsed, filePath);
}

/**
 * 将 PackLock 写入磁盘。
 * 格式:pretty JSON(2 格缩进)+ 尾换行。
 */
export async function writePackLock(filePath: string, lock: PackLock): Promise<void> {
  const content = `${JSON.stringify(lock, null, 2)}\n`;
  await writeFile(filePath, content, 'utf8');
}

// ── 辅助:提取 commit Map ────────────────────────────────────────────────────

/**
 * 纯函数:从 PackLock 提取 name→commit Map。
 * 供 installPack 的 lockedCommits 选项消费,实现可复现安装。
 */
export function resolvedCommitsMap(lock: PackLock): Map<string, string> {
  const m = new Map<string, string>();
  for (const entry of lock.resolved) {
    if (entry.commit && entry.commit !== 'unknown') {
      m.set(entry.name, entry.commit);
    }
  }
  return m;
}
