// F9 remove:一致性拆除某个 agent 上的 skill 产物、锁条目和声明条目。
// WAL:进程崩溃级恢复见 journal;进程内补偿仍保留(双保险)。
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, } from 'node:path';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { snapshotAgents } from './agent-snapshots.ts';
import { restoreSnapshot, type SnapshotInfo } from './backup.ts';
import {
  beginJournal,
  captureFileState,
  walSnapshotsForAgents,
  type JournalHandle,
  type JournalPreState,
} from './journal.ts';
import {
  getSkillsLockPath,
  readSkillsLock,
  removeLockEntries,
  writeSkillsLock,
} from './lock.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';
import { withOperationLock } from './operation-lock.ts';
import { assertSafeSkillName } from './skill-name.ts';
import { writeJsonState } from './state-io.ts';
import { getSkillsJsonPath, readDeclaration, removeFromDeclaration } from './sync.ts';

export interface RemoveOptions {
  /**
   * WAL 步骤回调,仅供崩溃矩阵测试注入故障(在指定步骤后自杀);生产不传。
   * 步骤 id:prepare / applying / remove-target / write-lock / write-declaration / commit。
   */
  onStep?: (stepId: string) => void | Promise<void>;
}

export interface RemoveResult {
  name: string;
  agent: AgentType;
  targetPath: string;
  lockPath: string;
  declarationPath: string;
  snapshots: SnapshotInfo[];
}

function targetFor(home: string, agent: AgentType, name: string): string {
  assertSafeSkillName(name, 'remove skill name');
  const location = getAgentSkillsLocations().find((l) => l.agent === agent);
  if (!location) throw new Error(`未知或无全局 skills 目录的 agent: ${agent}`);
  return join(resolveGlobalSkillsDir(home, location), name);
}

async function restoreAgentSnapshots(snapshots: SnapshotInfo[]): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    if (!snapshot.sourceDir) {
      throw new Error(`快照缺少 sourceDir,无法自动回滚: ${snapshot.path}`);
    }
    await restoreSnapshot(snapshot.path, snapshot.sourceDir);
  }
}

function throwRemoveFailure(error: unknown, rollbackErrors: unknown[]): never {
  if (rollbackErrors.length > 0) {
    throw new AggregateError(
      [error, ...rollbackErrors],
      'remove 失败且自动回滚未完整完成,请使用返回前创建的快照人工恢复',
      { cause: error },
    );
  }
  throw error;
}

export async function removeSkill(
  home: string,
  name: string,
  agent: AgentType,
  options: RemoveOptions = {},
): Promise<RemoveResult> {
  return withOperationLock(home, `remove:${agent}:${name}`, (lock) =>
    removeSkillUnlocked(home, name, agent, lock.owner.nonce, options),
  );
}

async function removeSkillUnlocked(
  home: string,
  name: string,
  agent: AgentType,
  lockNonce: string,
  options: RemoveOptions,
): Promise<RemoveResult> {
  const targetPath = targetFor(home, agent, name);
  const lockPath = getSkillsLockPath(home);
  const declarationPath = getSkillsJsonPath(home);

  // 所有可能失败的状态解析必须先于快照和删除。损坏的 lock/声明不能让磁盘目标
  // 先消失；同时保存原值供后续普通失败的最小补偿使用。
  const [originalLock, originalDeclaration] = await Promise.all([
    readSkillsLock(lockPath),
    readDeclaration(declarationPath),
  ]);
  const label = `pre-remove-${name}-${agent}`;
  const snapshots = await snapshotAgents(home, [agent], label);

  // WAL preState:任何权威写之前。remove 不清 store(耐久副本保留供再启用)。
  const walSnapshots = await walSnapshotsForAgents(home, [agent], snapshots, label);
  const preState: JournalPreState = {
    declaration: await captureFileState(declarationPath),
    lockfile: await captureFileState(lockPath),
    snapshots: walSnapshots,
    targets: [{ agent, name, existedBefore: existsSync(targetPath) }],
    storeTargets: [],
  };

  const journal: JournalHandle = await beginJournal(home, {
    operation: `remove:${agent}:${name}`,
    nonce: lockNonce,
    preState,
    steps: ['remove-target', 'write-lock', 'write-declaration'],
  });
  await options.onStep?.('prepare');

  let targetMutationStarted = false;
  let lockWritten = false;
  let declarationWritten = false;
  let committed = false;
  try {
    await journal.markApplying();
    await options.onStep?.('applying');

    targetMutationStarted = true;
    await rm(targetPath, { recursive: true, force: true });
    await journal.markStep('remove-target');
    await options.onStep?.('remove-target');

    await removeLockEntries(lockPath, [{ name, agent }]);
    lockWritten = true;
    await journal.markStep('write-lock');
    await options.onStep?.('write-lock');

    await removeFromDeclaration(declarationPath, name, agent);
    declarationWritten = true;
    await journal.markStep('write-declaration');
    await options.onStep?.('write-declaration');

    await journal.markCommit();
    committed = true;
    await options.onStep?.('commit');
    await journal.clear();
  } catch (error) {
    // markCommit 已落盘 = 事务语义上已提交:绝不再回滚世界,清 journal(失败则
    // 保留 commit 态,下次前滚)后原样上抛。
    if (committed) {
      await journal.clear().catch(() => undefined);
      throw error;
    }
    const rollbackErrors: unknown[] = [];

    if (declarationWritten) {
      await writeJsonState(declarationPath, originalDeclaration).catch((rollbackError: unknown) => {
        rollbackErrors.push(rollbackError);
      });
    }
    if (lockWritten) {
      await writeSkillsLock(lockPath, originalLock).catch((rollbackError: unknown) => {
        rollbackErrors.push(rollbackError);
      });
    }
    if (targetMutationStarted) {
      await restoreAgentSnapshots(snapshots).catch((rollbackError: unknown) => {
        rollbackErrors.push(rollbackError);
      });
    }

    // 进程内补偿已把世界恢复原样 → clear journal;补偿自身失败则保留 journal 兜底。
    if (rollbackErrors.length === 0) {
      await journal.clear().catch((clearError: unknown) => {
        rollbackErrors.push(clearError);
      });
    }

    throwRemoveFailure(error, rollbackErrors);
  }

  return { name, agent, targetPath, lockPath, declarationPath, snapshots };
}
