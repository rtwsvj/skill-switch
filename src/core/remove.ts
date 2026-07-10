// F9 remove:一致性拆除某个 agent 上的 skill 产物、锁条目和声明条目。
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { snapshotAgents } from './agent-snapshots.ts';
import { restoreSnapshot, type SnapshotInfo } from './backup.ts';
import {
  getSkillsLockPath,
  readSkillsLock,
  removeLockEntries,
  writeSkillsLock,
} from './lock.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';
import { assertSafeSkillName } from './skill-name.ts';
import { writeJsonState } from './state-io.ts';
import { getSkillsJsonPath, readDeclaration, removeFromDeclaration } from './sync.ts';

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

export async function removeSkill(home: string, name: string, agent: AgentType): Promise<RemoveResult> {
  const targetPath = targetFor(home, agent, name);
  const lockPath = getSkillsLockPath(home);
  const declarationPath = getSkillsJsonPath(home);

  // 所有可能失败的状态解析必须先于快照和删除。损坏的 lock/声明不能让磁盘目标
  // 先消失；同时保存原值供后续普通失败的最小补偿使用。
  const [originalLock, originalDeclaration] = await Promise.all([
    readSkillsLock(lockPath),
    readDeclaration(declarationPath),
  ]);
  const snapshots = await snapshotAgents(home, [agent], `pre-remove-${name}-${agent}`);

  let targetMutationStarted = false;
  let lockWritten = false;
  let declarationWritten = false;
  try {
    targetMutationStarted = true;
    await rm(targetPath, { recursive: true, force: true });
    await removeLockEntries(lockPath, [{ name, agent }]);
    lockWritten = true;
    await removeFromDeclaration(declarationPath, name, agent);
    declarationWritten = true;
  } catch (error) {
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

    throwRemoveFailure(error, rollbackErrors);
  }

  return { name, agent, targetPath, lockPath, declarationPath, snapshots };
}
