// D2:--format unified —— generateUnifiedDiff / buildUnifiedDiffText 单元测试
// + diff CLI --format unified 集成用例。
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildUnifiedDiffText,
  diffSkillWithContents,
  generateUnifiedDiff,
} from '../src/core/skill-diff.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from '../src/core/paths.ts';

const AGENT = 'claude-code';
let home: string;

function diskDir(name: string): string {
  const loc = getAgentSkillsLocations().find((l) => l.agent === AGENT)!;
  return join(resolveGlobalSkillsDir(home, loc), name);
}
function storeDir(name: string): string {
  return join(home, '.skill-switch', 'store', AGENT, name);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'diff-unified-'));
});

// ---------------------------------------------------------------------------
// Unit: generateUnifiedDiff
// ---------------------------------------------------------------------------
describe('generateUnifiedDiff', () => {
  it('produces --- a/ and +++ b/ headers for a modified file', () => {
    const a = Buffer.from('line1\nline2\nline3\n');
    const b = Buffer.from('line1\nLINE2\nline3\n');
    const patch = generateUnifiedDiff('SKILL.md', a, b);
    expect(patch).toContain('--- a/SKILL.md');
    expect(patch).toContain('+++ b/SKILL.md');
  });

  it('contains @@ hunk header for a modified file', () => {
    const a = Buffer.from('foo\nbar\nbaz\n');
    const b = Buffer.from('foo\nBAR\nbaz\n');
    const patch = generateUnifiedDiff('file.txt', a, b);
    expect(patch).toMatch(/@@.*@@/);
  });

  it('marks removed line with - prefix and added line with + prefix', () => {
    const a = Buffer.from('old line\n');
    const b = Buffer.from('new line\n');
    const patch = generateUnifiedDiff('f.txt', a, b);
    expect(patch).toContain('-old line');
    expect(patch).toContain('+new line');
  });

  it('shows all lines as added when aContent is undefined (new file)', () => {
    const b = Buffer.from('alpha\nbeta\n');
    const patch = generateUnifiedDiff('new.txt', undefined, b);
    expect(patch).toContain('+alpha');
    expect(patch).toContain('+beta');
    // No removed lines (only the --- header which starts with ---)
    const diffLines = patch.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    expect(diffLines).toHaveLength(0);
    expect(patch).toContain('--- a/new.txt');
    expect(patch).toContain('+++ b/new.txt');
  });

  it('shows all lines as removed when bContent is undefined (deleted file)', () => {
    const a = Buffer.from('alpha\nbeta\n');
    const patch = generateUnifiedDiff('del.txt', a, undefined);
    expect(patch).toContain('-alpha');
    expect(patch).toContain('-beta');
    // No added lines (only the +++ header which starts with +++)
    const addedLines = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    expect(addedLines).toHaveLength(0);
  });

  it('returns empty string when files are identical', () => {
    const content = Buffer.from('same\n');
    const patch = generateUnifiedDiff('same.txt', content, content);
    expect(patch).toBe('');
  });

  it('includes context lines around the changed area', () => {
    const lines = ['a', 'b', 'c', 'CHANGE', 'd', 'e', 'f'];
    const a = Buffer.from(`${lines.join('\n')}\n`);
    const b = Buffer.from(`${['a', 'b', 'c', 'CHANGED', 'd', 'e', 'f'].join('\n')}\n`);
    const patch = generateUnifiedDiff('ctx.txt', a, b);
    // Context lines should appear without a leading +/-
    expect(patch).toContain(' a');
    expect(patch).toContain(' b');
    expect(patch).toContain(' c');
    expect(patch).toContain('-CHANGE');
    expect(patch).toContain('+CHANGED');
  });

  it('handles a multiline change at the end of file', () => {
    const a = Buffer.from('keep\nold-last\n');
    const b = Buffer.from('keep\nnew-last\n');
    const patch = generateUnifiedDiff('end.txt', a, b);
    expect(patch).toContain('-old-last');
    expect(patch).toContain('+new-last');
    expect(patch).toContain(' keep');
  });
});

