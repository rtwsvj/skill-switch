// F14 restore 子命令:列出快照,或按 id/latest 还原到 manifest 记录的 sourceDir。
// 写入前总是先对当前态再拍 pre-restore 快照,保证可逆。
import { join } from 'node:path';
import type { Command } from 'commander';
import { listSnapshots, restoreSnapshot, snapshot, type SnapshotInfo } from '../../core/backup.ts';
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

      const safetySnapshot = await snapshot(selected.sourceDir, { store, label: 'pre-restore' });
      await restoreSnapshot(selected.path, selected.sourceDir);

      const result = {
        restored: true,
        target: selected.sourceDir,
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
