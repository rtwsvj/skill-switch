// S3.1 备份原语:对目标目录做 tar.gz 时间戳快照,支持还原。
// 用系统 tar(execFile),不引入 npm 依赖。所有写入落在调用方给定的 store/target,
// 任何对真实 agent 目录的写操作由上层命令在快照兜底后显式发起。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SnapshotInfo {
  path: string;
  label: string;
  createdAt: Date;
  sourceDir?: string;
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
  const label = slug(options.label);
  const name = `${createdAt.getTime()}__${label}.tar.gz`;
  const path = join(options.store, name);

  // -C target . :归档目标目录的内容(相对根),还原时可直接铺回目标目录
  await execFileAsync('tar', ['-czf', path, '-C', target, '.']);
  await writeFile(
    `${path}.json`,
    `${JSON.stringify({ sourceDir: target, label, createdAt: createdAt.toISOString() }, null, 2)}\n`,
    'utf8',
  );
  return { path, label, createdAt, sourceDir: target };
}

async function readSnapshotSourceDir(path: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(`${path}.json`, 'utf8')) as { sourceDir?: unknown };
    return typeof parsed.sourceDir === 'string' ? parsed.sourceDir : undefined;
  } catch {
    return undefined;
  }
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
    const path = join(store, entry);
    snaps.push({
      path: join(store, entry),
      label: m[2]!,
      createdAt: new Date(Number(m[1])),
      sourceDir: await readSnapshotSourceDir(path),
    });
  }
  // 最新在前
  snaps.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return snaps;
}

/** 防 tar path-traversal:拒绝任何绝对路径或含 `..` 段的条目(快照应只含目标目录内容)。 */
async function assertSafeArchive(snapshotPath: string): Promise<void> {
  const { stdout } = await execFileAsync('tar', ['-tzf', snapshotPath]);
  for (const raw of stdout.split('\n')) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith('/') || entry.split('/').some((seg) => seg === '..')) {
      throw new Error(`快照含不安全路径,拒绝还原: ${entry}`);
    }
  }
}

export async function restoreSnapshot(snapshotPath: string, target: string): Promise<void> {
  // 先验证归档存在 + 路径安全 —— 都必须在动 target 之前,保证还原对失败具原子性。
  await stat(snapshotPath);
  await assertSafeArchive(snapshotPath);

  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  // staging 与 target 同文件系统(放 target 的父目录下),保证后续 rename 可用,避免跨设备 EXDEV。
  const staging = await mkdtemp(join(parent, '.skill-switch-restore-'));
  const backup = `${target}.restore-bak-${Date.now()}`;
  let backedUp = false;
  try {
    // 先解到暂存区:解压失败时 target 完全未被触碰。
    await execFileAsync('tar', ['-xzf', snapshotPath, '-C', staging]);

    // 原子换入:先把现有 target 挪到 backup(保留恢复路径),再把 staging rename 成 target;失败回滚。
    if (existsSync(target)) {
      await rename(target, backup);
      backedUp = true;
    }
    try {
      await rename(staging, target);
    } catch (swapError) {
      if (backedUp) await rename(backup, target).catch(() => undefined); // 回滚,target 不半恢复
      throw swapError;
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (backedUp) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  }
}
