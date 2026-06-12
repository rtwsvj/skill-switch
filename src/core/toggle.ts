// S4.3 toggle:声明是唯一事实来源 — 翻 enabled 位 → 写回 skills.json →
// 对受影响 agent 目录拍快照(S3.1 原语)→ applySync(S4.1/4.2 引擎)。
// 回滚 = restoreSnapshot(快照, 对应目录)。
import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { snapshot, type SnapshotInfo } from './backup.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';
import {
  applySync,
  getSkillsJsonPath,
  readDeclaration,
  type SkillsDeclarationFile,
  type SyncAction,
} from './sync.ts';

export interface ToggleResult {
  name: string;
  enabled: boolean;
  declarationPath: string;
  snapshots: SnapshotInfo[];
  actions: SyncAction[];
}

async function writeDeclaration(path: string, decl: SkillsDeclarationFile): Promise<void> {
  await writeFile(path, `${JSON.stringify(decl, null, 2)}\n`);
}

/** 快照根:codex 连 config.toml 一起保(整个 .codex),其余 agent 保 skills 目录。 */
function snapshotRoot(home: string, agent: AgentType): string | undefined {
  if (agent === 'codex') return join(home, '.codex');
  const location = getAgentSkillsLocations().find((l) => l.agent === agent);
  return location ? resolveGlobalSkillsDir(home, location) : undefined;
}

export async function toggleSkill(
  home: string,
  name: string,
  enabled: boolean,
): Promise<ToggleResult> {
  const declarationPath = getSkillsJsonPath(home);
  const declaration = await readDeclaration(declarationPath);
  const skill = declaration.skills.find((s) => s.name === name);
  if (!skill) {
    throw new Error(`skill 不在声明中: ${name}(先在 ${declarationPath} 声明,toggle 只翻 enabled 位)`);
  }

  skill.enabled = enabled;
  await writeDeclaration(declarationPath, declaration);

  // sync 前快照:受影响 agent 的目录,存在且非空才拍
  const snapshots: SnapshotInfo[] = [];
  const store = join(home, '.skill-switch', 'backups');
  for (const agent of skill.agents) {
    const root = snapshotRoot(home, agent);
    if (!root || !existsSync(root)) continue;
    if ((await readdir(root)).length === 0) continue;
    snapshots.push(
      await snapshot(root, { store, label: `pre-toggle-${name}-${enabled ? 'on' : 'off'}` }),
    );
  }

  const { actions } = await applySync(home, declaration);
  return { name, enabled, declarationPath, snapshots, actions };
}
