// S4.3 toggle:声明是唯一事实来源 — 翻 enabled 位 → 写回 skills.json →
// 对受影响 agent 目录拍快照(S3.1 原语)→ applySync(S4.1/4.2 引擎)。
// 回滚 = restoreSnapshot(快照, 对应目录)。
import { type SnapshotInfo } from './backup.ts';
import { snapshotAgents } from './agent-snapshots.ts';
import { writeJsonState } from './state-io.ts';
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
  await writeJsonState(path, decl);
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
  const snapshots: SnapshotInfo[] = await snapshotAgents(
    home,
    skill.agents,
    `pre-toggle-${name}-${enabled ? 'on' : 'off'}`,
  );

  const { actions } = await applySync(home, declaration);
  return { name, enabled, declarationPath, snapshots, actions };
}
