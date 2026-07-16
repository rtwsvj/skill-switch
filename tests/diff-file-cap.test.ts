// 卡 A:skill-diff 每文件字节上限 + 二进制检测 + 确定性 oversized 报告
import { mkdirSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_DIFF_FILE_BYTES,
  buildUnifiedDiffText,
  diffSkillWithContents,
  generateUnifiedDiff,
} from '../src/core/skill-diff.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from '../src/core/paths.ts';

const AGENT = 'claude-code';
/** 临时 HOME 只建在 worktree 内,用完删除。 */
const TMP_ROOT = './.tmp-test/diff-file-cap';
let home: string;
let caseId = 0;

function diskDir(name: string): string {
  const loc = getAgentSkillsLocations().find((l) => l.agent === AGENT)!;
  return join(resolveGlobalSkillsDir(home, loc), name);
}
function storeDir(name: string): string {
  return join(home, '.skill-switch', 'store', AGENT, name);
}

beforeEach(() => {
  caseId += 1;
  home = join(TMP_ROOT, `case-${caseId}`);
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('MAX_DIFF_FILE_BYTES', () => {
  it('defaults to 8 MiB', () => {
    expect(MAX_DIFF_FILE_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('binary detection (generateUnifiedDiff)', () => {
  it('reports binary when either side contains NUL in the first 8192 bytes', () => {
    const text = Buffer.from('hello\nworld\n');
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a]); // PNG-ish + NUL
    const patch = generateUnifiedDiff('icon.bin', text, binary);
    expect(patch).toBe('Binary files a/icon.bin and b/icon.bin differ');
    // 无 +/- 内容行
    expect(patch.split('\n').some((l) => l.startsWith('+') || l.startsWith('-'))).toBe(false);
  });

  it('reports binary for single-sided content that is binary', () => {
    const binary = Buffer.from([0x00, 0x01, 0x02]);
    const added = generateUnifiedDiff('new.bin', undefined, binary);
    expect(added).toBe('Binary files a/new.bin and b/new.bin differ');
    const removed = generateUnifiedDiff('gone.bin', binary, undefined);
    expect(removed).toBe('Binary files a/gone.bin and b/gone.bin differ');
  });
});

describe('per-file byte cap + oversized report', () => {
  it('marks modified oversized files without loading contents', async () => {
    const name = 'big-mod';
    const limit = 1024;
    const big = Buffer.alloc(2048, 0x41); // 2 KiB of 'A'
    const other = Buffer.alloc(2048, 0x42); // 2 KiB of 'B' — different content

    await mkdir(storeDir(name), { recursive: true });
    await writeFile(join(storeDir(name), 'huge.bin'), big);
    await mkdir(diskDir(name), { recursive: true });
    await writeFile(join(diskDir(name), 'huge.bin'), other);

    const result = await diffSkillWithContents(home, AGENT, name, { maxFileBytes: limit });
    expect(result.diff.comparable).toBe(true);

    const file = result.diff.files.find((f) => f.path === 'huge.bin');
    expect(file).toBeDefined();
    expect(file!.status).toBe('modified');
    expect(file!.oversized).toBe(true);
    expect(file!.diskBytes).toBe(2048);
    expect(file!.storeBytes).toBe(2048);

    expect(result.diskFiles.has('huge.bin')).toBe(false);
    expect(result.storeFiles.has('huge.bin')).toBe(false);

    const patch = buildUnifiedDiffText(result.diff, result.diskFiles, result.storeFiles);
    expect(patch).toContain(
      '@@ oversized file skipped: disk=2048B store=2048B limit=1024B @@',
    );
    expect(patch).toContain('--- a/huge.bin');
    expect(patch).toContain('+++ b/huge.bin');
  });

  it('reports store=absent for added oversized file (disk-only)', async () => {
    const name = 'big-add';
    const limit = 1024;
    const big = Buffer.alloc(2048, 0x43);

    await mkdir(storeDir(name), { recursive: true });
    await writeFile(join(storeDir(name), 'SKILL.md'), 'base\n');
    await mkdir(diskDir(name), { recursive: true });
    await writeFile(join(diskDir(name), 'SKILL.md'), 'base\n');
    await writeFile(join(diskDir(name), 'blob.bin'), big);

    const result = await diffSkillWithContents(home, AGENT, name, { maxFileBytes: limit });
    const file = result.diff.files.find((f) => f.path === 'blob.bin');
    expect(file).toMatchObject({
      status: 'added',
      oversized: true,
      diskBytes: 2048,
    });
    expect(file!.storeBytes).toBeUndefined();
    expect(result.diskFiles.has('blob.bin')).toBe(false);

    const patch = buildUnifiedDiffText(result.diff, result.diskFiles, result.storeFiles);
    expect(patch).toContain(
      '@@ oversized file skipped: disk=2048B store=absent limit=1024B @@',
    );
  });

  it('keeps normal text hunks when mixed with an oversized file', async () => {
    const name = 'mixed';
    const limit = 1024;
    const big = Buffer.alloc(2048, 0x44);
    const bigOther = Buffer.alloc(2048, 0x45);

    await mkdir(storeDir(name), { recursive: true });
    await writeFile(join(storeDir(name), 'SKILL.md'), '---\nname: mixed\n---\nold\n');
    await writeFile(join(storeDir(name), 'huge.bin'), big);

    await mkdir(diskDir(name), { recursive: true });
    await writeFile(join(diskDir(name), 'SKILL.md'), '---\nname: mixed\n---\nnew\n');
    await writeFile(join(diskDir(name), 'huge.bin'), bigOther);

    const result = await diffSkillWithContents(home, AGENT, name, { maxFileBytes: limit });
    const byPath = Object.fromEntries(result.diff.files.map((f) => [f.path, f]));

    expect(byPath['SKILL.md']?.status).toBe('modified');
    expect(byPath['SKILL.md']?.oversized).toBeUndefined();
    expect(byPath['huge.bin']?.oversized).toBe(true);

    expect(result.diskFiles.has('SKILL.md')).toBe(true);
    expect(result.storeFiles.has('SKILL.md')).toBe(true);
    expect(result.diskFiles.has('huge.bin')).toBe(false);

    const patch = buildUnifiedDiffText(result.diff, result.diskFiles, result.storeFiles);
    expect(patch).toContain('--- a/SKILL.md');
    expect(patch).toContain('-old');
    expect(patch).toContain('+new');
    expect(patch).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(patch).toContain(
      '@@ oversized file skipped: disk=2048B store=2048B limit=1024B @@',
    );
  });

  it('binary content via disk/store maps yields Binary files line', async () => {
    const name = 'bin-pair';
    const text = Buffer.from('plain text v1\n');
    const binary = Buffer.concat([Buffer.from('plain '), Buffer.from([0x00]), Buffer.from('bin\n')]);

    await mkdir(storeDir(name), { recursive: true });
    await writeFile(join(storeDir(name), 'data.bin'), text);
    await mkdir(diskDir(name), { recursive: true });
    await writeFile(join(diskDir(name), 'data.bin'), binary);

    const result = await diffSkillWithContents(home, AGENT, name);
    expect(result.diff.files).toEqual([{ path: 'data.bin', status: 'modified' }]);
    expect(result.diskFiles.has('data.bin')).toBe(true);

    const patch = buildUnifiedDiffText(result.diff, result.diskFiles, result.storeFiles);
    expect(patch).toContain('Binary files a/data.bin and b/data.bin differ');
    // 无 +/- 内容行(Binary 行本身也不以 +/- 开头)
    const contentLines = patch.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-'));
    expect(contentLines).toHaveLength(0);
  });

  it('without options, small files match prior byte-for-byte unified output', async () => {
    const name = 'regression-small';
    await mkdir(storeDir(name), { recursive: true });
    await writeFile(join(storeDir(name), 'SKILL.md'), '---\nname: reg\n---\noriginal\n');
    await mkdir(diskDir(name), { recursive: true });
    await writeFile(join(diskDir(name), 'SKILL.md'), '---\nname: reg\n---\nEDITED\n');

    const result = await diffSkillWithContents(home, AGENT, name);
    expect(result.diff.files).toEqual([{ path: 'SKILL.md', status: 'modified' }]);
    expect(result.diff.files[0]!.oversized).toBeUndefined();

    const patch = buildUnifiedDiffText(result.diff, result.diskFiles, result.storeFiles);
    // 与 generateUnifiedDiff 直接调用对拍
    const direct = generateUnifiedDiff(
      'SKILL.md',
      result.storeFiles.get('SKILL.md'),
      result.diskFiles.get('SKILL.md'),
    );
    expect(patch).toBe(direct);
    expect(patch).toContain('--- a/SKILL.md');
    expect(patch).toContain('-original');
    expect(patch).toContain('+EDITED');
  });
});
