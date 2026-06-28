// S6.1 doctor 核心:声明(skills.json)vs 锁(skills.lock)vs 磁盘 的三方对账。纯读。
// 四类漂移:
//   missing       声明 enabled 但磁盘上没有(缺装)
//   content-drift 声明+磁盘+锁都在,但磁盘内容哈希 ≠ 锁内 sha256(被改动)
//   stale-lock    声明 enabled 且磁盘在位,但锁里没有条目(锁过期/绕过 install 装的)
//   extra-locked  锁里有条目但声明完全不认识它(孤儿锁/该卸载没卸载)
// 这是 skills.lock 价值兑现点:S6.2 包成 doctor --ci 进流水线。
//
// P3-D5:--fix 漂移自修复。按 kind 映射修复动作,写操作前先快照。
//   missing       → 提示用户跑 sync/install(缺来源,无法自动从 store 重铺)
//   content-drift → 从声明的 source 重铺(copyDirWithoutSymlinks / symlink)
//   stale-lock    → 提示:磁盘已在位但锁缺条目,需用户跑 install 重建锁
//   extra-locked  → removeLockEntries 清除孤儿锁条目
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { computeSkillFolderHash } from '../vendor/vercel-skills/local-lock.ts';
import {
  readDoctorHashCache,
  resolveFolderHash,
  writeDoctorHashCache,
  type DoctorHashCacheFile,
} from './doctor-hash-cache.ts';
import { readBypassLedger, type BypassRecord } from './bypass-ledger.ts';
import { getSkillsLockPath, readSkillsLock, removeLockEntries } from './lock.ts';
import { isCanonicalSkillName } from './skill-name.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';
import {
  getSkillsJsonPath,
  readDeclaration,
  type SkillAgentSource,
  type SkillDeclaration,
  type SkillsDeclarationFile,
} from './sync.ts';
import { copyDirWithoutSymlinks } from './safe-copy.ts';
import { snapshot } from './backup.ts';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { auditConfigFiles, type ConfigFileResult } from './audit/config-discovery.ts';

export type DriftKind = 'missing' | 'content-drift' | 'stale-lock' | 'extra-locked';

export interface DriftFinding {
  kind: DriftKind;
  agent: AgentType;
  name: string;
  target?: string;
  detail: string;
}

export interface DoctorDeclaration {
  name: string;
  source: string;
  agents: AgentType[];
  enabled: boolean;
  mode: 'symlink' | 'copy';
  agentSources?: Partial<Record<AgentType, SkillAgentSource>>;
}

export interface DoctorReport {
  findings: DriftFinding[];
  clean: boolean;
  checked: { declared: number; locked: number };
  declarations: DoctorDeclaration[];
  /** M0-5.8:force 越过 audit 的留痕(警示用,不影响 clean——clean 只表三方一致)。 */
  bypasses: BypassRecord[];
  /** M0-5.9:声明里不符合规范命名的 legacy skill 名(迁移告警用,不影响 clean,不硬拒)。 */
  legacyNames: string[];
  /**
   * R20-b:home 下各 agent 配置文件的安全扫描结果(advisory,不影响 clean 与退出码)。
   * 与 `audit --configs` 返回相同的 ConfigFileResult[] 形态。
   */
  configAudit: ConfigFileResult[];
}

export type FixStatus = 'fixed' | 'skipped' | 'manual';

export interface FixResult {
  kind: DriftKind;
  agent: AgentType;
  name: string;
  status: FixStatus;
  detail: string;
}

export interface DoctorFixReport {
  /** 修复执行前产生的快照路径(每个被修改的 agent 目录各一个) */
  snapshotPaths: string[];
  fixes: FixResult[];
}

function skillsDirFor(home: string, agent: AgentType): string | undefined {
  const location = getAgentSkillsLocations().find((l) => l.agent === agent);
  return location ? resolveGlobalSkillsDir(home, location) : undefined;
}

/** 从声明中获取某 agent 下某 skill 的来源路径(绝对或相对 home)→ 绝对路径。 */
function sourceAbsForFix(home: string, declaration: SkillsDeclarationFile, name: string, agent: AgentType): string | undefined {
  const skill = declaration.skills.find((s) => s.name === name);
  if (!skill) return undefined;
  const agentSrc = skill.agentSources?.[agent];
  const src = agentSrc?.source ?? skill.source;
  return isAbsolute(src) ? src : join(home, src);
}

