// S4.1 声明驱动 sync 引擎(思路参考 skills-manager 的 scenario+sync,TS 自写):
//   skills.json 声明"哪些 skill 应出现在哪些 agent 的全局目录"——
//   enabled=true 保证在位且与源一致(symlink 指向/copy 内容哈希),
//   enabled=false 移除,未声明的目录一律不碰(用户手装的东西不是 sync 的管辖)。
// 幂等:对账式 plan→apply,二跑全 noop。Codex config.toml 原生开关在 S4.2 特例接入。
//
// P3-D5:plan artifact 持久化(对标 Terraform plan -out)。
//   sync plan --out <file>  把 planSync 结果 + 声明 sha256 摘要 + 时间戳序列化写盘。
//   sync apply --plan <file> 读回后校验声明文件 sha256 未变,变则拒绝提示重 plan。
//
// WAL:journal 只接带锁入口 applySync;applySyncUnlocked 被 toggle 等复用,内部不动,
// 避免嵌套两份 journal。
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { computeSkillFolderHash } from '../vendor/vercel-skills/local-lock.ts';
import { snapshotAgents } from './agent-snapshots.ts';
import {
  getCodexConfigPath,
  readCodexSkillEnabled,
  setCodexSkillEnabled,
} from './codex-toggle.ts';
import {
  beginJournal,
  captureFileState,
  walSnapshotsForAgents,
  recoverPendingJournal,
  type JournalManagedTarget,
  type JournalPreState,
} from './journal.ts';
import { getSkillsLockPath } from './lock.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';
import { withOperationLock } from './operation-lock.ts';
import { copyDirWithoutSymlinks } from './safe-copy.ts';
import { assertSafeSkillName } from './skill-name.ts';
import { readJsonState, StateFileError, writeJsonState } from './state-io.ts';

export interface SkillDeclaration {
  name: string;
  /** skill 内容目录(绝对路径,或相对 home) */
  source: string;
  agents: AgentType[];
  enabled: boolean;
  mode: 'symlink' | 'copy';
  /** F3:按 agent 覆盖 source/mode;未声明时回退到顶层 source/mode。 */
  agentSources?: Partial<Record<AgentType, SkillAgentSource>>;
}

export interface SkillAgentSource {
  source: string;
  mode: 'symlink' | 'copy';
}

export interface SkillsDeclarationFile {
  version: 1;
  skills: SkillDeclaration[];
}

export interface SyncAction {
  // config-disable/config-enable 为 Codex 专用:开关走 config.toml 原生机制,文件不动
  kind: 'create' | 'replace' | 'remove' | 'noop' | 'config-disable' | 'config-enable';
  agent: AgentType;
  name: string;
  target: string;
  reason?: string;
}

export function getSkillsJsonPath(home: string): string {
  return join(home, '.skill-switch', 'skills.json');
}

export async function readDeclaration(path: string): Promise<SkillsDeclarationFile> {
  const data = await readJsonState<SkillsDeclarationFile>(path, { version: 1, skills: [] });
  if (typeof data !== 'object' || data === null || !Array.isArray((data as SkillsDeclarationFile).skills)) {
    throw new StateFileError(`声明文件结构非法(期望 { version, skills: [...] }): ${path}`, path);
  }
  return data;
}

