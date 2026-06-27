// 套餐安装编排(install-pack.ts)
// 职责:
//   - resolvePackSkills    — 纯函数:展开 extends 继承链,去重合并产出完整 skill 列表
//   - buildInstallPlan     — 纯函数:把 skill 列表分成「有来源可装」vs「跳过」两组
//   - installPack          — 编排:逐 skill 调用 installFromSource(不改 install.ts)
//   - enrichManifestSkills — 纯函数:从 SkillsLockFile 回填每个 skill 的 repo/commit/ref
//
// 无新依赖。不碰 install.ts、lock.ts、pack-model.ts 内部实现。

import type { AgentType } from '../../vendor/vercel-skills/types.ts';
import { installFromSource, type InstallMode, type InstallResult } from '../install.ts';
import type { PackManifest, PackSkillRef } from './types.ts';
import type { SkillsLockFile } from '../lock.ts';

// ── 1. resolvePackSkills ─────────────────────────────────────────────────────

/**
 * 纯函数:展开 extends 继承链,去重合并产出完整 skill 列表。
 *
 * 规则:
 *   - manifest.extends 是父清单路径(字符串)数组,按声明顺序解析
 *   - 父清单的 skills 排在前面;子清单的同名 skill 覆盖父(子优先)
 *   - 循环引用:同一路径第二次出现时跳过(visited 集合防止死循环)
 *   - loadParent 由调用方注入(便于测试 mock)
 *
 * @param manifest  当前清单(可含 extends)
 * @param loadParent 异步加载父清单的函数(path → PackManifest)
 * @param visited   已访问路径集合(防止循环引用),调用方通常传 undefined 让函数自建
 * @returns 去重后的有序 PackSkillRef 列表(父在前,子覆盖)
 */
export async function resolvePackSkills(
  manifest: PackManifest,
  loadParent: (path: string) => Promise<PackManifest>,
  visited: Set<string> = new Set(),
): Promise<PackSkillRef[]> {
  const ext = manifest.extends;

  // 用 Map 按 name 去重,先插入 = 先出现;子 skill 覆盖父(后 set 覆盖)
  const byName = new Map<string, PackSkillRef>();

  // 先展开父清单(按 extends 顺序)
  if (Array.isArray(ext)) {
    for (const parentPath of ext) {
      if (visited.has(parentPath)) continue; // 循环引用保护
      visited.add(parentPath);
      let parentManifest: PackManifest;
      try {
        parentManifest = await loadParent(parentPath);
      } catch {
        // 父清单读取失败:记录到控制台并跳过(不阻断当前清单安装)
        console.warn(`[packs extends] 跳过无法加载的父清单: ${parentPath}`);
        continue;
      }
      const parentSkills = await resolvePackSkills(parentManifest, loadParent, visited);
      for (const s of parentSkills) {
        byName.set(s.name, s);
      }
    }
  }

  // 子清单的 skills 覆盖父(子优先)
  for (const s of manifest.skills) {
    byName.set(s.name, s);
  }

  return [...byName.values()];
}

// ── 2. buildInstallPlan ───────────────────────────────────────────────────────

/** 单个 skill 的安装计划条目 */
export interface InstallPlanEntry {
  skill: PackSkillRef;
  /** 有 repo 来源 → 'install';否则 → 'skip' */
  action: 'install' | 'skip';
  /** action='skip' 时的跳过原因(人类可读) */
  skipReason?: string;
}

/**
 * 纯函数:把 skill 列表分成「有来源可装」vs「跳过」两组。
 *
 * 判定逻辑:
 *   - skill.repo 存在(非空字符串)→ action='install'
 *   - 否则 → action='skip',附原因提示(引导用户跑 `packs save --enrich`)
 */
export function buildInstallPlan(skills: PackSkillRef[]): InstallPlanEntry[] {
  return skills.map((skill) => {
    if (typeof skill.repo === 'string' && skill.repo.trim().length > 0) {
      return { skill, action: 'install' };
    }
    return {
      skill,
      action: 'skip',
      skipReason: '无来源信息——发现的套餐需先补充来源,运行 `packs save --enrich` 回填',
    };
  });
}

// ── 3. installPack ────────────────────────────────────────────────────────────

/** packs install 的选项 */
export interface InstallPackOptions {
  home: string;
  agent: AgentType;
  mode: InstallMode;
  /** true 时只打印计划,不写任何文件 */
  dryRun?: boolean;
}

