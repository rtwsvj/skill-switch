// S3.3 install 编排(自写,方案 A):
//   解析来源 → (git 源)cloneRepo → 发现 skill 目录 → audit 拦截(S2.5 shouldBlock)
//   → 装前快照(S3.1)→ 铺设(copy/symlink)。
// 写 skills.lock 在 S3.4 接入。所有路径由调用方注入 home,本模块不读 homedir。
//
// 语义:
// - 拦截是 all-or-nothing:任一 skill 被 audit 拦下(且无 force)则什么都不装。
// - symlink 仅允许"本地目录源"(克隆出来的临时目录会被清理,symlink 过去就是悬空)。
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { cleanupTempDir, cloneRepo } from '../vendor/vercel-skills/git.ts';
import { auditSkillDir, shouldBlock } from '../cli/commands/audit.ts';
import type { AuditReport } from './audit/engine.ts';
import { snapshot } from './backup.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';

export type InstallMode = 'copy' | 'symlink';

export interface InstallOptions {
  home: string;
  agent: AgentType;
  mode: InstallMode;
  /** 只装指定目录名的 skill(缺省装来源里发现的全部) */
  skill?: string;
  /** 越过 audit 拦截 */
  force?: boolean;
}

export interface BlockedSkill {
  name: string;
  score: number;
  report: AuditReport;
}

export interface InstallResult {
  installed: Array<{ name: string; targetPath: string }>;
  blocked: BlockedSkill[];
  snapshotPath?: string;
}

const DISCOVER_MAX_DEPTH = 3;

/** 发现含 SKILL.md 的目录(含根自身),跳过 .git/node_modules。 */
export async function discoverSkillDirs(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (existsSync(join(dir, 'SKILL.md'))) {
      found.push(dir);
      return; // skill 目录不再下钻
    }
    if (depth >= DISCOVER_MAX_DEPTH) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  return found.sort();
}

function targetSkillsDir(home: string, agent: AgentType): string {
  const location = getAgentSkillsLocations().find((l) => l.agent === agent);
  if (!location) {
    throw new Error(`未知或无全局 skills 目录的 agent: ${agent}`);
  }
  return resolveGlobalSkillsDir(home, location);
}

async function isLocalDir(source: string): Promise<boolean> {
  try {
    return (await stat(source)).isDirectory();
  } catch {
    return false;
  }
}

export async function installFromSource(
  source: string,
  options: InstallOptions,
): Promise<InstallResult> {
  // 先解析 agent(失败要早于任何 clone/写动作)
  const skillsDir = targetSkillsDir(options.home, options.agent);

  const local = await isLocalDir(source);
  if (options.mode === 'symlink' && !local) {
    throw new Error('symlink 模式仅支持本地目录源:克隆的临时目录会被清理,symlink 会悬空');
  }

  const sourceRoot = local ? resolve(source) : await cloneRepo(source);
  try {
    let skillDirs = await discoverSkillDirs(sourceRoot);
    if (options.skill) {
      skillDirs = skillDirs.filter((d) => d.endsWith(`/${options.skill}`));
    }
    if (skillDirs.length === 0) {
      throw new Error(`来源中未发现 skill(含 SKILL.md 的目录): ${source}`);
    }

    // audit 拦截:all-or-nothing,任何写动作之前
    const blocked: BlockedSkill[] = [];
    if (!options.force) {
      for (const dir of skillDirs) {
        const report = await auditSkillDir(dir);
        if (shouldBlock(report)) {
          blocked.push({ name: dir.split('/').pop()!, score: report.score, report });
        }
      }
      if (blocked.length > 0) {
        return { installed: [], blocked };
      }
    }

    // 装前快照(目标目录已存在且非空才有内容可保)
    let snapshotPath: string | undefined;
    if (existsSync(skillsDir) && (await readdir(skillsDir)).length > 0) {
      const snap = await snapshot(skillsDir, {
        store: join(options.home, '.skill-switch', 'backups'),
        label: `pre-install-${options.agent}`,
      });
      snapshotPath = snap.path;
    }

    await mkdir(skillsDir, { recursive: true });
    const installed: InstallResult['installed'] = [];
    for (const dir of skillDirs) {
      const name = dir.split('/').pop()!;
      const target = join(skillsDir, name);
      await rm(target, { recursive: true, force: true });
      if (options.mode === 'symlink') {
        await symlink(dir, target, 'dir');
      } else {
        await cp(dir, target, { recursive: true });
      }
      installed.push({ name, targetPath: target });
    }
    return { installed, blocked: [], snapshotPath };
  } finally {
    if (!local) await cleanupTempDir(sourceRoot).catch(() => {});
  }
}
