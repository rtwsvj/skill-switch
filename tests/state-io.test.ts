// M0-5.1 / 5.2:关键状态文件的读不静默吞错、写原子。
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readJsonState, StateFileError, writeJsonState } from '../src/core/state-io.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skill-switch-stateio-'));
});

function runCli(args: string[]): { status: number; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PAGER: '', GIT_PAGER: '' },
  });
  return { status: result.status ?? -1, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
}

describe('core/state-io readJsonState', () => {
  it('returns fallback only when the file is absent (ENOENT)', async () => {
    const value = await readJsonState(join(dir, 'missing.json'), { version: 1, skills: [] });
    expect(value).toEqual({ version: 1, skills: [] });
  });

  it('throws StateFileError on malformed JSON (never silently empty)', async () => {
    const path = join(dir, 'broken.json');
    await writeFile(path, '{ this is not json ');
    await expect(readJsonState(path, { skills: [] })).rejects.toBeInstanceOf(StateFileError);
  });

  it('throws on non-ENOENT IO errors (e.g. path is a directory)', async () => {
    const path = join(dir, 'a-directory');
    await mkdir(path);
    await expect(readJsonState(path, null)).rejects.toBeInstanceOf(StateFileError);
  });
});

describe('core/state-io writeJsonState', () => {
  it('writes parseable JSON with a trailing newline and 0o600', async () => {
    const path = join(dir, 'out.json');
    await writeJsonState(path, { version: 1, skills: ['a'] });
    const raw = await readFile(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual({ version: 1, skills: ['a'] });
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it('overwrites atomically and leaves no temp file behind', async () => {
    const path = join(dir, 'out.json');
    await writeJsonState(path, { v: 1 });
    await writeJsonState(path, { v: 2 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ v: 2 });
    const leftovers = (await readdir(dir)).filter((e) => e.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('on write failure keeps the original intact and cleans up the temp file', async () => {
    if (process.platform === 'win32') return; // 只读目录语义不同,跳过
    const sub = join(dir, 'locked');
    await mkdir(sub);
    const path = join(sub, 'state.json');
    await writeJsonState(path, { keep: true });
    await chmod(sub, 0o500); // 只读目录 → 临时文件创建失败
    try {
      await expect(writeJsonState(path, { keep: false })).rejects.toBeTruthy();
      await chmod(sub, 0o700);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ keep: true }); // 原文件不变
      expect((await readdir(sub)).filter((e) => e.includes('.tmp'))).toEqual([]); // 无残留临时文件
    } finally {
      await chmod(sub, 0o700).catch(() => undefined);
    }
  });
});

describe('CLI: corrupt state files are not silently treated as empty', () => {
  async function writeState(name: string, body: string): Promise<void> {
    await mkdir(join(dir, '.skill-switch'), { recursive: true });
    await writeFile(join(dir, '.skill-switch', name), body);
  }

  it('sync --dry-run --json exits non-zero on a corrupt skills.json', async () => {
    await writeState('skills.json', '{ broken json ');
    const { status, stderr } = runCli(['sync', '--dry-run', '--json', '--home', dir]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/skills\.json|JSON/);
  });

  it('lock --verify --json exits non-zero on a corrupt skills.lock.json', async () => {
    await writeState('skills.lock.json', 'not json at all');
    const { status } = runCli(['lock', '--verify', '--json', '--home', dir]);
    expect(status).not.toBe(0);
  });

  it('first run with no state files still works (exit 0)', async () => {
    const { status } = runCli(['sync', '--dry-run', '--json', '--home', dir]);
    expect(status).toBe(0);
  });
});

afterAll(() => {
  // 临时目录留给 OS 清理
});
