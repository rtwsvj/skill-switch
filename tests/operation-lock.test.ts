import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireOperationLock,
  OperationLockedError,
  withOperationLock,
} from '../src/core/operation-lock.ts';
import { installFromSource } from '../src/core/install.ts';
import { getSkillsLockPath, readSkillsLock } from '../src/core/lock.ts';
import { removeSkill } from '../src/core/remove.ts';
import {
  applySync,
  getSkillsJsonPath,
  readDeclaration,
  type SkillsDeclarationFile,
} from '../src/core/sync.ts';

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

async function writeSkill(name: string): Promise<string> {
  const source = join(home, 'sources', name);
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, 'SKILL.md'),
    `---\nname: ${name}\ndescription: operation lock fixture ${name}.\n---\n\nSafe fixture.\n`,
  );
  return source;
}

describe('public writer integration', () => {
  it('serializes concurrent installs and preserves every lock/declaration update', async () => {
    const sources = await Promise.all(['alpha', 'bravo', 'charlie'].map(writeSkill));
    const held = await acquireOperationLock(home, 'test-hold');

    const installs = sources.map((source) =>
      installFromSource(source, { home, agent: 'claude-code', mode: 'copy' }),
    );

    // Public writers must not reach their target mutations while another owner holds the home lock.
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      await expect(lstat(join(home, '.claude', 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await held.release();
    }
    await Promise.all(installs);

    expect((await readSkillsLock(getSkillsLockPath(home))).skills.map((entry) => entry.name).sort())
      .toEqual(['alpha', 'bravo', 'charlie']);
    expect((await readDeclaration(getSkillsJsonPath(home))).skills.map((entry) => entry.name).sort())
      .toEqual(['alpha', 'bravo', 'charlie']);
    await Promise.all(
      ['alpha', 'bravo', 'charlie'].map((name) =>
        lstat(join(home, '.claude', 'skills', name)),
      ),
    );
  });

  it('locks direct applySync callers instead of only CLI orchestration', async () => {
    const source = await writeSkill('delta');
    const declaration: SkillsDeclarationFile = {
      version: 1,
      skills: [
        {
          name: 'delta',
          source,
          agents: ['claude-code'],
          enabled: true,
          mode: 'copy',
        },
      ],
    };
    const held = await acquireOperationLock(home, 'test-hold');
    const syncing = applySync(home, declaration);

    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      await expect(lstat(join(home, '.claude', 'skills', 'delta'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await held.release();
    }
    await expect(syncing).resolves.toMatchObject({
      actions: [expect.objectContaining({ name: 'delta', kind: 'create' })],
    });
    await lstat(join(home, '.claude', 'skills', 'delta', 'SKILL.md'));
  });

  it('releases the home lock when a public writer fails', async () => {
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(getSkillsLockPath(home), '{broken json');

    await expect(removeSkill(home, 'delta', 'claude-code')).rejects.toThrow();

    const next = await acquireOperationLock(home, 'after-remove-error', { waitMs: 50 });
    expect(next.owner.operation).toBe('after-remove-error');
    await next.release();
  });
});
