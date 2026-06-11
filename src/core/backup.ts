// S3.1 备份原语:对目标目录做 tar.gz 时间戳快照,支持还原。
// 用系统 tar(execFile),不引入 npm 依赖。所有写入落在调用方给定的 store/target,
// 任何对真实 agent 目录的写操作由上层命令在快照兜底后显式发起。
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SnapshotInfo {
  path: string;
  label: string;
  createdAt: Date;
}

export interface SnapshotOptions {
  /** 快照归档存放目录 */
  store: string;
  /** 人读标签(会被 slug 化进文件名) */
  label: string;
}

// 文件名:`<epochMs>__<slug-label>.tar.gz`。epochMs 前缀保证可排序且几乎不碰撞。
const SNAP_RE = /^(\d+)__(.*)\.tar\.gz$/;

function slug(label: string): string {
  return label.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'snapshot';
}

export async function snapshot(target: string, options: SnapshotOptions): Promise<SnapshotInfo> {
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error(`snapshot target is not a directory: ${target}`);

  await mkdir(options.store, { recursive: true });
  const createdAt = new Date();
  const name = `${createdAt.getTime()}__${slug(options.label)}.tar.gz`;
  const path = join(options.store, name);

  // -C target . :归档目标目录的内容(相对根),还原时可直接铺回目标目录
  await execFileAsync('tar', ['-czf', path, '-C', target, '.']);
  return { path, label: slug(options.label), createdAt };
}

export async function listSnapshots(store: string): Promise<SnapshotInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(store);
  } catch {
    return [];
  }
  const snaps: SnapshotInfo[] = [];
  for (const entry of entries) {
    const m = SNAP_RE.exec(entry);
    if (!m) continue;
    snaps.push({
      path: join(store, entry),
      label: m[2]!,
      createdAt: new Date(Number(m[1])),
    });
  }
  // 最新在前
  snaps.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return snaps;
}

export async function restoreSnapshot(snapshotPath: string, target: string): Promise<void> {
  // 先验证归档存在 —— 失败必须在动 target 之前,保证还原对失败具原子性
  await stat(snapshotPath);

  const staging = mkdtempSync(join(tmpdir(), 'skill-switch-restore-'));
  try {
    // 先解到暂存区:解压失败时 target 完全未被触碰
    await execFileAsync('tar', ['-xzf', snapshotPath, '-C', staging]);
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    throw cause;
  }

  // 解压成功才替换:清空 target 再铺回
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(staging, target, { recursive: true });
  await rm(staging, { recursive: true, force: true });
}
