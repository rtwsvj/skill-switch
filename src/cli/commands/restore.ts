// F14 restore 子命令:列出快照,或按 id/latest 还原到 manifest 记录的 sourceDir。
// 写入前总是先对当前态再拍 pre-restore 快照,保证可逆。
// 例外:target 目录不存在时(用户已手动删除)跳过 pre-restore 快照(无内容可备份),
// 直接还原——这与 snapshotAgents 对不存在根目录的处理一致。
//
// P3-D5:restore prune 快照生命周期管理(对标 Nix expire-generations)。
//   restore prune --keep-last <N>   保留最近 N 个快照,删除其余
//   restore prune --older-than <d>  删除 N 天前的快照(如 7d/30d)
//   restore prune --dry-run         只列将删,不真正删
//   两个选项可组合(先 --keep-last 过滤,再 --older-than 过滤)。
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { listSnapshots, restoreSnapshot, snapshot, type SnapshotInfo } from '../../core/backup.ts';
import { isAllowedRestoreTarget } from '../../core/agent-snapshots.ts';
import { resolveHomeRoot } from '../../core/paths.ts';

interface RestoreCliOptions {
  home?: string;
  id?: string;
  latest?: boolean;
  json?: boolean;
}

interface PruneCliOptions {
  home?: string;
  keepLast?: string;
  olderThan?: string;
  dryRun?: boolean;
  json?: boolean;
}

/**
 * 解析 --older-than 参数:支持 "7d" / "30d" / "1d" 格式,返回毫秒数。
 * 超出的格式抛出描述性错误。
 */
function parseDuration(s: string): number {
  const m = /^(\d+)d$/i.exec(s.trim());
  if (!m) throw new Error(`--older-than 格式非法(示例: 7d / 30d),得到: ${s}`);
  const days = Number(m[1]);
  if (days <= 0) throw new Error(`--older-than 天数必须 > 0,得到: ${s}`);
  return days * 24 * 60 * 60 * 1000;
}

/**
 * 计算将被 prune 的快照列表(基于 listSnapshots 的 epochMs)。
 * snapshots 已按最新在前排序(listSnapshots 的约定)。
 * 两个选项可组合:先 --keep-last 过滤(保留最近 N),再 --older-than 过滤(再剔除太旧的)。
 * 无选项则返回空列表(防止误删全部)。
 */
export function selectSnapshotsToRemove(
  snapshots: SnapshotInfo[],
  keepLast: number | undefined,
  olderThanMs: number | undefined,
): SnapshotInfo[] {
  // 候选集:初始为全部
  let candidates = snapshots;

  if (keepLast !== undefined) {
    // 保留最近 keepLast 个,其余为待删候选
    candidates = candidates.slice(keepLast);
  }

  if (olderThanMs !== undefined) {
    const cutoff = Date.now() - olderThanMs;
    candidates = candidates.filter((s) => s.createdAt.getTime() < cutoff);
  }

  // 安全守护:无任何过滤选项时返回空列表(防止误删全部)。
  // 注意:keepLast/olderThanMs 至少一个有效才走到这里,上层 CLI 已拒绝全 undefined 的情况;
  // 但作为纯函数,这里也自卫性地维护这个语义。
  if (keepLast === undefined && olderThanMs === undefined) return [];

  return candidates;
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
  // P3-D5:prune 作为 restore 的子命令——用 addCommand 挂到 restore 上,
  // 这样 Commander 能正确路由 `restore prune …` 而不与 `restore` 冲突。
  const pruneCmd = new Command('prune')
    .description('[P3] 清理旧快照(--keep-last N / --older-than Nd;--dry-run 只列将删)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--keep-last <n>', '保留最近 N 个快照,删除其余')
    .option('--older-than <duration>', '删除指定时间前的快照(如 7d / 30d)')
    .option('--dry-run', '只列出将被删除的快照,不真正删除')
    .option('--json', '机器可读 JSON 输出')
    .action(async (options: PruneCliOptions, cmd: Command) => {
      // --home / --json 解析:先看 prune 自身,再看祖先链(restore → 根)。
      // 原因:若 restore 命令自身也定义了 --json / --home,Commander 会把这些选项解析到
      // restore 的 opts,而不会传给 prune —— 因此 prune 需要主动向上查找。
      const parentOpts = cmd.parent?.opts<{ home?: string; json?: boolean }>();
      const parentHome = options.home ?? parentOpts?.home
        ?? cmd.parent?.parent?.opts<{ home?: string }>().home;
      const home = resolveHomeRoot(parentHome);
      // json 优先取 prune 自身(用户把 --json 放在 prune 后),回退到 restore 的解析结果
      const jsonOut = options.json ?? parentOpts?.json;
      const store = join(home, '.skill-switch', 'backups');
      const snapshots = await listSnapshots(store);

      const keepLast = options.keepLast !== undefined ? Number(options.keepLast) : undefined;
      if (keepLast !== undefined && (!Number.isInteger(keepLast) || keepLast < 0)) {
        throw new Error(`--keep-last 必须是非负整数,得到: ${options.keepLast}`);
      }

      const olderThanMs = options.olderThan !== undefined ? parseDuration(options.olderThan) : undefined;

      if (keepLast === undefined && olderThanMs === undefined) {
        throw new Error('restore prune 需要 --keep-last 或 --older-than(或两者组合)');
      }

      const toRemove = selectSnapshotsToRemove(snapshots, keepLast, olderThanMs);

      if (jsonOut) {
        console.log(JSON.stringify({
          dryRun: Boolean(options.dryRun),
          total: snapshots.length,
          toRemove: toRemove.map(viewOf),
          toKeep: snapshots.filter((s) => !toRemove.includes(s)).map(viewOf),
        }, null, 2));
      } else {
        console.log(`prune${options.dryRun ? ' [dry-run]' : ''}: ${toRemove.length}/${snapshots.length} 快照将被删除`);
        for (const snap of toRemove) {
          console.log(`  ${snap.createdAt.getTime()}  ${snap.label}  ${snap.createdAt.toISOString()}`);
        }
      }

      if (options.dryRun) return;

      // 真正删除:删 .tar.gz 及其 .json sidecar
      for (const snap of toRemove) {
        await rm(snap.path, { force: true });
        await rm(`${snap.path}.json`, { force: true });
      }

      if (!jsonOut) {
        console.log(`✓ 已删除 ${toRemove.length} 个快照`);
      }
    });

  const restoreCmd = program
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

      // 仅当 target 存在时才拍 pre-restore 快照:不存在时无内容可备份,
      // 与 snapshotAgents 对不存在根目录的处理保持一致。
      const safetySnapshot = existsSync(target)
        ? await snapshot(target, { store, label: 'pre-restore' })
        : null;
      await restoreSnapshot(selected.path, target);

      const result = {
        restored: true,
        target,
        snapshot: viewOf(selected),
        ...(safetySnapshot ? { safetySnapshot: viewOf(safetySnapshot) } : {}),
      };

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`restored: ${selected.path} → ${selected.sourceDir}`);
        if (safetySnapshot) console.log(`pre-restore snapshot: ${safetySnapshot.path}`);
      }
    });

  // prune 挂到 restore 下,成为 restore 的子命令
  restoreCmd.addCommand(pruneCmd);
}
