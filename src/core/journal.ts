// WAL 写前意图日志:让多文件写操作(install/toggle/remove/sync/...)在进程崩溃
// (SIGKILL / OOM-kill / 强杀)后可以确定性恢复。设计:2026-07-18-wal-design(账本 plans/),
// 修订:2026-07-18 Codex xhigh 核验后(结构化目标/快照预验/symlink 祖先检查/声明收窄)。
//
// 恢复保证的边界(诚实声明):
//   - journal 自身经 writeJsonState(fsync+原子 rename)落盘,权威状态文件同样;
//     但快照 tar 与目录拷贝不做全链路 fsync——**本机制承诺进程崩溃级恢复,
//     不承诺电源断电级耐久**(断电后 journal 链路大概率有效,数据文件不保证)。
//   - 同 UID 的活跃本地攻击者可以直接改写 home 下一切(包括 skills.json 本身),
//     journal 不比其它状态文件更弱;恢复引擎仍做防御性校验(见下),使被篡改的
//     journal 无法把恢复动作导向受管目录之外。
//
// 语义:
//   - 每个写事务在锁内先落 journal(phase=prepare,含完整 preState),进入权威写阶段
//     置 phase=applying,全部写完置 phase=commit,随后删除 journal。
//   - 恢复(recoverPendingJournal)在下一次任何获锁写操作开始时自动执行:
//       prepare  → 什么都没写过,删 journal 即可。
//       applying → 回滚:先一次性预验全部快照(存在+归档安全),再删 targets、
//                  铺快照、按原文写回声明/锁。回滚幂等,中途再崩重启重来。
//       commit   → 前滚:权威写已全部完成,删 journal。
//       损坏/版本不认识/校验不过 → 抛 JournalRecoveryError,绝不自动动任何文件。
//   - **恢复引擎不信任 journal 里的任何自由路径**:写入目标与快照铺回位置只以
//     结构化形式(agent + 规范 skill 名 + 受控 scope)记录,恢复时经 paths API 重新
//     推导;快照 tar 路径必须位于 backups 或 journal 私有快照目录前缀内;
//     声明/锁路径由 home 内联重算。skill 名恢复时再过 assertSafeSkillName。
//   - nonce 仅作诊断关联(记录当时的锁 owner);恢复发生在下一任锁内,旧锁 owner
//     文件已随锁回收消失,nonce 不构成安全绑定。
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { assertSafeArchive, restoreSnapshot, snapshot, type SnapshotInfo } from './backup.ts';
import { getCodexConfigPath } from './codex-toggle.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';
import { assertSafeSkillName } from './skill-name.ts';
import { readJsonState, writeJsonState, writeTextState, StateFileError } from './state-io.ts';

export type JournalPhase = 'prepare' | 'applying' | 'commit';

export interface JournalFileState {
  /** 事务开始前的文件原文;null 表示当时不存在(回滚时删除)。 */
  content: string | null;
}

/**
 * 结构化写入目标:只记 agent + 规范 skill 名,恢复时经 paths API 重新推导实路径。
 * journal 内绝不出现可自由指定的目标路径。
 */
export interface JournalManagedTarget {
  agent: AgentType;
  name: string;
  existedBefore: boolean;
}

/** 快照铺回位置的受控枚举——同样恢复时推导,不存自由路径。 */
export type JournalSnapshotScope =
  | { kind: 'agent-skills-root'; agent: AgentType }
  | { kind: 'store-skill'; agent: AgentType; name: string };

export interface JournalSnapshotRef {
  /** 快照 tar 路径(必须位于 backups 或 journal 私有快照目录前缀内)。 */
  path: string;
  scope: JournalSnapshotScope;
}

/** 受控附加文件:id 枚举、路径恢复时推导(目前仅 codex 的 config.toml 开关位)。 */
export interface JournalExtraFile {
  id: 'codex-config';
  content: string | null;
}

