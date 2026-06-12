// 写命令共享的 agent 根目录快照逻辑。
// codex 需要保整个 .codex(含 config.toml);其余 agent 保各自 skills 目录。
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { snapshot, type SnapshotInfo } from './backup.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';

export function snapshotRoot(home: string, agent: AgentType): string | undefined {
  if (agent === 'codex') return join(home, '.codex');
  const location = getAgentSkillsLocations().find((l) => l.agent === agent);
  return location ? resolveGlobalSkillsDir(home, location) : undefined;
}

export async function snapshotAgents(
  home: string,
  agents: Iterable<AgentType>,
  label: string,
): Promise<SnapshotInfo[]> {
  const snapshots: SnapshotInfo[] = [];
  const store = join(home, '.skill-switch', 'backups');

  for (const agent of new Set(agents)) {
    const root = snapshotRoot(home, agent);
    if (!root || !existsSync(root)) continue;
    if ((await readdir(root)).length === 0) continue;
    snapshots.push(await snapshot(root, { store, label }));
  }

  return snapshots;
}
