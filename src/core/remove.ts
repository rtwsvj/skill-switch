// F9 remove:一致性拆除某个 agent 上的 skill 产物、锁条目和声明条目。
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { snapshotAgents } from './agent-snapshots.ts';
import type { SnapshotInfo } from './backup.ts';
import { getSkillsLockPath, removeLockEntries } from './lock.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';
import { assertSafeSkillName } from './skill-name.ts';
import { getSkillsJsonPath, removeFromDeclaration } from './sync.ts';

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

export async function removeSkill(home: string, name: string, agent: AgentType): Promise<RemoveResult> {
  const targetPath = targetFor(home, agent, name);
  const lockPath = getSkillsLockPath(home);
  const declarationPath = getSkillsJsonPath(home);
  const snapshots = await snapshotAgents(home, [agent], `pre-remove-${name}-${agent}`);

  await rm(targetPath, { recursive: true, force: true });
  await removeLockEntries(lockPath, [{ name, agent }]);
  await removeFromDeclaration(declarationPath, name, agent);

  return { name, agent, targetPath, lockPath, declarationPath, snapshots };
}
