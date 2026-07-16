// S4.3 toggle:声明是唯一事实来源 — 翻 enabled 位 → 写回 skills.json →
// 对受影响 agent 目录拍快照(S3.1 原语)→ applySync(S4.1/4.2 引擎)。
// 回滚 = restoreSnapshot(快照, 对应目录)。
import { restoreSnapshot, type SnapshotInfo } from './backup.ts';
import { snapshotAgents } from './agent-snapshots.ts';
import { withOperationLock } from './operation-lock.ts';
import { writeJsonState } from './state-io.ts';
import {
  applySyncUnlocked,
  getSkillsJsonPath,
  planSync,
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

async function restoreAgentSnapshots(snapshots: SnapshotInfo[]): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    if (!snapshot.sourceDir) {
      throw new Error(`快照缺少 sourceDir,无法自动回滚: ${snapshot.path}`);
    }
    await restoreSnapshot(snapshot.path, snapshot.sourceDir);
  }
}

function throwToggleFailure(error: unknown, rollbackErrors: unknown[]): never {
  if (rollbackErrors.length > 0) {
    throw new AggregateError(
      [error, ...rollbackErrors],
      'toggle 失败且自动回滚未完整完成,请使用返回前创建的快照人工恢复',
      { cause: error },
    );
  }
  throw error;
}

export async function toggleSkill(
  home: string,
  name: string,
  enabled: boolean,
): Promise<ToggleResult> {
  return withOperationLock(home, `toggle:${name}`, () => toggleSkillUnlocked(home, name, enabled));
}

async function toggleSkillUnlocked(
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

  const nextDeclaration: SkillsDeclarationFile = {
    ...declaration,
    skills: declaration.skills.map((entry) =>
      entry.name === name ? { ...entry, enabled } : entry,
    ),
  };

  // 在任何持久化变更前先完成整份声明的规划。这样未知 agent、缺失 source、
  // 不可读取 target 等确定性错误不会发生在 skills.json 已经翻位之后。
  await planSync(home, nextDeclaration);

  // 快照同样必须先于声明和 agent 目录变更。
  const snapshots: SnapshotInfo[] = await snapshotAgents(
    home,
    skill.agents,
    `pre-toggle-${name}-${enabled ? 'on' : 'off'}`,
  );

  let declarationWritten = false;
  let syncStarted = false;
  try {
    await writeDeclaration(declarationPath, nextDeclaration);
    declarationWritten = true;
    syncStarted = true;
    const { actions } = await applySyncUnlocked(home, nextDeclaration);
    return { name, enabled, declarationPath, snapshots, actions };
  } catch (error) {
    const rollbackErrors: unknown[] = [];

    if (declarationWritten) {
      await writeDeclaration(declarationPath, declaration).catch((rollbackError: unknown) => {
        rollbackErrors.push(rollbackError);
      });
    }

    if (syncStarted) {
      // 快照恢复 Agent 根可撤销 applySync 已经完成的前半段；随后按旧声明再对账一次，
      // 兼顾快照因空目录而未创建的 agent 根和 Codex config 开关。
      await restoreAgentSnapshots(snapshots).catch((rollbackError: unknown) => {
        rollbackErrors.push(rollbackError);
      });
      await applySyncUnlocked(home, declaration).catch((rollbackError: unknown) => {
        rollbackErrors.push(rollbackError);
      });
    }

    throwToggleFailure(error, rollbackErrors);
  }
}
