// S4.3:toggle — 改声明 enabled 位 + sync 前自动快照 + applySync;
// roundtrip:restore 快照后被关掉的 skill 物理恢复。
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { restoreSnapshot } from '../src/core/backup.ts';
import {
  applySync,
  getSkillsJsonPath,
  readDeclaration,
  type SkillsDeclarationFile,
} from '../src/core/sync.ts';
import { toggleSkill } from '../src/core/toggle.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

let home: string;
let target: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-toggle-'));
  const src = join(home, '.skill-switch', 'store', 'delta');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'SKILL.md'), '---\nname: delta\ndescription: t.\n---\nD.\n');

  const decl: SkillsDeclarationFile = {
    version: 1,
    skills: [{ name: 'delta', source: src, agents: ['claude-code'], enabled: true, mode: 'copy' }],
  };
  await mkdir(join(home, '.skill-switch'), { recursive: true });
  await writeFile(getSkillsJsonPath(home), `${JSON.stringify(decl, null, 2)}\n`);
  await applySync(home, decl);
  target = join(home, '.claude', 'skills', 'delta');
});

describe('core/toggle', () => {
  it('toggle off removes the target, updates the declaration, and snapshots first', async () => {
    const result = await toggleSkill(home, 'delta', false);

    await expect(lstat(target)).rejects.toThrow();
    const decl = await readDeclaration(getSkillsJsonPath(home));
    expect(decl.skills[0]!.enabled).toBe(false);
    expect(result.snapshots.length).toBeGreaterThan(0);
    expect(result.actions.some((a) => a.kind === 'remove')).toBe(true);
  });

  it('roundtrip: restoring the pre-toggle snapshot brings the skill back', async () => {
    const result = await toggleSkill(home, 'delta', false);
    await expect(lstat(target)).rejects.toThrow();

    const snap = result.snapshots[0]!;
    await restoreSnapshot(snap.path, join(home, '.claude', 'skills'));
    expect((await readFile(join(target, 'SKILL.md'), 'utf8'))).toContain('delta');
  });

  it('toggle on rematerializes the target', async () => {
    await toggleSkill(home, 'delta', false);
    const result = await toggleSkill(home, 'delta', true);
    await lstat(target);
    expect(result.actions.some((a) => a.kind === 'create')).toBe(true);
  });

  it('toggling to the current state is a clean no-op sync', async () => {
    const result = await toggleSkill(home, 'delta', true);
    expect(result.actions.every((a) => a.kind === 'noop')).toBe(true);
  });

  it('throws on a skill not present in the declaration', async () => {
    await expect(toggleSkill(home, 'ghost', false)).rejects.toThrow(/声明|declar/i);
  });
});

describe('toggle CLI (real subprocess)', () => {
  it('toggle --off works end to end', () => {
    execFileSync(process.execPath, ['--import', 'tsx', CLI, 'toggle', 'delta', '--off', '--home', home], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return expect(lstat(target)).rejects.toThrow();
  });

  it('requires exactly one of --on/--off', () => {
    expect(() =>
      execFileSync(process.execPath, ['--import', 'tsx', CLI, 'toggle', 'delta', '--home', home], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});
