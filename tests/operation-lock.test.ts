import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireOperationLock,
  OperationLockedError,
  withOperationLock,
} from '../src/core/operation-lock.ts';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'skill-switch-operation-lock-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('home-scoped operation lock', () => {
  it('serializes concurrent writers', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withOperationLock(home, 'first', async () => {
      order.push('first-start');
      await hold;
      order.push('first-end');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = withOperationLock(home, 'second', async () => {
      order.push('second-start');
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('releases the lock when the operation throws', async () => {
    await expect(withOperationLock(home, 'failing', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    await expect(withOperationLock(home, 'next', async () => 'ok')).resolves.toBe('ok');
  });

  it('reclaims an owner whose process no longer exists', async () => {
    const lockPath = join(home, '.skill-switch', 'operation.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      nonce: 'dead-owner',
      operation: 'crashed',
      startedAt: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString(),
    }));

    const handle = await acquireOperationLock(home, 'recovery', { waitMs: 100 });
    expect(handle.owner.operation).toBe('recovery');
    await handle.release();
  });

  it('does not steal a lock owned by a live process', async () => {
    const lockPath = join(home, '.skill-switch', 'operation.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      version: 1,
      pid: process.pid,
      nonce: 'live-owner',
      operation: 'still-running',
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }));

    await expect(acquireOperationLock(home, 'contender', {
      waitMs: 25,
      pollMs: 10,
    })).rejects.toBeInstanceOf(OperationLockedError);
    expect(JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'))).toMatchObject({
      nonce: 'live-owner',
    });
  });

  it('never removes a replacement lock with a different nonce', async () => {
    const handle = await acquireOperationLock(home, 'original');
    await writeFile(join(handle.path, 'owner.json'), JSON.stringify({
      ...handle.owner,
      nonce: 'replacement-owner',
    }));

    await handle.release();
    expect(JSON.parse(await readFile(join(handle.path, 'owner.json'), 'utf8'))).toMatchObject({
      nonce: 'replacement-owner',
    });
  });
});