export interface JournalPreState {
  declaration: JournalFileState;
  lockfile: JournalFileState;
  /** 可选受控附加文件(如 toggle/sync 涉 codex 时的 config.toml 原文)。 */
  extraFiles?: JournalExtraFile[];
  snapshots: JournalSnapshotRef[];
  /** agent 磁盘上本次将写/覆盖的 skill。回滚时删除,再由快照铺回旧状态。 */
  targets: JournalManagedTarget[];
  /** store 里本次将写/覆盖的 skill。existedBefore=false 回滚时删除;true 由快照铺回。 */
  storeTargets: JournalManagedTarget[];
}

export interface OperationJournal {
  version: 2;
  operation: string;
  /** 诊断信息:记录当时锁 owner 的 nonce(非安全绑定,见文件头注释)。 */
  nonce: string;
  startedAt: string;
  phase: JournalPhase;
  preState: JournalPreState;
  /** 诊断用步骤标记;恢复决策只看 phase,不依赖 steps。 */
  steps: Array<{ id: string; done: boolean }>;
}

export class JournalRecoveryError extends Error {
  constructor(
    message: string,
    readonly journalFile: string,
  ) {
    super(message);
    this.name = 'JournalRecoveryError';
  }
}

export function journalPath(home: string): string {
  return join(home, '.skill-switch', 'journal', 'current.json');
}

/**
 * WAL 事务内部快照目录(如 install 覆盖已有 store 前的原样)。与面向用户的
 * .skill-switch/backups 分开:内部快照生命周期跟随事务,commit/恢复后即清理,
 * 绝不出现在 restore 的快照列表里。
 */
export function journalSnapshotsDir(home: string): string {
  return join(home, '.skill-switch', 'journal', 'snapshots');
}

/** 删除 journal 及其内部快照(凡结束事务/完成恢复处统一走这里)。 */
async function clearJournalArtifacts(home: string): Promise<void> {
  await rm(journalPath(home), { force: true });
  await rm(journalSnapshotsDir(home), { recursive: true, force: true });
}

/**
 * 捕获状态文件的事务前原文。ENOENT → content: null(回滚时删除);
 * 其它读错误必须抛——绝不能把读不了的文件当"不存在"记进 journal,
 * 否则回滚会把它删掉。
 */
