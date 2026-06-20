// 关键状态文件(skills.json / skills.lock.json 等)的统一 IO 原语。
//
// 为什么需要它:旧的 readDeclaration/readSkillsLock 把"读不到/JSON 损坏"一律 catch 成空,
// 于是一个损坏的 skills.json 会被当成"什么都没声明",后续写入可能把它永久覆盖成空、
// 静默丢掉整份声明。这里把"文件不存在"和"文件坏了"严格区分开:
//   - readJsonState:仅 ENOENT 返回 fallback;JSON 损坏 / 权限 / 其它 IO 错误一律抛 StateFileError。
//   - writeJsonState:同目录临时文件 → fsync → rename 覆盖,失败清理临时文件、不留半写目标。
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
 * 原子写 JSON 状态文件:同目录临时文件 → best-effort fsync → rename 覆盖。
 * 失败时清理临时文件,绝不留下半写的目标文件。尾随换行,权限 best-effort 0o600。
 */
export async function writeJsonState(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const body = `${JSON.stringify(value, null, 2)}\n`;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, 'w', 0o600);
    await handle.writeFile(body, 'utf8');
    await handle.sync().catch(() => undefined); // best-effort fsync,失败不致命
    await handle.close();
    handle = undefined;
    await rename(tmp, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
