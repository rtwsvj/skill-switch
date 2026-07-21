import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { recoverPendingJournal } from './journal.ts';
import { writeJsonState } from './state-io.ts';

const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_INVALID_OWNER_STALE_MS = 60_000;

interface OperationLockOwner {
  version: 1;
  pid: number;
  nonce: string;
  operation: string;
  startedAt: string;
  heartbeatAt: string;
}

export interface OperationLockOptions {
  waitMs?: number;
  pollMs?: number;
  invalidOwnerStaleMs?: number;
  signal?: AbortSignal;
}

export interface OperationLockHandle {
  path: string;
  owner: Readonly<OperationLockOwner>;
  release(): Promise<void>;
}

export class OperationLockedError extends Error {
  constructor(
    message: string,
    readonly lockPath: string,
  ) {
    super(message);
    this.name = 'OperationLockedError';
  }
}

function lockDirectory(home: string): string {
  return join(home, '.skill-switch', 'operation.lock');
}

function ownerPath(lockPath: string): string {
  return join(lockPath, 'owner.json');
}

function isOwner(value: unknown): value is OperationLockOwner {
  if (!value || typeof value !== 'object') return false;
  const owner = value as Partial<OperationLockOwner>;
  return owner.version === 1 && Number.isInteger(owner.pid) && (owner.pid ?? 0) > 0 &&
    typeof owner.nonce === 'string' && owner.nonce.length > 0 &&
    typeof owner.operation === 'string' &&
    typeof owner.startedAt === 'string' && typeof owner.heartbeatAt === 'string';
}

async function readOwner(lockPath: string): Promise<OperationLockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(ownerPath(lockPath), 'utf8'));
    return isOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function quarantineAndRemove(lockPath: string, expectedNonce?: string): Promise<boolean> {
  if (expectedNonce !== undefined) {
    const current = await readOwner(lockPath);
    if (current?.nonce !== expectedNonce) return false;
  }
  const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function recoverAbandonedLock(
  lockPath: string,
  invalidOwnerStaleMs: number,
): Promise<boolean> {
  const owner = await readOwner(lockPath);
  if (owner) {
    if (isProcessAlive(owner.pid)) return false;
    return quarantineAndRemove(lockPath, owner.nonce);
  }

  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < invalidOwnerStaleMs) return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  return quarantineAndRemove(lockPath);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('operation lock wait aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('operation lock wait aborted'));
    }, { once: true });
  });
}

export async function acquireOperationLock(
  home: string,
  operation: string,
  options: OperationLockOptions = {},
): Promise<OperationLockHandle> {
  const lockPath = lockDirectory(home);
  const waitMs = Math.max(0, options.waitMs ?? DEFAULT_WAIT_MS);
  const pollMs = Math.max(10, options.pollMs ?? DEFAULT_POLL_MS);
  const invalidOwnerStaleMs = Math.max(
    0,
    options.invalidOwnerStaleMs ?? DEFAULT_INVALID_OWNER_STALE_MS,
  );
  const deadline = Date.now() + waitMs;
  await mkdir(join(home, '.skill-switch'), { recursive: true });

  for (;;) {
    options.signal?.throwIfAborted();
    try {
      await mkdir(lockPath);
      const now = new Date().toISOString();
      const owner: OperationLockOwner = {
        version: 1,
        pid: process.pid,
        nonce: randomUUID(),
        operation,
        startedAt: now,
        heartbeatAt: now,
      };
      try {
        await writeJsonState(ownerPath(lockPath), owner);
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }

      let released = false;
      return {
        path: lockPath,
        owner,
        async release(): Promise<void> {
          if (released) return;
          released = true;
          await quarantineAndRemove(lockPath, owner.nonce);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    if (await recoverAbandonedLock(lockPath, invalidOwnerStaleMs)) continue;
    if (Date.now() >= deadline) {
      const owner = await readOwner(lockPath);
      const detail = owner
        ? `pid=${owner.pid}, operation=${owner.operation}, since=${owner.startedAt}`
        : 'owner metadata unavailable';
      throw new OperationLockedError(`另一个 skill-switch 写操作正在进行 (${detail})`, lockPath);
    }
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), options.signal);
  }
}

export async function withOperationLock<T>(
  home: string,
  operation: string,
  action: (lock: OperationLockHandle) => Promise<T>,
  options: OperationLockOptions = {},
): Promise<T> {
  const lock = await acquireOperationLock(home, operation, options);
  try {
    // WAL:上一次写事务若被 SIGKILL/断电中断,先确定性恢复再进入本次操作。
    // 恢复失败(日志损坏/路径越界)会抛出并中止本次操作——状态不确定时绝不叠加新写。
    await recoverPendingJournal(home, { log: (message) => console.error(message) });
    return await action(lock);
  } finally {
    await lock.release();
  }
}
