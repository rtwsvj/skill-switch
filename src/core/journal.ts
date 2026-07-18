// WAL 写前意图日志:让多文件写操作(install/toggle/remove/sync/...)在 SIGKILL/断电后
// 可以确定性恢复。设计文档:2026-07-18-wal-design(账本 plans/)。
//
// 语义:
//   - 每个写事务在锁内先落一份 journal(phase=prepare,含完整 preState),
//     进入权威写阶段置 phase=applying,全部写完置 phase=commit,随后删除 journal。
//   - 恢复(recoverPendingJournal)在下一次任何获锁写操作开始时自动执行:
//       prepare  → 什么都没写过,删 journal 即可(孤儿快照无害)。
//       applying → 回滚:声明/锁按 preState 原文写回(null=删除)、快照铺回、
//                  本次新建的 targets/store 路径删除。回滚幂等,中途再崩重启重来。
//       commit   → 前滚:权威写已全部完成,删 journal。
//       损坏/版本不认识/路径越界 → 抛 JournalRecoveryError,绝不自动动任何文件。
//   - journal 文件本身在用户 home 下,可能被篡改。恢复引擎**不信任 journal 里的任何路径**:
//       声明/锁路径由 home 内联重算;快照 tar 必须位于 <home>/.skill-switch/backups/
//       或 journal 私有快照目录下;
//       还原目标必须是受管 agent skills 根(isAllowedRestoreTarget)或位于
//       <home>/.skill-switch/store/ 下;targets 必须位于受管根或 store 前缀内。
//       任一越界即拒绝自动恢复,转交 doctor。
import { readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { isAllowedRestoreTarget } from './agent-snapshots.ts';
import { restoreSnapshot } from './backup.ts';
import { readJsonState, writeJsonState, writeTextState, StateFileError } from './state-io.ts';

export type JournalPhase = 'prepare' | 'applying' | 'commit';

export interface JournalFileState {
  /** 事务开始前的文件原文;null 表示当时不存在(回滚时删除)。 */
  content: string | null;
}

export interface JournalSnapshotRef {
  /** 快照 tar 路径(必须位于 backups 或 journal 私有快照目录下)。 */
  path: string;
  /** 铺回目标(必须是受管 skills 根或位于 store 前缀内)。 */
  sourceDir: string;
}

export interface JournalTargetRef {
  path: string;
  existedBefore: boolean;
}

export interface JournalPreState {
  declaration: JournalFileState;
  lockfile: JournalFileState;
  snapshots: JournalSnapshotRef[];
  /** agent 磁盘上本次将写/覆盖的具体路径。回滚时一律删除,再由快照铺回旧状态。 */
  targets: JournalTargetRef[];
  /** store 里本次将写/覆盖的具体路径。existedBefore=false 回滚时删除;true 由快照铺回。 */
  storeTargets: JournalTargetRef[];
}

export interface OperationJournal {
  version: 1;
  operation: string;
  /** 与操作锁 owner.nonce 一致,把 journal 绑定到具体一次持锁事务。 */
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

function isManagedMutationPath(home: string, path: string): boolean {
  if (isWithin(join(home, '.skill-switch', 'store'), path)) return true;
  // 受管 skills 根本身,或其下的直接内容(装入的 skill 目录)。
  if (isAllowedRestoreTarget(home, path)) return true;
  const parent = resolve(path, '..');
  return isAllowedRestoreTarget(home, parent);
}

function isJournal(value: unknown): value is OperationJournal {
  if (!value || typeof value !== 'object') return false;
  const journal = value as Partial<OperationJournal>;
  if (journal.version !== 1) return false;
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
  if (!Array.isArray(pre.snapshots) || !Array.isArray(pre.targets) ||
    !Array.isArray(pre.storeTargets)) {
    return false;
  }
  const snapshotOk = pre.snapshots.every((s) =>
    s && typeof s.path === 'string' && typeof s.sourceDir === 'string');
  const targetOk = (list: JournalTargetRef[]): boolean =>
    list.every((t) => t && typeof t.path === 'string' && typeof t.existedBefore === 'boolean');
  return snapshotOk && targetOk(pre.targets) && targetOk(pre.storeTargets);
}

export interface JournalHandle {
  markApplying(): Promise<void>;
  markStep(id: string): Promise<void>;
  markCommit(): Promise<void>;
  /** commit 之后删除 journal,事务收尾。 */
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
    version: 1,
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
      `写操作日志格式不认识(可能来自更新的版本),拒绝自动恢复: ${file}`,
      file,
    );
  }
  return raw;
}

function assertRecoverablePaths(home: string, journal: OperationJournal, file: string): void {
  const backupsRoot = join(home, '.skill-switch', 'backups');
  const walSnapshotsRoot = journalSnapshotsDir(home);
  for (const snap of journal.preState.snapshots) {
    if (!isWithin(backupsRoot, snap.path) && !isWithin(walSnapshotsRoot, snap.path)) {
      throw new JournalRecoveryError(
        `写操作日志中的快照路径越界,拒绝自动恢复: ${snap.path}`,
        file,
      );
    }
    if (!isManagedMutationPath(home, snap.sourceDir)) {
      throw new JournalRecoveryError(
        `写操作日志中的还原目标越界,拒绝自动恢复: ${snap.sourceDir}`,
        file,
      );
    }
  }
  for (const target of [...journal.preState.targets, ...journal.preState.storeTargets]) {
    if (!isManagedMutationPath(home, target.path)) {
      throw new JournalRecoveryError(
        `写操作日志中的写入路径越界,拒绝自动恢复: ${target.path}`,
        file,
      );
    }
  }
}

async function rollback(home: string, journal: OperationJournal): Promise<void> {
  // 1) agent 磁盘与 store 上本次写过的路径一律删除(旧状态随后由快照铺回)。
  for (const target of journal.preState.targets) {
    await rm(target.path, { recursive: true, force: true });
  }
  for (const target of journal.preState.storeTargets) {
    if (!target.existedBefore) await rm(target.path, { recursive: true, force: true });
  }
  // 2) 快照铺回(restoreSnapshot 是完整替换语义:staging 解压 + rename 换入)。
  for (const snap of journal.preState.snapshots) {
    await restoreSnapshot(snap.path, snap.sourceDir);
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

  assertRecoverablePaths(home, journal, file);
  await rollback(home, journal);
  await clearJournalArtifacts(home);
  options.log?.(
    `上次的 ${journal.operation} 操作被中断,已自动恢复到操作之前的状态。`,
  );
  return 'rolled-back';
}
