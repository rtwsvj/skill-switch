// A1: gap-fill — safe-copy.ts (copyDirWithoutSymlinks) 分支覆盖
import { mkdtempSync, symlinkSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { copyDirWithoutSymlinks } from '../src/core/safe-copy.ts';

let src: string;
let dst: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'safe-copy-'));
  src = join(base, 'src');
  dst = join(base, 'dst');
});

describe('copyDirWithoutSymlinks', () => {
  it('copies a nested directory tree (files only, no symlinks)', async () => {
    await mkdir(join(src, 'sub'), { recursive: true });
    await writeFile(join(src, 'root.txt'), 'root');
    await writeFile(join(src, 'sub', 'child.txt'), 'child');

    await copyDirWithoutSymlinks(src, dst);

    expect(await readFile(join(dst, 'root.txt'), 'utf8')).toBe('root');
    expect(await readFile(join(dst, 'sub', 'child.txt'), 'utf8')).toBe('child');
  });

  it('silently skips symlinks at the directory level', async () => {
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'real.txt'), 'real');
    // create a symlink inside src — should be skipped
    symlinkSync(join(src, 'real.txt'), join(src, 'link.txt'));

    await copyDirWithoutSymlinks(src, dst);

    expect(await readFile(join(dst, 'real.txt'), 'utf8')).toBe('real');
    // link.txt must NOT be copied
    await expect(lstat(join(dst, 'link.txt'))).rejects.toThrow();
  });

  it('returns early without writing anything when source is itself a symlink', async () => {
    await mkdir(join(src, 'real'), { recursive: true });
    await writeFile(join(src, 'real', 'file.txt'), 'content');
    const symTarget = `${src}-sym`;
    symlinkSync(join(src, 'real'), symTarget);

    // should no-op (symlink source)
    await copyDirWithoutSymlinks(symTarget, dst);

    // dst should not exist (or be empty) — just check lstat rejects
    await expect(lstat(dst)).rejects.toThrow();
  });

  it('can copy a single file (source is a plain file, not a dir)', async () => {
    await mkdir(src, { recursive: true });
    const srcFile = join(src, 'only.txt');
    await writeFile(srcFile, 'single');
    const dstFile = join(dst, 'only.txt');

    await copyDirWithoutSymlinks(srcFile, dstFile);

    expect(await readFile(dstFile, 'utf8')).toBe('single');
  });
});
