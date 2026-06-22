// S3.3 install 编排(自写,方案 A):
//   解析来源 → (git 源)cloneRepo → 发现 skill 目录 → audit 拦截(S2.5 shouldBlock)
//   → 装前快照(S3.1)→ 铺设(copy/symlink)。
// 写 skills.lock 在 S3.4 接入。所有路径由调用方注入 home,本模块不读 homedir。
//
// 语义:
// - 拦截是 all-or-nothing:任一 skill 被 audit 拦下(且无 force)则什么都不装。
// - symlink 仅允许"本地目录源"(克隆出来的临时目录会被清理,symlink 过去就是悬空)。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, symlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { cleanupTempDir, cloneRepo } from '../vendor/vercel-skills/git.ts';
import { computeSkillFolderHash } from '../vendor/vercel-skills/local-lock.ts';
import { auditSkillDir, shouldBlock } from '../cli/commands/audit.ts';
import type { AuditReport } from './audit/engine.ts';
import { snapshot } from './backup.ts';
import { getCliVersion, recordBypasses } from './bypass-ledger.ts';
import { assertSafeGitSource } from './git-safe.ts';
import { getSkillsLockPath, readSkillsLock, upsertLockEntries, type SkillsLockEntry } from './lock.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';
import { copyDirWithoutSymlinks } from './safe-copy.ts';
import { assertSafeSkillName, isCanonicalSkillName, isSafeSkillName } from './skill-name.ts';
import { getSkillsJsonPath, readDeclaration, upsertSkillDeclarations } from './sync.ts';

const execFileAsync = promisify(execFile);

export type InstallMode = 'copy' | 'symlink';

export interface InstallOptions {
  home: string;
  agent: AgentType;
  mode: InstallMode;
  /** 只装指定目录名的 skill(缺省装来源里发现的全部) */
  skill?: string;
  /** 越过 audit 拦截 */
  force?: boolean;
  /** force 时记入 bypass-ledger 的理由 */
  forceReason?: string;
  /** git 来源的 ref(分支/tag),透传给 clone 并写入 lock */
  ref?: string;
  /** 写进 lock 的来源标签(缺省用原始 source 字符串) */
  sourceLabel?: string;
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
  /** 本次写入的 skills.lock 路径(有安装动作才有) */
  lockPath?: string;
  /** 本次写入的 skills.json 声明路径(有安装动作才有) */
  declarationPath?: string;
}

const DISCOVER_MAX_DEPTH = 3;

