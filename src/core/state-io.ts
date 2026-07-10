// 关键状态文件(skills.json / skills.lock.json 等)的统一 IO 原语。
//
// 为什么需要它:旧的 readDeclaration/readSkillsLock 把"读不到/JSON 损坏"一律 catch 成空,
// 于是一个损坏的 skills.json 会被当成"什么都没声明",后续写入可能把它永久覆盖成空、
// 静默丢掉整份声明。这里把"文件不存在"和"文件坏了"严格区分开:
//   - readJsonState:仅 ENOENT 返回 fallback;JSON 损坏 / 权限 / 其它 IO 错误一律抛 StateFileError。
//   - writeJsonState:同目录临时文件 → fsync → rename 覆盖,失败清理临时文件、不留半写目标。
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export class StateFileError extends Error {
  readonly path: string;
  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StateFileError';
    this.path = path;
  }
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return Boolean(error) && (error as NodeJS.ErrnoException).code === code;
}

/**
 * 读取 JSON 状态文件。仅当文件不存在(ENOENT)时返回 fallback;
 * JSON 损坏 / 权限 / 其它 IO 错误一律抛 StateFileError —— 绝不静默当空。
 */
export async function readJsonState<T>(path: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return fallback;
    throw new StateFileError(
      `无法读取状态文件 ${path}: ${(error as Error).message}`,
      path,
      { cause: error },
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new StateFileError(
      `状态文件 JSON 损坏 ${path}: ${(error as Error).message}`,
      path,
      { cause: error },
    );
  }
}

/**
 * 原子写 JSON 状态文件:同目录唯一临时文件 → fsync → rename 覆盖 → 目录 fsync。
 * 失败时清理临时文件,绝不留下半写的目标文件。尾随换行,权限 best-effort 0o600。
 */
export async function writeJsonState(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const body = `${JSON.stringify(value, null, 2)}\n`;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, 'w', 0o600);
    await handle.writeFile(body, 'utf8');
    // 数据未落盘就不能声称状态写成功；失败必须向调用者传播。
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, path);

    // POSIX 上 rename 的目录项也需要落盘。部分平台/文件系统不允许打开目录，
    // 因而这里只把目录 fsync 作为可移植的 best-effort 加固。
    let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      directoryHandle = await open(dir, 'r');
      await directoryHandle.sync();
    } catch {
      // rename 已成功；不因平台不支持目录 fsync 而把成功写入报告为失败。
    } finally {
      await directoryHandle?.close().catch(() => undefined);
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