/** packs install 单个 skill 的结果 */
export interface PackSkillInstallResult {
  name: string;
  action: 'installed' | 'skipped' | 'blocked' | 'error';
  /** action='skipped' 时的原因 */
  skipReason?: string;
  /** action='installed' 时 installFromSource 的完整结果 */
  installResult?: InstallResult;
  /** action='error' 时的错误消息 */
  error?: string;
}

/** packs install 整体结果 */
export interface InstallPackResult {
  /** dry-run 模式时为 true */
  dryRun: boolean;
  plan: InstallPlanEntry[];
  results: PackSkillInstallResult[];
}

/**
 * 编排安装:逐 skill 调用 installFromSource。
 *
 * 安全:
 *   - 每个 skill 独立 audit(installFromSource 内部已做 all-or-nothing)
 *   - blocked 的 skill 记录到结果,不中断其他 skill 的安装
 *   - dryRun=true 时只返回计划,不写任何文件
 *
 * @param manifest  已加载并校验过的套餐清单
 * @param options   安装选项
 * @param loadParent 注入给 resolvePackSkills 的父清单加载函数(默认 loadPackManifest)
 */
export async function installPack(
  manifest: PackManifest,
  options: InstallPackOptions,
  loadParent?: (path: string) => Promise<PackManifest>,
): Promise<InstallPackResult> {
  // 懒加载 loadPackManifest 避免循环依赖(pack-model 不依赖本模块)
  const { loadPackManifest } = await import('./pack-model.ts');
  const resolvedLoadParent = loadParent ?? loadPackManifest;

  // 1. 展开 extends 继承链
  const resolvedSkills = await resolvePackSkills(manifest, resolvedLoadParent);

  // 2. 构建安装计划
  const plan = buildInstallPlan(resolvedSkills);

  if (options.dryRun) {
    // dry-run:只返回计划
    return { dryRun: true, plan, results: [] };
  }

  // 3. 逐 skill 安装
  const results: PackSkillInstallResult[] = [];

  for (const entry of plan) {
    if (entry.action === 'skip') {
      results.push({
        name: entry.skill.name,
        action: 'skipped',
        skipReason: entry.skipReason,
      });
      continue;
    }

    // action === 'install'
    const source = entry.skill.repo!;
    try {
      const installResult = await installFromSource(source, {
        home: options.home,
        agent: options.agent,
        mode: options.mode,
        skill: entry.skill.name,
        ref: entry.skill.ref,
      });

      if (installResult.blocked.length > 0) {
        results.push({
          name: entry.skill.name,
          action: 'blocked',
          installResult,
        });
      } else {
        results.push({
          name: entry.skill.name,
          action: 'installed',
          installResult,
        });
      }
    } catch (err) {
      results.push({
        name: entry.skill.name,
        action: 'error',
        error: (err as Error).message,
      });
    }
  }

  return { dryRun: false, plan, results };
}

// ── 4. enrichManifestSkills ──────────────────────────────────────────────────

/**
 * 纯函数:从 SkillsLockFile 回填每个 skill 的 repo/commit/ref。
 *
 * 逻辑:
 *   - 遍历 manifest.skills,按 name 在 lock.skills 里查找 agent 对应条目
 *   - 找到且 entry.sourceType==='git' 时,补充 repo/commit/ref
 *   - 找不到或非 git 来源:保持原字段不变,记录到 notFound 列表
 *
 * @param manifest    原始套餐清单
 * @param lock        skills.lock.json 内容(只读,不写)
 * @param agent       要查找的 agent(lock 按 agent 分组)
 * @returns 回填后的 PackSkillRef 列表 + 未找到的 skill 名列表
 */
export function enrichManifestSkills(
  manifest: PackManifest,
  lock: SkillsLockFile,
  agent: AgentType,
): { enriched: PackSkillRef[]; notFound: string[] } {
  const notFound: string[] = [];

  const enriched = manifest.skills.map((skill): PackSkillRef => {
    // 按 (agent, name) 查 lock
    const entry = lock.skills.find(
      (e) => e.name === skill.name && e.agent === agent,
    );

    if (!entry || entry.sourceType !== 'git') {
      notFound.push(skill.name);
      return skill; // 保持原样
    }

    // 有 git 来源:回填
    const ref: PackSkillRef = {
      name: skill.name,
      repo: entry.source,
    };
    if (entry.commit) ref.commit = entry.commit;
    if (entry.ref) ref.ref = entry.ref;
    return ref;
  });

  return { enriched, notFound };
}
