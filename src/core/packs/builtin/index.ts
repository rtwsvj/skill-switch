// 内置套餐注册表 — 供 CLI 通过 id 解析内置套餐路径
// 新增内置套餐时:在此文件添加条目,并在同目录新建对应 *.pack.json。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

/** 全部内置套餐 id 列表(须与目录下 *.pack.json 对应) */
const BUILTIN_ENTRIES: Array<Omit<BuiltinPackMeta, 'path'>> = [
  {
    id: 'security-review',
    displayName: '安全审查套餐',
    description: '代码安全审查工作流:静态分析 + 依赖漏洞扫描 + 密钥泄露检测',
  },
  {
    id: 'tdd-workflow',
    displayName: 'TDD 工作流套餐',
    description: '测试驱动开发:先写测试、再实现、再简化,结合代码审查保证质量',
  },
  {
    id: 'team-onboarding',
    displayName: '团队上手套餐',
    description: '新人或跨机迁移必备:代码库探索 + 项目初始化 + 文档生成',
  },
];

/**
 * 列出全部内置套餐(含绝对路径)。
 */
export function listBuiltinPacks(): BuiltinPackMeta[] {
  return BUILTIN_ENTRIES.map((e) => ({
    ...e,
    path: join(__dirname, `${e.id}.pack.json`),
  }));
}

/**
 * 根据 id 查找内置套餐路径。
 * 找不到返回 null。
 */
export function resolveBuiltinPackPath(id: string): string | null {
  const entry = BUILTIN_ENTRIES.find((e) => e.id === id);
  if (!entry) return null;
  return join(__dirname, `${entry.id}.pack.json`);
}

/**
 * 判断一个字符串是否是已知内置套餐 id。
 */
export function isBuiltinId(id: string): boolean {
  return BUILTIN_ENTRIES.some((e) => e.id === id);
}
