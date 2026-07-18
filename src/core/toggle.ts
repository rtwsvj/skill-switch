// S4.3 toggle:声明是唯一事实来源 — 翻 enabled 位 → 写回 skills.json →
// 对受影响 agent 目录拍快照(S3.1 原语)→ applySync(S4.1/4.2 引擎)。
// 回滚 = restoreSnapshot(快照, 对应目录)。
// WAL:进程崩溃级恢复见 journal;进程内补偿仍保留(双保险)。
import { existsSync } from 'node:fs';
import { snapshotAgents } from './agent-snapshots.ts';
import { restoreSnapshot, type SnapshotInfo } from './backup.ts';
import {
  beginJournal,
  captureFileState,
  walSnapshotsForAgents,
  type JournalHandle,
  type JournalManagedTarget,
  type JournalPreState,
} from './journal.ts';
import { getSkillsLockPath } from './lock.ts';
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

export interface ToggleOptions {
  /**
   * WAL 步骤回调,仅供崩溃矩阵测试注入故障(在指定步骤后自杀);生产不传。
   * 步骤 id:prepare / applying / write-declaration / apply-sync / commit。
   */
  onStep?: (stepId: string) => void | Promise<void>;
}

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

function targetsFromPlan(actions: SyncAction[]): JournalManagedTarget[] {
  const seen = new Set<string>();
  const targets: JournalManagedTarget[] = [];
  for (const action of actions) {
    // create/replace/remove 动 skill 目录;noop 与 config-* 不动目录(config 走其它通道)。
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

export async function toggleSkill(
  home: string,
  name: string,
  enabled: boolean,
  options: ToggleOptions = {},
): Promise<ToggleResult> {
  return withOperationLock(home, `toggle:${name}`, (lock) =>
    toggleSkillUnlocked(home, name, enabled, lock.owner.nonce, options),
  );
}

async function toggleSkillUnlocked(
  home: string,
  name: string,
  enabled: boolean,
  lockNonce: string,
  options: ToggleOptions,
): Promise<ToggleResult> {
  const declarationPath = getSkillsJsonPath(home);
  const lockPath = getSkillsLockPath(home);
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
  const planned = await planSync(home, nextDeclaration);

  // 快照同样必须先于声明和 agent 目录变更。
  const label = `pre-toggle-${name}-${enabled ? 'on' : 'off'}`;
  const snapshots: SnapshotInfo[] = await snapshotAgents(home, skill.agents, label);

  // WAL preState:任何权威写之前。
  const walSnapshots = await walSnapshotsForAgents(home, skill.agents, snapshots, label);
  const preState: JournalPreState = {
    declaration: await captureFileState(declarationPath),
    lockfile: await captureFileState(lockPath),
    snapshots: walSnapshots,
    targets: targetsFromPlan(planned),
    storeTargets: [],
  };

  const journal: JournalHandle = await beginJournal(home, {
    operation: `toggle:${name}`,
    nonce: lockNonce,
    preState,
    steps: ['write-declaration', 'apply-sync'],
  });
  await options.onStep?.('prepare');

  let declarationWritten = false;
  let syncStarted = false;
  try {
    await journal.markApplying();
    await options.onStep?.('applying');

    await writeDeclaration(declarationPath, nextDeclaration);
    declarationWritten = true;
    await journal.markStep('write-declaration');
    await options.onStep?.('write-declaration');

    syncStarted = true;
    const { actions } = await applySyncUnlocked(home, nextDeclaration);
    await journal.markStep('apply-sync');
    await options.onStep?.('apply-sync');

    await journal.markCommit();
    await options.onStep?.('commit');
    await journal.clear();

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

    // 进程内补偿已把世界恢复原样 → clear journal;补偿自身失败则保留 journal 兜底。
    if (rollbackErrors.length === 0) {
      await journal.clear().catch((clearError: unknown) => {
        rollbackErrors.push(clearError);
      });
    }

    throwToggleFailure(error, rollbackErrors);
  }
}
