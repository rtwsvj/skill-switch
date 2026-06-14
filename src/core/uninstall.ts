// uninstall:移除 skill-switch 自身足迹 —— <home>/.skill-switch 状态目录、
// 已安装的 macOS App、PATH 上的 CLI 软链。可选 --purge-skills 连同声明里的
// 各 skill 一并拆除(逐个先快照,复用 remove 原语)。
//
// 安全纪律:只动三类既定目标 —— <home>/.skill-switch、basename 恰为
// skill-switch.app 的 App、确为指向 skill-switch 的软链。purge 只碰声明里
// 列出的 skill。App/软链路径由调用方解析后注入,核心只在校验通过后删除,
// 便于测试用假路径、绝不触碰真实 /Applications。
import { lstat, readlink, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { removeSkill, type RemoveResult } from './remove.ts';
import { getSkillsJsonPath, readDeclaration } from './sync.ts';

const APP_BASENAME = 'skill-switch.app';
const BIN_LINK_TARGET = /skill-switch-cli|skill-switch\.mjs/;

export interface UninstallInput {
  home: string;
  purgeSkills: boolean;
  dryRun: boolean;
  /** 调用方解析的 App 路径(默认 /Applications/skill-switch.app);null=不动 App。 */
  appPath: string | null;
  /** 调用方在 PATH 上探测到的 skill-switch 软链;null=不动链接。 */
  binLinkPath: string | null;
}

export interface PurgeTarget {
  name: string;
  agent: AgentType;
}

export interface UninstallPlan {
  skillSwitchDir: string;
  skillSwitchDirExists: boolean;
  /** 仅当存在且 basename 恰为 skill-switch.app 时非空。 */
  appPath: string | null;
  /** 仅当确为指向 skill-switch 的软链时非空。 */
  binLinkPath: string | null;
  purgeTargets: PurgeTarget[];
}

export interface UninstallResult {
  dryRun: boolean;
  plan: UninstallPlan;
  removedSkillSwitchDir: boolean;
  removedApp: boolean;
  removedBinLink: boolean;
  purged: RemoveResult[];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** App 只有在「存在 + basename 恰为 skill-switch.app」时才算可删目标。 */
async function resolveAppTarget(appPath: string | null): Promise<string | null> {
  if (!appPath || basename(appPath) !== APP_BASENAME) return null;
  return (await pathExists(appPath)) ? appPath : null;
}

/** 软链只有在「是 symlink + 指向 skill-switch-cli / skill-switch.mjs」时才算可删目标。 */
async function resolveBinTarget(binLinkPath: string | null): Promise<string | null> {
  if (!binLinkPath) return null;
  let stat;
  try {
    stat = await lstat(binLinkPath);
  } catch {
    return null;
  }
  if (!stat.isSymbolicLink()) return null;
  let target: string;
  try {
    target = await readlink(binLinkPath);
  } catch {
    return null;
  }
  return BIN_LINK_TARGET.test(target) ? binLinkPath : null;
}

export async function planUninstall(input: UninstallInput): Promise<UninstallPlan> {
  const skillSwitchDir = join(input.home, '.skill-switch');

  const purgeTargets: PurgeTarget[] = [];
  if (input.purgeSkills) {
    const declaration = await readDeclaration(getSkillsJsonPath(input.home));
    for (const skill of declaration.skills) {
      for (const agent of skill.agents) {
        purgeTargets.push({ name: skill.name, agent });
      }
    }
  }

  return {
    skillSwitchDir,
    skillSwitchDirExists: await pathExists(skillSwitchDir),
    appPath: await resolveAppTarget(input.appPath),
    binLinkPath: await resolveBinTarget(input.binLinkPath),
    purgeTargets,
  };
}

export async function uninstall(input: UninstallInput): Promise<UninstallResult> {
  const plan = await planUninstall(input);
  const result: UninstallResult = {
    dryRun: input.dryRun,
    plan,
    removedSkillSwitchDir: false,
    removedApp: false,
    removedBinLink: false,
    purged: [],
  };

  if (input.dryRun) return result;

  // 1) 可选:逐个拆除声明里的 skill(removeSkill 各自先拍快照)
  for (const target of plan.purgeTargets) {
    result.purged.push(await removeSkill(input.home, target.name, target.agent));
  }

  // 2) 删整个状态目录(声明 / 锁 / store / backups)
  if (plan.skillSwitchDirExists) {
    await rm(plan.skillSwitchDir, { recursive: true, force: true });
    result.removedSkillSwitchDir = true;
  }

  // 3) 删 App(已在 plan 阶段校验 basename + 存在)
  if (plan.appPath) {
    await rm(plan.appPath, { recursive: true, force: true });
    result.removedApp = true;
  }

  // 4) 删 CLI 软链(已在 plan 阶段校验是指向 skill-switch 的软链)
  if (plan.binLinkPath) {
    await rm(plan.binLinkPath, { force: true });
    result.removedBinLink = true;
  }

  return result;
}