export async function upsertSkillDeclarations(
  skillsJsonPath: string,
  additions: Array<{ name: string; agent: AgentType; source: string; mode: 'symlink' | 'copy' }>,
): Promise<SkillsDeclarationFile> {
  const current = await readDeclaration(skillsJsonPath);
  const byName = new Map<string, SkillDeclaration>(
    current.skills.map((skill) => [
      skill.name,
      {
        ...skill,
        agents: [...skill.agents],
        ...(skill.agentSources ? { agentSources: cloneAgentSources(skill.agentSources) } : {}),
      },
    ]),
  );

  for (const addition of additions) {
    const existing = byName.get(addition.name);
    if (existing) {
      if (!existing.agents.includes(addition.agent)) existing.agents.push(addition.agent);
      existing.enabled = true;
      const defaultMatches = existing.source === addition.source && existing.mode === addition.mode;
      if (existing.agentSources || !defaultMatches) {
        ensureAgentSources(existing)[addition.agent] = {
          source: addition.source,
          mode: addition.mode,
        };
      }
      continue;
    }

    byName.set(addition.name, {
      name: addition.name,
      source: addition.source,
      agents: [addition.agent],
      enabled: true,
      mode: addition.mode,
    });
  }

  const next: SkillsDeclarationFile = {
    version: 1,
    skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
  await writeJsonState(skillsJsonPath, next);
  return next;
}

export async function removeFromDeclaration(
  skillsJsonPath: string,
  name: string,
  agent: AgentType,
): Promise<SkillsDeclarationFile> {
  const current = await readDeclaration(skillsJsonPath);
  const skills: SkillDeclaration[] = [];

  for (const skill of current.skills) {
    if (skill.name !== name) {
      skills.push(skill);
      continue;
    }

    const agents = skill.agents.filter((a) => a !== agent);
    if (agents.length === 0) continue;

    const next: SkillDeclaration = {
      ...skill,
      agents,
      ...(skill.agentSources ? { agentSources: cloneAgentSources(skill.agentSources) } : {}),
    };
    if (next.agentSources) {
      delete next.agentSources[agent];
      if (Object.keys(next.agentSources).length === 0) delete next.agentSources;
      else {
        const promoted = next.agentSources[agents[0]!];
        if (promoted) {
          next.source = promoted.source;
          next.mode = promoted.mode;
        }
      }
    }
    skills.push(next);
  }

  const next: SkillsDeclarationFile = {
    version: 1,
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
  };
  await writeJsonState(skillsJsonPath, next);
  return next;
}

function cloneAgentSources(
  agentSources: Partial<Record<AgentType, SkillAgentSource>>,
): Partial<Record<AgentType, SkillAgentSource>> {
  return Object.fromEntries(
    Object.entries(agentSources).map(([agent, source]) => [
      agent,
      { ...(source as SkillAgentSource) },
    ]),
  ) as Partial<Record<AgentType, SkillAgentSource>>;
}

function ensureAgentSources(
  skill: SkillDeclaration,
): Partial<Record<AgentType, SkillAgentSource>> {
  const agentSources = skill.agentSources ? cloneAgentSources(skill.agentSources) : {};
  for (const agent of skill.agents) {
    agentSources[agent] ??= { source: skill.source, mode: skill.mode };
  }
  skill.agentSources = agentSources;
  return agentSources;
}

function sourceForAgent(skill: SkillDeclaration, agent: AgentType): SkillAgentSource {
  return skill.agentSources?.[agent] ?? { source: skill.source, mode: skill.mode };
}

function sourceAbsFor(home: string, source: string): string {
  return isAbsolute(source) ? source : join(home, source);
}

function skillsDirFor(home: string, agent: AgentType): string {
  const location = getAgentSkillsLocations().find((l) => l.agent === agent);
  if (!location) throw new Error(`声明中包含未知或无全局 skills 目录的 agent: ${agent}`);
  return resolveGlobalSkillsDir(home, location);
}

type TargetState =
  | { state: 'missing' }
  | { state: 'symlink'; linkTarget: string }
  | { state: 'dir' };

// AUDIT-SYNC1:只有 ENOENT 代表"目标确实不存在"。其余错误(EACCES/EPERM/ENOTDIR …)
// 必须透传:把"读不了"误判成"不存在"会让 planOne 返回 create,applySync 随即 rm -rf +
// 重拷,破坏既有内容。参考 state-io 的处理思路(只吞 ENOENT)。
async function inspectTarget(target: string): Promise<TargetState> {
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink()) return { state: 'symlink', linkTarget: await readlink(target) };
    return { state: 'dir' };
  } catch (err) {
    if (errIsEnoent(err)) return { state: 'missing' };
    throw err;
  }
}

function errIsEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/** 期望状态 vs 实际状态 → 单个目标的对账动作(不执行)。 */
async function planOne(
  declared: SkillDeclaration,
  sourceAbs: string,
  mode: 'symlink' | 'copy',
  agent: AgentType,
  target: string,
): Promise<SyncAction> {
  const base = { agent, name: declared.name, target };
  const actual = await inspectTarget(target);

  if (!declared.enabled) {
    return actual.state === 'missing'
      ? { ...base, kind: 'noop', reason: 'disabled,目标本就不存在' }
      : { ...base, kind: 'remove', reason: 'disabled,移除目标' };
  }

  if (actual.state === 'missing') return { ...base, kind: 'create' };

  if (mode === 'symlink') {
    if (actual.state === 'symlink') {
      // readlink 可能返回相对目标:必须相对 symlink 所在目录解析,而非 process.cwd()。
      const actualAbs = isAbsolute(actual.linkTarget)
        ? actual.linkTarget
        : resolve(dirname(target), actual.linkTarget);
      if (resolve(actualAbs) === resolve(sourceAbs)) {
        return { ...base, kind: 'noop' };
      }
    }
    return { ...base, kind: 'replace', reason: 'symlink 指向不符或被实体目录占位' };
  }

  // copy 模式:实体目录且内容哈希一致才算同步
  if (actual.state === 'dir') {
    const [want, have] = await Promise.all([
      computeSkillFolderHash(sourceAbs),
      computeSkillFolderHash(target),
    ]);
    if (want === have) return { ...base, kind: 'noop' };
    return { ...base, kind: 'replace', reason: '内容哈希不一致' };
  }
  return { ...base, kind: 'replace', reason: 'copy 模式但目标是 symlink' };
}