// ---------------------------------------------------------------------------
// Integration: buildUnifiedDiffText via diffSkillWithContents
// ---------------------------------------------------------------------------
describe('buildUnifiedDiffText (integration)', () => {
  it('generates unified diff for a modified file', async () => {
    const name = 'mypkg';
    await mkdir(storeDir(name), { recursive: true });
    await writeFile(join(storeDir(name), 'SKILL.md'), '---\nname: mypkg\n---\noriginal\n');

    await mkdir(diskDir(name), { recursive: true });
    await writeFile(join(diskDir(name), 'SKILL.md'), '---\nname: mypkg\n---\nEDITED\n');

    const result = await diffSkillWithContents(home, AGENT, name);
    expect(result.diff.comparable).toBe(true);
    const patch = buildUnifiedDiffText(result.diff, result.diskFiles, result.storeFiles);

    expect(patch).toContain('--- a/SKILL.md');
    expect(patch).toContain('+++ b/SKILL.md');
    expect(patch).toMatch(/@@.*@@/);
    expect(patch).toContain('-original');
    expect(patch).toContain('+EDITED');
  });

  it('generates unified diff for an added file (disk-only)', async () => {
    const name = 'mypkg2';
    await mkdir(storeDir(name), { recursive: true });
    await writeFile(join(storeDir(name), 'SKILL.md'), 'base\n');

    await mkdir(diskDir(name), { recursive: true });
    await writeFile(join(diskDir(name), 'SKILL.md'), 'base\n');
    await writeFile(join(diskDir(name), 'extra.txt'), 'new file content\n');

    const result = await diffSkillWithContents(home, AGENT, name);
    const patch = buildUnifiedDiffText(result.diff, result.diskFiles, result.storeFiles);

    expect(patch).toContain('--- a/extra.txt');
    expect(patch).toContain('+++ b/extra.txt');
    expect(patch).toContain('+new file content');
  });

  it('generates unified diff for a removed file (store-only)', async () => {
    const name = 'mypkg3';
    await mkdir(storeDir(name), { recursive: true });
    await writeFile(join(storeDir(name), 'SKILL.md'), 'base\n');
    await writeFile(join(storeDir(name), 'gone.sh'), 'echo bye\n');

    await mkdir(diskDir(name), { recursive: true });
    await writeFile(join(diskDir(name), 'SKILL.md'), 'base\n');
    // gone.sh deleted from disk

    const result = await diffSkillWithContents(home, AGENT, name);
    const patch = buildUnifiedDiffText(result.diff, result.diskFiles, result.storeFiles);

    expect(patch).toContain('--- a/gone.sh');
    expect(patch).toContain('+++ b/gone.sh');
    expect(patch).toContain('-echo bye');
  });

  it('returns empty string when no changes', async () => {
    const name = 'same';
    for (const dir of [storeDir(name), diskDir(name)]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), 'identical\n');
    }
    const result = await diffSkillWithContents(home, AGENT, name);
    const patch = buildUnifiedDiffText(result.diff, result.diskFiles, result.storeFiles);
    expect(patch).toBe('');
  });

  it('covers multiple changed files in one output', async () => {
    const name = 'multi';
    await mkdir(storeDir(name), { recursive: true });
    await writeFile(join(storeDir(name), 'a.txt'), 'aold\n');
    await writeFile(join(storeDir(name), 'b.txt'), 'bold\n');

    await mkdir(diskDir(name), { recursive: true });
    await writeFile(join(diskDir(name), 'a.txt'), 'anew\n');
    await writeFile(join(diskDir(name), 'b.txt'), 'bnew\n');

    const result = await diffSkillWithContents(home, AGENT, name);
    const patch = buildUnifiedDiffText(result.diff, result.diskFiles, result.storeFiles);

    expect(patch).toContain('--- a/a.txt');
    expect(patch).toContain('-aold');
    expect(patch).toContain('+anew');
    expect(patch).toContain('--- a/b.txt');
    expect(patch).toContain('-bold');
    expect(patch).toContain('+bnew');
  });
});

// ---------------------------------------------------------------------------
// diffSkillWithContents: existing behavior preserved (comparable=false cases)
// ---------------------------------------------------------------------------
describe('diffSkillWithContents (comparable=false)', () => {
  it('returns comparable=false when no store reference', async () => {
    const name = 'nosymlink';
    await mkdir(diskDir(name), { recursive: true });
    await writeFile(join(diskDir(name), 'SKILL.md'), 'x');
    const result = await diffSkillWithContents(home, AGENT, name);
    expect(result.diff.comparable).toBe(false);
    expect(result.diskFiles.size).toBe(0);
    expect(result.storeFiles.size).toBe(0);
  });

  it('returns comparable=false when disk dir missing', async () => {
    const result = await diffSkillWithContents(home, AGENT, 'ghost');
    expect(result.diff.comparable).toBe(false);
  });
});
