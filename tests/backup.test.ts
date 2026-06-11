// S3.1:备份原语 — tar 快照 + restore 的 roundtrip 测试。
// 全程在临时目录写入,不碰真实 agent 配置目录。
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSnapshots, restoreSnapshot, snapshot } from '../src/core/backup.ts';

let work: string;
let target: string;
let store: string;

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), 'skill-switch-backup-'));
  target = join(work, 'skills');
  store = join(work, 'store');
  await mkdir(join(target, 'a'), { recursive: true });
  await writeFile(join(target, 'a', 'SKILL.md'), 'original A\n');
  await writeFile(join(target, 'top.txt'), 'hello\n');
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('core/backup', () => {
  it('snapshot then restore recovers byte-identical content after edits', async () => {
    const snap = await snapshot(target, { store, label: 'before-sync' });
    expect(snap.path).toContain(store);

    // 破坏现场:改一个文件、删一个文件、加一个文件
    await writeFile(join(target, 'a', 'SKILL.md'), 'TAMPERED\n');
    await rm(join(target, 'top.txt'));
    await writeFile(join(target, 'injected.sh'), 'rm -rf /\n');

    await restoreSnapshot(snap.path, target);

    expect(await readFile(join(target, 'a', 'SKILL.md'), 'utf8')).toBe('original A\n');
    expect(await readFile(join(target, 'top.txt'), 'utf8')).toBe('hello\n');
    const entries = await readdir(target);
    expect(entries).not.toContain('injected.sh');
  });

  it('records snapshots with timestamp + label and lists them newest-first', async () => {
    const s1 = await snapshot(target, { store, label: 'first' });
    await new Promise((r) => setTimeout(r, 1100)); // 保证时间戳不同(秒级)
    const s2 = await snapshot(target, { store, label: 'second' });

    const list = await listSnapshots(store);
    expect(list.length).toBe(2);
    expect(list[0]!.path).toBe(s2.path); // newest first
    expect(list[1]!.path).toBe(s1.path);
    expect(list[0]!.label).toBe('second');
    expect(list[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(list[1]!.createdAt.getTime());
  });

  it('listSnapshots on a missing store returns empty (no throw)', async () => {
    expect(await listSnapshots(join(work, 'nope'))).toEqual([]);
  });

  it('restore is atomic: a failed extract leaves the target untouched', async () => {
    const snap = await snapshot(target, { store, label: 'safe' });
    await expect(restoreSnapshot(join(store, 'does-not-exist.tar.gz'), target)).rejects.toThrow();
    // 原内容仍在
    expect(await readFile(join(target, 'a', 'SKILL.md'), 'utf8')).toBe('original A\n');
    expect(snap.path).toContain('safe');
  });
});