export async function planSync(
  home: string,
  declaration: SkillsDeclarationFile,
): Promise<SyncAction[]> {
  const actions: SyncAction[] = [];
  for (const skill of declaration.skills) {
    assertSafeSkillName(skill.name, 'declaration skill name');
    for (const agent of skill.agents) {
      const expected = sourceForAgent(skill, agent);
      const sourceAbs = sourceAbsFor(home, expected.source);
      if (skill.enabled && !existsSync(sourceAbs)) {
        throw new Error(`声明的 skill 源不存在: ${skill.name} → ${sourceAbs}`);
      }
      const target = join(skillsDirFor(home, agent), skill.name);

      // Codex 特例:开关走 config.toml 原生机制(官方支持),文件保持在位。
      if (agent === 'codex') {
        const configured = await readCodexSkillEnabled(getCodexConfigPath(home), target);
        if (!skill.enabled) {
          actions.push(
            configured === false
              ? { kind: 'noop', agent, name: skill.name, target, reason: 'config 已 disabled' }
              : { kind: 'config-disable', agent, name: skill.name, target },
          );
          continue;
        }
        actions.push(await planOne(skill, sourceAbs, expected.mode, agent, target));
        if (configured === false) {
          actions.push({ kind: 'config-enable', agent, name: skill.name, target });
        }
        continue;
      }

      actions.push(await planOne(skill, sourceAbs, expected.mode, agent, target));
    }
  }
  return actions;
}

/** Place (or re-place) a skill at its target path for create/replace actions. */
async function materializeSkill(
  home: string,
  action: SyncAction,
  declaration: SkillsDeclarationFile,
): Promise<void> {
  const declared = declaration.skills.find((s) => s.name === action.name)!;
  const expected = sourceForAgent(declared, action.agent);
  const sourceAbs = sourceAbsFor(home, expected.source);
  await mkdir(join(action.target, '..'), { recursive: true });
  if (expected.mode === 'symlink') {
    await symlink(sourceAbs, action.target, 'dir');
  } else {
    await copyDirWithoutSymlinks(sourceAbs, action.target);
  }
}

// ---------- P3-D5:plan artifact ----------

export interface SyncPlanArtifact {
  /** 格式版本,固定为 1 */
  version: 1;
  /** 生成时间(ISO8601) */
  createdAt: string;
  /** 声明文件路径(信息用,不作安全依据) */
  declarationPath: string;
  /** 声明文件内容的 sha256 hex 摘要(校验声明未被修改) */
  declarationSha256: string;
  /** planSync 产生的动作列表 */
  actions: SyncAction[];
}

/** 计算字符串的 sha256 hex 摘要(无依赖,用 node:crypto)。 */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 把 planSync 结果序列化写到 outFile,附带声明文件 sha256。
 * apply --plan 时会重新读声明文件并对比该摘要,不一致则拒绝。
 */