/**
 * P3-D5:对已有漂移 findings 执行自修复。
 * 写操作前先对涉及的 agent 目录快照(store = ~/.skill-switch/backups)。
 * - content-drift → rm 目标,重铺 source(copy 或 symlink)
 * - extra-locked  → removeLockEntries 清除孤儿锁条目
 * - missing / stale-lock → 只汇报"需手动",不写磁盘
 */
export async function fixFindings(
  home: string,
  findings: DriftFinding[],
  declaration: SkillsDeclarationFile,
): Promise<DoctorFixReport> {
  const store = join(home, '.skill-switch', 'backups');
  const snapshotPaths: string[] = [];
  const fixes: FixResult[] = [];

  // 先对所有需要写磁盘的 agent 目录做快照(每个 agent 只一次)
  const agentsToSnapshot = new Set<AgentType>();
  for (const f of findings) {
    if (f.kind === 'content-drift') agentsToSnapshot.add(f.agent);
  }

  for (const agent of agentsToSnapshot) {
    const dir = skillsDirFor(home, agent);
    if (dir && existsSync(dir)) {
      try {
        const snap = await snapshot(dir, { store, label: 'pre-fix' });
        snapshotPaths.push(snap.path);
      } catch {
        // 快照失败不阻断修复(目录为空/不存在时 snapshot 抛错);继续
      }
    }
  }

  // 处理 extra-locked:收集需要删除的锁条目
  const lockKeysToRemove: Array<{ name: string; agent: AgentType }> = [];
  for (const f of findings) {
    if (f.kind === 'extra-locked') {
      lockKeysToRemove.push({ name: f.name, agent: f.agent });
    }
  }
  if (lockKeysToRemove.length > 0) {
    const lockPath = getSkillsLockPath(home);
    await removeLockEntries(lockPath, lockKeysToRemove);
  }

  // 逐条处理 findings
  for (const f of findings) {
    if (f.kind === 'missing') {
      fixes.push({
        kind: f.kind, agent: f.agent, name: f.name,
        status: 'manual',
        detail: '无法自动修复 missing(需要运行 skill-switch sync 或 install 从源重铺)',
      });
      continue;
    }

    if (f.kind === 'stale-lock') {
      fixes.push({
        kind: f.kind, agent: f.agent, name: f.name,
        status: 'manual',
        detail: '磁盘已在位但锁缺条目;运行 skill-switch install 重建锁条目',
      });
      continue;
    }

    if (f.kind === 'extra-locked') {
      fixes.push({
        kind: f.kind, agent: f.agent, name: f.name,
        status: 'fixed',
        detail: `已从 skills.lock 移除孤儿条目 ${f.agent}/${f.name}`,
      });
      continue;
    }

    if (f.kind === 'content-drift') {
      const target = f.target;
      if (!target) {
        fixes.push({ kind: f.kind, agent: f.agent, name: f.name, status: 'skipped', detail: '缺少 target 路径,跳过' });
        continue;
      }
      const sourceAbs = sourceAbsForFix(home, declaration, f.name, f.agent);
      if (!sourceAbs || !existsSync(sourceAbs)) {
        fixes.push({ kind: f.kind, agent: f.agent, name: f.name, status: 'skipped', detail: `声明来源不存在,跳过: ${sourceAbs ?? '未知'}` });
        continue;
      }

      // 确定模式(symlink 还是 copy)
      const skill = declaration.skills.find((s) => s.name === f.name);
      const agentSrc = skill?.agentSources?.[f.agent];
      const mode = agentSrc?.mode ?? skill?.mode ?? 'copy';

      try {
        await rm(target, { recursive: true, force: true });
        if (mode === 'symlink') {
          const { symlink: symlinkFn, mkdir: mkdirFn } = await import('node:fs/promises');
          await mkdirFn(join(target, '..'), { recursive: true });
          await symlinkFn(sourceAbs, target, 'dir');
        } else {
          await copyDirWithoutSymlinks(sourceAbs, target);
        }
        fixes.push({ kind: f.kind, agent: f.agent, name: f.name, status: 'fixed', detail: `已从 ${sourceAbs} 重铺(${mode})` });
      } catch (err) {
        fixes.push({ kind: f.kind, agent: f.agent, name: f.name, status: 'skipped', detail: `重铺失败: ${(err as Error).message}` });
      }
    }
  }

  return { snapshotPaths, fixes };
}