export async function captureFileState(path: string): Promise<JournalFileState> {
  try {
    return { content: await readFile(path, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: null };
    throw error;
  }
}

/**
 * 把 snapshotAgents 的进程内补偿快照映射为 journal 结构化快照(toggle/remove/sync
 * 共用)。codex 特例:snapshotAgents 拍的是 .codex 整根(含 config.toml),sourceDir
 * 不等于 skills 根,不能映射进 agent-skills-root scope——为 journal 单独拍 skills 根;
 * 整根快照仍归进程内补偿与用户资产,不进 journal。
 */
export async function walSnapshotsForAgents(
  home: string,
  agents: Iterable<AgentType>,
  processSnapshots: readonly SnapshotInfo[],
  label: string,
): Promise<JournalSnapshotRef[]> {
  const wal: JournalSnapshotRef[] = [];

  for (const agent of new Set(agents)) {
    const location = getAgentSkillsLocations().find((l) => l.agent === agent);
    if (!location) continue;
    const skillsDir = resolveGlobalSkillsDir(home, location);

    if (agent === 'codex') {
      if (existsSync(skillsDir) && (await readdir(skillsDir)).length > 0) {
        // WAL 内部快照:放 journal 私有目录随事务清理,绝不污染用户 backups
        // (否则会成为 restore --latest 选中的最新快照)。
        const snap = await snapshot(skillsDir, {
          store: journalSnapshotsDir(home),
          label: `${label}-codex-skills`,
        });
        wal.push({ path: snap.path, scope: { kind: 'agent-skills-root', agent: 'codex' } });
      }
      continue;
    }

    const match = processSnapshots.find(
      (s) => s.sourceDir !== undefined && resolve(s.sourceDir) === resolve(skillsDir),
    );
    if (!match) continue;
    if (!match.sourceDir) {
      throw new Error(`快照缺少 sourceDir,无法写入 journal: ${match.path}`);
    }
    wal.push({ path: match.path, scope: { kind: 'agent-skills-root', agent } });
  }
  return wal;
}

function declarationPathFor(home: string): string {
  // 与 sync.ts getSkillsJsonPath 保持一致;内联以避免 journal→sync→operation-lock 循环依赖,
  // 也让恢复引擎不必信任 journal 内的路径。tests/journal.test.ts 有一致性断言守护。
  return join(home, '.skill-switch', 'skills.json');
}

function lockfilePathFor(home: string): string {
  // 与 lock.ts getSkillsLockPath 保持一致;同上。
  return join(home, '.skill-switch', 'skills.lock.json');
}

function isWithin(prefix: string, target: string): boolean {
  const base = resolve(prefix);
  const resolved = resolve(target);
  return resolved === base || resolved.startsWith(base + sep);
}

/** 恢复时的实路径推导:agent 必须在已知位置表里,skill 名必须通过安全校验。 */
function skillsRootFor(home: string, agent: AgentType, file: string): string {
  const location = getAgentSkillsLocations().find((l) => l.agent === agent);
  if (!location) {
    throw new JournalRecoveryError(`写操作日志引用未知 agent,拒绝自动恢复: ${agent}`, file);
  }
  return resolveGlobalSkillsDir(home, location);
}

function assertRecoverableSkillName(name: string, file: string): void {
  try {
    assertSafeSkillName(name, 'journal recovery target');
  } catch (error) {
    throw new JournalRecoveryError(
      `写操作日志含非法 skill 名,拒绝自动恢复: ${(error as Error).message}`,
      file,
    );
  }
}

function storePathFor(home: string, agent: AgentType, name: string): string {
  return join(home, '.skill-switch', 'store', agent, name);
}

function targetDiskPath(home: string, target: JournalManagedTarget, file: string): string {
  assertRecoverableSkillName(target.name, file);
  return join(skillsRootFor(home, target.agent, file), target.name);
}

function targetStorePath(home: string, target: JournalManagedTarget, file: string): string {
  assertRecoverableSkillName(target.name, file);
  // store 根不依赖 agent 位置表——store 是 skill-switch 自有目录,agent 仅作命名空间。
  return storePathFor(home, target.agent, target.name);
}

function snapshotSourceDir(home: string, ref: JournalSnapshotRef, file: string): string {
  if (ref.scope.kind === 'agent-skills-root') {
    return skillsRootFor(home, ref.scope.agent, file);
  }
  assertRecoverableSkillName(ref.scope.name, file);
  return storePathFor(home, ref.scope.agent, ref.scope.name);
}

function isJournal(value: unknown): value is OperationJournal {
  if (!value || typeof value !== 'object') return false;
  const journal = value as Partial<OperationJournal>;
  if (journal.version !== 2) return false;
  if (typeof journal.operation !== 'string' || typeof journal.nonce !== 'string') return false;
  if (journal.phase !== 'prepare' && journal.phase !== 'applying' && journal.phase !== 'commit') {
    return false;
  }
  const pre = journal.preState;
  if (!pre || typeof pre !== 'object') return false;
  const fileStateOk = (state: unknown): boolean => {
    if (!state || typeof state !== 'object') return false;
    const content = (state as JournalFileState).content;
    return content === null || typeof content === 'string';
  };
  if (!fileStateOk(pre.declaration) || !fileStateOk(pre.lockfile)) return false;
  if (pre.extraFiles !== undefined) {
    if (!Array.isArray(pre.extraFiles)) return false;
    const extraOk = pre.extraFiles.every((f) =>
      f && f.id === 'codex-config' && (f.content === null || typeof f.content === 'string'));
    if (!extraOk) return false;
  }
  if (!Array.isArray(pre.snapshots) || !Array.isArray(pre.targets) ||
    !Array.isArray(pre.storeTargets)) {
    return false;
  }
  const scopeOk = (scope: unknown): boolean => {
    if (!scope || typeof scope !== 'object') return false;
    const s = scope as JournalSnapshotScope;
    if (s.kind === 'agent-skills-root') return typeof s.agent === 'string';
    if (s.kind === 'store-skill') return typeof s.agent === 'string' && typeof s.name === 'string';
    return false;
  };
  const snapshotOk = pre.snapshots.every((s) =>
    s && typeof s.path === 'string' && scopeOk(s.scope));
  const targetOk = (list: JournalManagedTarget[]): boolean =>
    list.every((t) =>
      t && typeof t.agent === 'string' && typeof t.name === 'string' &&
      typeof t.existedBefore === 'boolean');
  return snapshotOk && targetOk(pre.targets) && targetOk(pre.storeTargets);
}

export interface JournalHandle {
  markApplying(): Promise<void>;
  markStep(id: string): Promise<void>;
  markCommit(): Promise<void>;
  /** commit 之后(或进程内补偿已恢复原状后)删除 journal,事务收尾。 */
  clear(): Promise<void>;
}

/** 在锁内开启一个写事务的 journal(phase=prepare)。 */
export async function beginJournal(
  home: string,
  init: {
    operation: string;
    nonce: string;
    preState: JournalPreState;
    steps: string[];
  },
): Promise<JournalHandle> {
  const file = journalPath(home);
  const journal: OperationJournal = {
    version: 2,
    operation: init.operation,
    nonce: init.nonce,
    startedAt: new Date().toISOString(),
    phase: 'prepare',
    preState: init.preState,
    steps: init.steps.map((id) => ({ id, done: false })),
  };
  await writeJsonState(file, journal);

  const persist = () => writeJsonState(file, journal);
  return {
    async markApplying(): Promise<void> {
      journal.phase = 'applying';
      await persist();
    },
    async markStep(id: string): Promise<void> {
      const step = journal.steps.find((s) => s.id === id);
      if (step) step.done = true;
      await persist();
    },
    async markCommit(): Promise<void> {
      journal.phase = 'commit';
      await persist();
    },
    async clear(): Promise<void> {
      await clearJournalArtifacts(home);
    },
  };
}

export type JournalRecoveryOutcome =
  | 'none'
  | 'cleared-prepare'
  | 'rolled-back'
  | 'completed-commit';

/** doctor 只读诊断用:返回未完成 journal(如有);损坏时抛 JournalRecoveryError。 */
export async function readPendingJournal(home: string): Promise<OperationJournal | undefined> {
  const file = journalPath(home);
  let raw: unknown;
  try {
    raw = await readJsonState<unknown>(file, undefined);
  } catch (error) {
    if (error instanceof StateFileError) {
      throw new JournalRecoveryError(
        `写操作日志损坏,拒绝自动恢复(请运行 doctor 检查): ${file}`,
        file,
      );
    }
    throw error;
  }
  if (raw === undefined) return undefined;
  if (!isJournal(raw)) {
    throw new JournalRecoveryError(
      `写操作日志格式不认识(可能来自其它版本),拒绝自动恢复: ${file}`,
      file,
    );
  }
  return raw;
}

/** 快照 tar 只允许出现在这两个前缀下(防篡改 journal 指向任意 tar)。 */
function assertSnapshotPathBoundary(home: string, path: string, file: string): void {
  const backupsRoot = join(home, '.skill-switch', 'backups');
  if (!isWithin(backupsRoot, path) && !isWithin(journalSnapshotsDir(home), path)) {
    throw new JournalRecoveryError(
      `写操作日志中的快照路径越界,拒绝自动恢复: ${path}`,
      file,
    );
  }
}

/** 受管根若已被换成 symlink(潜在的重定向攻击/异常状态),拒绝自动恢复。 */
async function assertRootNotSymlink(root: string, file: string): Promise<void> {
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink()) {
      throw new JournalRecoveryError(
        `受管目录是符号链接,拒绝自动恢复(请人工检查): ${root}`,
        file,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // 不存在=可重建
    throw error;
  }
}

/**
 * 回滚前的一次性预验:所有推导路径合法、受管根非 symlink、全部快照存在且归档安全。
 * 任何一项不过 → 世界保持原样不动,抛 JournalRecoveryError 转交 doctor。
 * (若先删后验,损坏快照会把恢复卡死在中间态并造成数据丢失。)
 */
async function prevalidateRollback(
  home: string,
  journal: OperationJournal,
  file: string,
): Promise<void> {
  const roots = new Set<string>();
  for (const target of journal.preState.targets) {
    roots.add(skillsRootFor(home, target.agent, file));
    targetDiskPath(home, target, file);
  }
  for (const target of journal.preState.storeTargets) {
    targetStorePath(home, target, file);
  }
  for (const snap of journal.preState.snapshots) {
    assertSnapshotPathBoundary(home, snap.path, file);
    const sourceDir = snapshotSourceDir(home, snap, file);
    if (snap.scope.kind === 'agent-skills-root') roots.add(sourceDir);
    try {
      await stat(snap.path);
      await assertSafeArchive(snap.path);
    } catch (error) {
      if (error instanceof JournalRecoveryError) throw error;
      throw new JournalRecoveryError(
        `写操作日志引用的快照缺失或无法安全还原,拒绝自动恢复: ${snap.path}(${(error as Error).message})`,
        file,
      );
    }
  }
  for (const root of roots) {
    await assertRootNotSymlink(root, file);
  }
}

async function rollback(home: string, journal: OperationJournal, file: string): Promise<void> {
  // 1) agent 磁盘与 store 上本次写过的路径一律删除(旧状态随后由快照铺回)。
  for (const target of journal.preState.targets) {
    await rm(targetDiskPath(home, target, file), { recursive: true, force: true });
  }
  for (const target of journal.preState.storeTargets) {
    if (!target.existedBefore) {
      await rm(targetStorePath(home, target, file), { recursive: true, force: true });
    }
  }
  // 2) 快照铺回(restoreSnapshot 是完整替换语义:staging 解压 + rename 换入)。
  for (const snap of journal.preState.snapshots) {
    await restoreSnapshot(snap.path, snapshotSourceDir(home, snap, file));
  }
  // 3) 声明/锁按事务前原文写回。路径由 home 重算,不信任 journal。
  const declaration = declarationPathFor(home);
  const lockfile = lockfilePathFor(home);
  if (journal.preState.declaration.content === null) {
    await rm(declaration, { force: true });
  } else {
    await writeTextState(declaration, journal.preState.declaration.content);
  }
  if (journal.preState.lockfile.content === null) {
    await rm(lockfile, { force: true });
  } else {
    await writeTextState(lockfile, journal.preState.lockfile.content);
  }
  // 4) 受控附加文件(id 枚举,路径推导——同样不信任 journal 内路径)。
  for (const extra of journal.preState.extraFiles ?? []) {
    const path = getCodexConfigPath(home);
    if (extra.content === null) {
      await rm(path, { force: true });
    } else {
      await writeTextState(path, extra.content);
    }
  }
}

/**
 * 恢复上一次被中断的写事务。必须在持有操作锁的情况下调用
 * (withOperationLock 已自动接线;锁互斥保证恢复期间无并发写)。
 */
export async function recoverPendingJournal(
  home: string,
  options: { log?: (message: string) => void } = {},
): Promise<JournalRecoveryOutcome> {
  const file = journalPath(home);
  const journal = await readPendingJournal(home);
  if (!journal) return 'none';

  if (journal.phase === 'prepare') {
    // 权威写尚未开始;backups 里的孤儿快照无害(restore prune 可清),内部快照直接清。
    await clearJournalArtifacts(home);
    return 'cleared-prepare';
  }

  if (journal.phase === 'commit') {
    await clearJournalArtifacts(home);
    return 'completed-commit';
  }

  await prevalidateRollback(home, journal, file);
  await rollback(home, journal, file);
  await clearJournalArtifacts(home);
  options.log?.(
    `上次的 ${journal.operation} 操作被中断,已自动恢复到操作之前的状态。`,
  );
  return 'rolled-back';
}
