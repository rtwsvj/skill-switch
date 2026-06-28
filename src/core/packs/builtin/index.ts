// 内置套餐注册表 — 供 CLI 通过 id 解析内置套餐路径
// P3-D6:改为 readdir 自动扫描目录下所有 *.pack.json,读取 displayName/description。
// 新增内置套餐只需在同目录新建 *.pack.json,无需改代码。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * 解析本目录(内置套餐 *.pack.json 所在)。
 * SEA 打包后 import.meta.url 不可用 → 返回 null(SEA sidecar 不附带这些数据文件,
 * 内置套餐功能在 SEA 下优雅降级为空,绝不在模块加载时崩掉整个 CLI)。
 */
function builtinDir(): string | null {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

/** 内置套餐描述(轻量:不加载完整 manifest) */
export interface BuiltinPackMeta {
  /** 稳定 id,也是 pack.json 的文件名主体 */
  id: string;
  /** 显示名 */
  displayName: string;
  /** 一句话描述 */
  description: string;
  /** 绝对路径(运行时计算) */
  path: string;
}

/**
 * 从 pack.json 文件读取 displayName/description。
 * 读取失败或字段缺失时返回 undefined(调用方跳过此文件)。
 */
function readPackMeta(filePath: string): { displayName: string; description: string } | undefined {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return undefined;
    const o = obj as Record<string, unknown>;
    const displayName = typeof o.displayName === 'string' ? o.displayName : '';
    const description = typeof o.description === 'string' ? o.description : '';
    // displayName 必填才算有效套餐
    if (!displayName) return undefined;
    return { displayName, description };
  } catch {
    return undefined;
  }
}

/**
 * 列出全部内置套餐(含绝对路径)。
 * 通过 readdir 扫描同目录下所有 *.pack.json,读取 displayName/description。
 * SEA 下 builtinDir() 返回 null 时优雅返回 []。
 */
export function listBuiltinPacks(): BuiltinPackMeta[] {
  const dir = builtinDir();
  if (dir === null) return [];

  let entries: string[];
  try {
    // 明确传 encoding:'utf8' 确保返回 string[] 而非 Buffer[]
    entries = readdirSync(dir, { encoding: 'utf8' });
  } catch {
    // 目录不可读(极端情况)时静默返回空
    return [];
  }

  const result: BuiltinPackMeta[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.pack.json')) continue;
    // id = 文件名去掉 .pack.json 后缀
    const id = entry.slice(0, -'.pack.json'.length);
    if (!id) continue;
    const filePath = join(dir, entry);
    const meta = readPackMeta(filePath);
    if (!meta) continue;
    result.push({ id, displayName: meta.displayName, description: meta.description, path: filePath });
  }

  // 按 id 字典序排序,保证确定性
  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

/**
 * 根据 id 查找内置套餐路径。
 * 找不到返回 null。
 */
export function resolveBuiltinPackPath(id: string): string | null {
  const dir = builtinDir();
  if (dir === null) return null;
  // 验证文件存在且可读(readPackMeta 会确认格式)
  const filePath = join(dir, `${id}.pack.json`);
  const meta = readPackMeta(filePath);
  if (!meta) return null;
  return filePath;
}

/**
 * 判断一个字符串是否是已知内置套餐 id。
 */
export function isBuiltinId(id: string): boolean {
  return resolveBuiltinPackPath(id) !== null;
}