/** 发现含 SKILL.md 的目录(含根自身),跳过 .git/node_modules。 */
export async function discoverSkillDirs(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (existsSync(join(dir, 'SKILL.md'))) {
      if (isSafeSkillName(basename(dir))) found.push(dir);
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

function durableCopySource(home: string, agent: AgentType, name: string): string {
  return join(home, '.skill-switch', 'store', agent, name);
}

async function localSourceKind(source: string): Promise<'directory' | 'non-directory' | 'missing'> {
  try {
    return (await stat(source)).isDirectory() ? 'directory' : 'non-directory';
  } catch {
    return 'missing';
  }
}

export function assertSafeCloneSource(source: string): void {
  assertSafeGitSource(source);
}

export async function installFromSource(
  source: string,
  options: InstallOptions,
): Promise<InstallResult> {
  // 先解析 agent(失败要早于任何 clone/写动作)
  const skillsDir = targetSkillsDir(options.home, options.agent);

  const sourceKind = await localSourceKind(source);
  if (sourceKind === 'non-directory') {
    throw new Error(`安装源不是目录: ${source}`);
  }
  const local = sourceKind === 'directory';
  if (options.skill !== undefined) {
    assertSafeSkillName(options.skill, 'install skill filter');
  }
  if (options.mode === 'symlink' && !local) {
    throw new Error('symlink 模式仅支持本地目录源:克隆的临时目录会被清理,symlink 会悬空');
  }

  if (!local) assertSafeCloneSource(source); // P1-1:clone 前拦下危险传输形式
  const sourceRoot = local ? resolve(source) : await cloneRepo(source, options.ref);
  try {
    let skillDirs = await discoverSkillDirs(sourceRoot);
    if (options.skill) {
      skillDirs = skillDirs.filter((d) => d.endsWith(`/${options.skill}`));
    }
    if (skillDirs.length === 0) {
      throw new Error(`来源中未发现 skill(含 SKILL.md 的目录): ${source}`);
    }

    // audit 拦截:all-or-nothing,任何写动作之前。force 时仍审计,以便记录"被越过了什么"。
    const blocked: BlockedSkill[] = [];
    const bypassed: BlockedSkill[] = [];
    for (const dir of skillDirs) {
      const report = await auditSkillDir(dir);
      if (!shouldBlock(report)) continue;
      const entry = { name: basename(dir), score: report.score, report };
      if (options.force) bypassed.push(entry);
      else blocked.push(entry);
    }
    if (!options.force && blocked.length > 0) {
      return { installed: [], blocked };
    }

    // 新安装的 skill 名必须符合规范命名(在任何写动作前,保证 all-or-nothing)。
    // 既有 legacy 名不在此硬拒——由 doctor 给迁移告警(remove/toggle/sync 仍可操作)。
    for (const dir of skillDirs) {
      const name = basename(dir);
      if (!isCanonicalSkillName(name)) {
        throw new Error(
          `skill 名不符合规范命名(仅字母数字与 . _ -,首字符字母数字,长度≤80): ${name}`,
        );
      }
    }

    // R30:在任何写动作前先校验状态文件可读(损坏即 fail-fast),保证 all-or-nothing。
    // upsertLockEntries / upsertSkillDeclarations 在收尾才读这两个文件——若其中一个损坏,
    // 会在 skill 已拷贝到磁盘之后才抛错,留下「磁盘已写、lock/声明未更新」的撕裂态。
    // 这里提前用同样的 reader 预检:缺文件返回默认(首次安装不受影响),仅损坏才抛 StateFileError。
    const lockPath = getSkillsLockPath(options.home);
    const declarationPath = getSkillsJsonPath(options.home);
    await readSkillsLock(lockPath);
    await readDeclaration(declarationPath);

    // 装前快照(目标目录已存在且非空才有内容可保)
    let snapshotPath: string | undefined;
    if (existsSync(skillsDir) && (await readdir(skillsDir)).length > 0) {
      const snap = await snapshot(skillsDir, {
        store: join(options.home, '.skill-switch', 'backups'),
        label: `pre-install-${options.agent}`,
      });
      snapshotPath = snap.path;
    }

    // git 来源:记录 clone 到的精确 commit(S3.4,agent-skills-cli 的字段设计)
    let commit: string | undefined;
    if (!local) {
      const { stdout } = await execFileAsync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD']);
      commit = stdout.trim();
    }

    await mkdir(skillsDir, { recursive: true });
    const installed: InstallResult['installed'] = [];
    const lockEntries: SkillsLockEntry[] = [];
    const declarationAdditions: Parameters<typeof upsertSkillDeclarations>[1] = [];
    for (const dir of skillDirs) {
      const name = basename(dir);
      assertSafeSkillName(name, 'discovered skill name');
      const target = join(skillsDir, name);
      const declarationSource =
        options.mode === 'copy' ? durableCopySource(options.home, options.agent, name) : dir;

      if (options.mode === 'copy' && resolve(dir) !== resolve(declarationSource)) {
        await rm(declarationSource, { recursive: true, force: true });
        await copyDirWithoutSymlinks(dir, declarationSource);
      }

      await rm(target, { recursive: true, force: true });
      if (options.mode === 'symlink') {
        await symlink(dir, target, 'dir');
      } else {
        await copyDirWithoutSymlinks(declarationSource, target);
      }
      installed.push({ name, targetPath: target });
      declarationAdditions.push({
        name,
        agent: options.agent,
        source: declarationSource,
        mode: options.mode,
      });
      lockEntries.push({
        name,
        agent: options.agent,
        source: options.sourceLabel ?? source,
        sourceType: local ? 'local' : 'git',
        ...(options.ref ? { ref: options.ref } : {}),
        ...(commit ? { commit } : {}),
        sha256: await computeSkillFolderHash(target),
        mode: options.mode,
      });
    }

    // lockPath / declarationPath 已在写盘前声明并预校验(见上方 fail-fast 块)。
    await upsertLockEntries(lockPath, lockEntries);
    await upsertSkillDeclarations(declarationPath, declarationAdditions);

    // force 越过 audit 的留痕:记录被越过的 skill + 命中的 findings + 理由 + 版本。
    if (options.force && bypassed.length > 0) {
      const bypassedAt = new Date().toISOString();
      const cliVersion = await getCliVersion();
      await recordBypasses(
        options.home,
        bypassed.map((b) => ({
          name: b.name,
          agent: options.agent,
          auditBypassed: true as const,
          bypassedAt,
          ...(options.forceReason ? { bypassReason: options.forceReason } : {}),
          score: b.score,
          bypassedFindings: b.report.findings.map((f) => ({ ruleId: f.ruleId, severity: f.severity })),
          cliVersion,
        })),
      );
    }

    return { installed, blocked: [], snapshotPath, lockPath, declarationPath };
  } finally {
    if (!local) await cleanupTempDir(sourceRoot).catch(() => {});
  }
}