function summarizeDeclaration(skill: SkillDeclaration): DoctorDeclaration {
  return {
    name: skill.name,
    source: skill.source,
    agents: [...skill.agents],
    enabled: skill.enabled,
    mode: skill.mode,
    ...(skill.agentSources ? { agentSources: structuredClone(skill.agentSources) } : {}),
  };
}

export async function runDoctor(home: string): Promise<DoctorReport> {
  const declaration = await readDeclaration(getSkillsJsonPath(home));
  const lock = await readSkillsLock(getSkillsLockPath(home));
  const lockByKey = new Map(lock.skills.map((e) => [`${e.agent}|${e.name}`, e]));
  const findings: DriftFinding[] = [];

  let declaredPairs = 0;
  const declaredKeys = new Set<string>();

  // P2-1:文件夹哈希缓存(纯优化)。读缓存失败 → 当空,绝不阻断 doctor。
  // cacheUsable 标记本次是否还应继续走/落盘缓存:任一 stat-签名计算或缓存命中逻辑出意外,
  // 立即整体退回"现算 computeSkillFolderHash",并放弃落盘(避免写入半残/可疑缓存)。
  const hashCache: DoctorHashCacheFile = await readDoctorHashCache(home);
  let cacheUsable = true;

  for (const skill of declaration.skills) {
    for (const agent of skill.agents) {
      declaredKeys.add(`${agent}|${skill.name}`);
      if (!skill.enabled) continue; // disabled 的在位与否是 sync 的事,不算缺装
      declaredPairs += 1;

      const skillsDir = skillsDirFor(home, agent);
      if (!skillsDir) continue;
      const target = join(skillsDir, skill.name);

      if (!existsSync(target)) {
        findings.push({
          kind: 'missing', agent, name: skill.name, target,
          detail: '声明为 enabled 但磁盘上不存在(跑 sync 或 install 修复)',
        });
        continue;
      }

      const entry = lockByKey.get(`${agent}|${skill.name}`);
      if (!entry) {
        findings.push({
          kind: 'stale-lock', agent, name: skill.name, target,
          detail: '磁盘在位但 skills.lock 无条目(锁过期或绕过 install 安装)',
        });
        continue;
      }

      // 哈希经缓存解析:stat 签名命中则复用旧 sha256,否则现算并记入缓存。
      // 任一环节出错 → 退回直接现算,并禁用缓存落盘(纯优化,正确性不变)。
      let actual: string;
      if (cacheUsable) {
        try {
          actual = await resolveFolderHash(hashCache, target);
        } catch {
          cacheUsable = false;
          actual = await computeSkillFolderHash(target);
        }
      } else {
        actual = await computeSkillFolderHash(target);
      }
      if (actual !== entry.sha256) {
        findings.push({
          kind: 'content-drift', agent, name: skill.name, target,
          detail: `磁盘内容哈希 ${actual.slice(0, 12)}… ≠ 锁内 ${entry.sha256.slice(0, 12)}…(被本地改动或上游覆盖)`,
        });
      }
    }
  }

  for (const entry of lock.skills) {
    if (!declaredKeys.has(`${entry.agent}|${entry.name}`)) {
      findings.push({
        kind: 'extra-locked', agent: entry.agent, name: entry.name,
        detail: '锁内条目不在声明中(孤儿锁:声明它,或卸载并清锁)',
      });
    }
  }

  const bypasses = (await readBypassLedger(home)).bypasses;
  const legacyNames = declaration.skills
    .map((s) => s.name)
    .filter((name) => !isCanonicalSkillName(name));

  // P2-1:单次原子落盘更新后的缓存。写失败一律吞掉 —— 纯优化,绝不影响 doctor 结果。
  if (cacheUsable) {
    try {
      await writeDoctorHashCache(home, hashCache);
    } catch {
      // 缓存落盘失败:下次重算即可,不报错、不改变本次结论。
    }
  }

  // R20-b:配置文件安全扫描(advisory)。失败一律吞掉,绝不影响三方对账结论与退出码。
  let configAudit: ConfigFileResult[] = [];
  try {
    configAudit = await auditConfigFiles(home);
  } catch {
    // 配置扫描失败:advisory 段落,不报错、不改变本次结论。
  }

  return {
    findings,
    clean: findings.length === 0,
    checked: { declared: declaredPairs, locked: lock.skills.length },
    declarations: declaration.skills.map(summarizeDeclaration),
    bypasses,
    legacyNames,
    configAudit,
  };
}
