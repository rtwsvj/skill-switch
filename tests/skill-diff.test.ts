// D2:diffSkill —— 磁盘技能目录 vs store 耐久副本的逐文件对比(added/removed/modified)。
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { diffSkill } from '../src/core/skill-diff.ts';
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
  home = mkdtempSync(join(tmpdir(), 'skill-diff-'));
});

describe('D2 diffSkill', () => {
  it('reports modified / added / removed files vs the store reference', async () => {
    const name = 'foo';
    // store(应该是什么):SKILL.md + helper.sh
    await mkdir(storeDir(name), { recursive: true });
    await writeFile(join(storeDir(name), 'SKILL.md'), '---\nname: foo\n---\noriginal\n');
    await writeFile(join(storeDir(name), 'helper.sh'), 'echo original\n');
    // 磁盘(实际):SKILL.md 改了、helper.sh 删了、extra.txt 新增
    await mkdir(diskDir(name), { recursive: true });
    await writeFile(join(diskDir(name), 'SKILL.md'), '---\nname: foo\n---\nEDITED\n');
    await writeFile(join(diskDir(name), 'extra.txt'), 'new file\n');

    const diff = await diffSkill(home, AGENT, name);
    expect(diff.comparable).toBe(true);
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f.status]));
    expect(byPath['SKILL.md']).toBe('modified');
    expect(byPath['extra.txt']).toBe('added');
    expect(byPath['helper.sh']).toBe('removed');
  });

  it('is not comparable when there is no store reference (symlink mode / not copy-installed)', async () => {
    const name = 'bar';
    await mkdir(diskDir(name), { recursive: true });
    await writeFile(join(diskDir(name), 'SKILL.md'), 'x');
    const diff = await diffSkill(home, AGENT, name);
    expect(diff.comparable).toBe(false);
    expect(diff.reason).toMatch(/store/);
  });

  it('reports no changes when disk matches the store reference', async () => {
    const name = 'same';
    for (const dir of [storeDir(name), diskDir(name)]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), 'identical\n');
    }
    const diff = await diffSkill(home, AGENT, name);
    expect(diff.comparable).toBe(true);
    expect(diff.files).toEqual([]);
  });

  it('returns a clear reason when the skill is not on disk at all', async () => {
    const diff = await diffSkill(home, AGENT, 'ghost');
    expect(diff.comparable).toBe(false);
    expect(diff.reason).toMatch(/磁盘/);
  });
});
