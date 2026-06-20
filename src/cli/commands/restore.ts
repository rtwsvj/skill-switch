// F14 restore 子命令:列出快照,或按 id/latest 还原到 manifest 记录的 sourceDir。
// 写入前总是先对当前态再拍 pre-restore 快照,保证可逆。
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { listSnapshots, restoreSnapshot, snapshot, type SnapshotInfo } from '../../core/backup.ts';
import { isAllowedRestoreTarget } from '../../core/agent-snapshots.ts';
import { resolveHomeRoot } from '../../core/paths.ts';

interface RestoreCliOptions {
  home?: string;
  id?: string;
  latest?: boolean;
  json?: boolean;
}

interface SnapshotView {
  id: string;
  path: string;
  label: string;
  createdAt: string;
  sourceDir?: string;
}

function viewOf(snapshotInfo: SnapshotInfo): SnapshotView {
  return {
    id: String(snapshotInfo.createdAt.getTime()),
    path: snapshotInfo.path,
    label: snapshotInfo.label,
    createdAt: snapshotInfo.createdAt.toISOString(),
    ...(snapshotInfo.sourceDir ? { sourceDir: snapshotInfo.sourceDir } : {}),
  };
}

function findSnapshot(snapshots: SnapshotInfo[], options: RestoreCliOptions): SnapshotInfo | undefined {
  if (options.latest) return snapshots[0];
  if (options.id) return snapshots.find((snap) => String(snap.createdAt.getTime()) === options.id);
  return undefined;
}

function printSnapshotList(store: string, snapshots: SnapshotInfo[]): void {
  console.log(`snapshots: ${store}`);
  if (snapshots.length === 0) {
    console.log('  none');
    return;
  }
  for (const snap of snapshots) {
    const source = snap.sourceDir ?? '来源未知';
    console.log(`  ${snap.createdAt.getTime()}  ${snap.label}  ${snap.createdAt.toISOString()}  ${source}`);
  }
}

export function registerRestoreCommand(program: Command): void {
  program
    .command('restore')
    .description('列出或还原 skill-switch 快照(还原前自动 pre-restore 快照)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--id <epochMs>', '按快照 id(epochMs)还原')
    .option('--latest', '还原最新快照')
    .option('--json', '机器可读 JSON 输出')
    .action(async (options: RestoreCliOptions, command: Command) => {
      if (options.id && options.latest) throw new Error('--id 与 --latest 只能二选一');

      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
      const store = join(home, '.skill-switch', 'backups');
      const snapshots = await listSnapshots(store);

      if (!options.id && !options.latest) {
        if (options.json) {
          console.log(JSON.stringify({ store, snapshots: snapshots.map(viewOf) }, null, 2));
        } else {
          printSnapshotList(store, snapshots);
        }
        return;
      }

      const selected = findSnapshot(snapshots, options);
      if (!selected) throw new Error(options.latest ? '没有可还原的快照' : `找不到快照 id: ${options.id}`);
      if (!selected.sourceDir) throw new Error(`快照缺少 sourceDir manifest,无法自动还原: ${selected.path}`);
      // AUDIT-SEC2:sourceDir 来自可篡改的 sidecar JSON,必须在动 target 前断言它落在
      // 受管 agent 快照根内,否则越界目标(如 ~/.ssh)会被先快照再铺 tar,造成任意目录写入。
      if (!isAllowedRestoreTarget(home, selected.sourceDir)) {
        throw new Error(`快照 sourceDir 不在受管 agent 目录内,拒绝还原: ${selected.sourceDir}`);
      }
      // 校验通过后统一用归一化路径:消除 `.`/`..`/尾随分隔符写法差异,避免含 `..` 的
      // 合法等价拼写在下游 fs rename 时 EINVAL,同时保证日志/返回值里是干净的绝对路径。
      const target = resolve(selected.sourceDir);

      const safetySnapshot = await snapshot(target, { store, label: 'pre-restore' });
      await restoreSnapshot(selected.path, target);

      const result = {
        restored: true,
        target,
        snapshot: viewOf(selected),
        safetySnapshot: viewOf(safetySnapshot),
      };

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`restored: ${selected.path} → ${selected.sourceDir}`);
        console.log(`pre-restore snapshot: ${safetySnapshot.path}`);
      }
    });
}
