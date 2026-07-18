// WAL journal 单元测试:phase 流转 / 恢复矩阵 / 损坏与越界拒绝 / 回滚正确性。
// 崩溃(SIGKILL)级别的端到端矩阵在 tests/wal-install-kill.test.ts。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginJournal,
  captureFileState,
  journalPath,
  JournalRecoveryError,
  readPendingJournal,
  recoverPendingJournal,
  type OperationJournal,
} from '../src/core/journal.ts';
import { getSkillsLockPath } from '../src/core/lock.ts';
import { withOperationLock } from '../src/core/operation-lock.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from '../src/core/paths.ts';
import { readJsonState, writeJsonState } from '../src/core/state-io.ts';
import { getSkillsJsonPath } from '../src/core/sync.ts';

let home: string;

function skillsRoot(): string {
  const location = getAgentSkillsLocations().find((l) => l.agent === 'claude-code')!;
  return resolveGlobalSkillsDir(home, location);
}

async function writeRawJournal(value: unknown): Promise<void> {
  await writeJsonState(journalPath(home), value);
}

function baseJournal(overrides: Partial<OperationJournal> = {}): OperationJournal {
  return {
    version: 1,
    operation: 'install:claude-code',
    nonce: 'test-nonce',
    startedAt: new Date().toISOString(),
    phase: 'applying',
    preState: {
      declaration: { content: null },
      lockfile: { content: null },
      snapshots: [],
      targets: [],
      storeTargets: [],
    },
    steps: [],
    ...overrides,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wal-journal-'));
  mkdirSync(join(home, '.skill-switch'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('captureFileState', () => {
  it('captures existing content verbatim and maps ENOENT to null', async () => {
    const file = join(home, 'x.json');
    await writeFile(file, '{"a":1}\n');
    expect(await captureFileState(file)).toEqual({ content: '{"a":1}\n' });
    expect(await captureFileState(join(home, 'missing.json'))).toEqual({ content: null });
  });
});

describe('journal lifecycle', () => {
  it('walks prepare → applying → commit → clear with durable phase writes', async () => {
    const handle = await beginJournal(home, {
      operation: 'install:claude-code',
      nonce: 'n1',
      preState: baseJournal().preState,
      steps: ['s1'],
    });
    const readPhase = async () =>
      (await readJsonState<OperationJournal | undefined>(journalPath(home), undefined))?.phase;
    expect(await readPhase()).toBe('prepare');
    await handle.markApplying();
    expect(await readPhase()).toBe('applying');
    await handle.markStep('s1');
    const journal = await readJsonState<OperationJournal | undefined>(journalPath(home), undefined);
    expect(journal?.steps).toEqual([{ id: 's1', done: true }]);
    await handle.markCommit();
    expect(await readPhase()).toBe('commit');
    await handle.clear();
    expect(await readPendingJournal(home)).toBeUndefined();
  });
});

describe('recoverPendingJournal', () => {
  it('returns none without a journal', async () => {
    expect(await recoverPendingJournal(home)).toBe('none');
  });

  it('clears a prepare-phase journal without touching state', async () => {
    const declaration = getSkillsJsonPath(home);
    await writeFile(declaration, '{"v":"untouched"}\n');
    await writeRawJournal(baseJournal({ phase: 'prepare' }));
    expect(await recoverPendingJournal(home)).toBe('cleared-prepare');
    expect(await readPendingJournal(home)).toBeUndefined();
    expect(await readFile(declaration, 'utf8')).toBe('{"v":"untouched"}\n');
  });

  it('completes a commit-phase journal by deleting it (roll forward)', async () => {
    const declaration = getSkillsJsonPath(home);
    await writeFile(declaration, '{"v":"post-state"}\n');
    await writeRawJournal(baseJournal({
      phase: 'commit',
      preState: { ...baseJournal().preState, declaration: { content: '{"v":"pre"}\n' } },
    }));
    expect(await recoverPendingJournal(home)).toBe('completed-commit');
    // commit = 权威写已全部完成,绝不回滚。
    expect(await readFile(declaration, 'utf8')).toBe('{"v":"post-state"}\n');
  });

  it('rolls back declaration, lockfile and created targets for an applying journal', async () => {
    const declaration = getSkillsJsonPath(home);
    const lockfile = getSkillsLockPath(home);
    const target = join(skillsRoot(), 'crashed-skill');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), 'half written\n');
    await writeFile(declaration, '{"v":"torn"}\n');
    await writeFile(lockfile, '{"v":"torn-lock"}\n');

    await writeRawJournal(baseJournal({
      preState: {
        declaration: { content: '{"v":"pre-declaration"}\n' },
        lockfile: { content: null },
        snapshots: [],
        targets: [{ path: target, existedBefore: false }],
        storeTargets: [],
      },
    }));

    const log: string[] = [];
    expect(await recoverPendingJournal(home, { log: (m) => log.push(m) })).toBe('rolled-back');
    expect(await readFile(declaration, 'utf8')).toBe('{"v":"pre-declaration"}\n');
    expect(await captureFileState(lockfile)).toEqual({ content: null });
    expect(await captureFileState(join(target, 'SKILL.md'))).toEqual({ content: null });
    expect(await readPendingJournal(home)).toBeUndefined();
    expect(log.join('\n')).toContain('install:claude-code');
    expect(log.join('\n')).toContain('已自动恢复');
  });

  it('refuses corrupted journal files', async () => {
    await mkdir(join(home, '.skill-switch', 'journal'), { recursive: true });
    await writeFile(journalPath(home), 'not json at all');
    await expect(recoverPendingJournal(home)).rejects.toThrow(JournalRecoveryError);
  });

  it('refuses unknown journal versions', async () => {
    await writeRawJournal({ ...baseJournal(), version: 2 });
    await expect(recoverPendingJournal(home)).rejects.toThrow(JournalRecoveryError);
  });

  it('refuses out-of-boundary snapshot and target paths (tamper resistance)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wal-outside-'));
    try {
      await writeRawJournal(baseJournal({
        preState: {
          ...baseJournal().preState,
          snapshots: [{ path: join(outside, 'x.tar.gz'), sourceDir: skillsRoot() }],
        },
      }));
      await expect(recoverPendingJournal(home)).rejects.toThrow(/越界/);

      await writeRawJournal(baseJournal({
        preState: {
          ...baseJournal().preState,
          snapshots: [{
            path: join(home, '.skill-switch', 'backups', 'x.tar.gz'),
            sourceDir: join(outside, '.ssh'),
          }],
        },
      }));
      await expect(recoverPendingJournal(home)).rejects.toThrow(/越界/);

      await writeRawJournal(baseJournal({
        preState: {
          ...baseJournal().preState,
          targets: [{ path: join(outside, 'anywhere'), existedBefore: false }],
        },
      }));
      await expect(recoverPendingJournal(home)).rejects.toThrow(/越界/);
      // 拒绝恢复时越界目标必须原样未动。
      expect(await captureFileState(join(outside, 'anywhere'))).toEqual({ content: null });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('is wired into withOperationLock (auto-recovery before every locked write)', async () => {
    const declaration = getSkillsJsonPath(home);
    await writeFile(declaration, '{"v":"torn"}\n');
    await writeRawJournal(baseJournal({
      preState: {
        ...baseJournal().preState,
        declaration: { content: '{"v":"pre"}\n' },
      },
    }));
    await withOperationLock(home, 'test-op', async () => {
      // action 开始时恢复必须已经完成。
      expect(await readFile(declaration, 'utf8')).toBe('{"v":"pre"}\n');
    });
    expect(await readPendingJournal(home)).toBeUndefined();
  });

  it('aborts the locked operation when recovery is refused', async () => {
    await writeRawJournal({ ...baseJournal(), version: 99 });
    let ran = false;
    await expect(withOperationLock(home, 'test-op', async () => {
      ran = true;
    })).rejects.toThrow(JournalRecoveryError);
    expect(ran).toBe(false);
  });
});