export async function writePlanArtifact(
  outFile: string,
  declarationPath: string,
  actions: SyncAction[],
): Promise<SyncPlanArtifact> {
  // 读声明文件原始内容计算摘要(以磁盘字节为准,与 JSON.stringify 无关)
  const rawDeclaration = await readFile(declarationPath, 'utf8');
  const artifact: SyncPlanArtifact = {
    version: 1,
    createdAt: new Date().toISOString(),
    declarationPath,
    declarationSha256: sha256Hex(rawDeclaration),
    actions,
  };
  await mkdir(outFile.replace(/\/[^/]+$/, ''), { recursive: true }).catch(() => undefined);
  await writeFile(outFile, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifact;
}

/**
 * 读回 plan artifact 并校验声明文件 sha256。
 * 若声明文件已被修改(sha256 不符),抛出描述性错误,提示用户重新 plan。
 */
export async function readAndVerifyPlanArtifact(
  planFile: string,
  declarationPath: string,
): Promise<SyncPlanArtifact> {
  let raw: string;
  try {
    raw = await readFile(planFile, 'utf8');
  } catch {
    throw new Error(`找不到 plan 文件: ${planFile}`);
  }
  let artifact: SyncPlanArtifact;
  try {
    artifact = JSON.parse(raw) as SyncPlanArtifact;
  } catch {
    throw new Error(`plan 文件 JSON 损坏: ${planFile}`);
  }
  if (artifact.version !== 1 || !Array.isArray(artifact.actions) || !artifact.declarationSha256) {
    throw new Error(`plan 文件结构非法(期望 version:1 + actions + declarationSha256): ${planFile}`);
  }

  // 校验声明文件未被修改
  let currentRaw: string;
  try {
    currentRaw = await readFile(declarationPath, 'utf8');
  } catch {
    throw new Error(`找不到声明文件: ${declarationPath}`);
  }
  const currentSha256 = sha256Hex(currentRaw);
  if (currentSha256 !== artifact.declarationSha256) {
    throw new Error(
      `声明文件已被修改,plan 已过期,请重新执行 sync plan --out <file>。\n` +
      `  plan 记录: ${artifact.declarationSha256.slice(0, 16)}…\n` +
      `  当前文件: ${currentSha256.slice(0, 16)}…`,
    );
  }
  return artifact;
}

// ---------- applySync ----------

export interface ApplySyncOptions {
  /**
   * WAL 步骤回调,仅供崩溃矩阵测试注入故障(在指定步骤后自杀);生产不传。
   * 步骤 id:prepare / applying / apply-sync / commit。
   */
  onStep?: (stepId: string) => void | Promise<void>;
}

function targetsFromPlan(actions: SyncAction[]): JournalManagedTarget[] {
  const seen = new Set<string>();
  const targets: JournalManagedTarget[] = [];
  for (const action of actions) {
    if (action.kind === 'noop' || action.kind === 'config-disable' || action.kind === 'config-enable') {
      continue;
    }
    const key = `${action.agent}\0${action.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      agent: action.agent,
      name: action.name,
      existedBefore: existsSync(action.target),
    });
  }
  return targets;
}

/**
 * 带锁的公开 sync 入口。journal 只在此接入;持锁调用方请用 applySyncUnlocked
 * (toggle 等外层已有自己的 journal 事务)。
 */
export async function applySync(
  home: string,
  declaration: SkillsDeclarationFile,
  options: ApplySyncOptions = {},
): Promise<{ actions: SyncAction[] }> {
  return withOperationLock(home, 'sync', (lock) =>
    applySyncJournaled(home, declaration, lock.owner.nonce, options),
  );
}

async function applySyncJournaled(
  home: string,
  declaration: SkillsDeclarationFile,
  lockNonce: string,
  options: ApplySyncOptions,
): Promise<{ actions: SyncAction[] }> {
  const declarationPath = getSkillsJsonPath(home);
  const lockPath = getSkillsLockPath(home);

  // preState 必须在任何权威写之前:先 plan + 拍根快照,再开 journal。
  const planned = await planSync(home, declaration);
  const agents = new Set(declaration.skills.flatMap((s) => s.agents));
  const label = 'pre-sync';
  const processSnapshots = await snapshotAgents(home, agents, label);
  const walSnapshots = await walSnapshotsForAgents(home, agents, processSnapshots, label);
  const preState: JournalPreState = {
    declaration: await captureFileState(declarationPath),
    lockfile: await captureFileState(lockPath),
    snapshots: walSnapshots,
    targets: targetsFromPlan(planned),
    storeTargets: [],
  };

  const journal = await beginJournal(home, {
    operation: 'sync',
    nonce: lockNonce,
    preState,
    steps: ['apply-sync'],
  });
  await options.onStep?.('prepare');

  try {
    await journal.markApplying();
    await options.onStep?.('applying');

    // 已持锁;unlocked 内部会重新 plan,以当前磁盘状态安全应用。
    const result = await applySyncUnlocked(home, declaration);
    await journal.markStep('apply-sync');
    await options.onStep?.('apply-sync');

    await journal.markCommit();
    await options.onStep?.('commit');
    await journal.clear();
    return result;
  } catch (error) {
    // 进程内就地恢复:锁仍持有,立刻按 journal 回滚。sync 本身无其它补偿路径。
    // 恢复失败则保留 journal,下次获锁操作会重试。
    try {
      await recoverPendingJournal(home, {
        log: (message) => console.error(message),
      });
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        'sync 失败且就地恢复未完成;写操作日志已保留,下次任意写操作将自动重试恢复',
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Sync implementation for callers that already hold the home operation lock.
 * @internal Do not call this as a standalone public write operation.
 * journal 不在此接入——外层(toggle / CLI 自持锁路径)负责事务边界。
 */
export async function applySyncUnlocked(
  home: string,
  declaration: SkillsDeclarationFile,
): Promise<{ actions: SyncAction[] }> {
  const actions = await planSync(home, declaration);
  for (const action of actions) {
    if (action.kind === 'noop') continue;

    if (action.kind === 'config-disable' || action.kind === 'config-enable') {
      await setCodexSkillEnabled(
        getCodexConfigPath(home),
        action.target,
        action.kind === 'config-enable',
      );
      continue;
    }

    await rm(action.target, { recursive: true, force: true });
    if (action.kind === 'remove') continue;

    await materializeSkill(home, action, declaration);
  }
  return { actions };
}
