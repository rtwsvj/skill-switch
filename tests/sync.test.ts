// S4.1:声明驱动 sync 引擎 — 终态一致 + 幂等(二跑零变更)+ 不动未声明目录。
import { mkdtempSync } from 'node:fs';
import { lstat, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applySync,
  readDeclaration,
  type SkillsDeclarationFile,
} from '../src/core/sync.ts';

let home: string;
let store: string;

async function makeSkill(name: string, body = `Body of ${name}.`): Promise<string> {
  const dir = join(store, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: sync fixture ${name}.\n---\n\n${body}\n`,
  );
  return dir;
}

function decl(skills: SkillsDeclarationFile['skills']): SkillsDeclarationFile {
  return { version: 1, skills };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-sync-'));
  store = join(home, '.skill-switch', 'store');
  await makeSkill('alpha');
  await makeSkill('beta');
});

describe('core/sync', () => {
  it('creates declared targets (symlink + copy, multi-agent) to match declaration', async () => {
    const d = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['claude-code'], enabled: true, mode: 'symlink' },
      { name: 'beta', source: join(store, 'beta'), agents: ['claude-code', 'gemini-cli'], enabled: true, mode: 'copy' },
    ]);
    const { actions } = await applySync(home, d);
    expect(actions.filter((a) => a.kind === 'create')).toHaveLength(3);

    const alphaSt = await lstat(join(home, '.claude', 'skills', 'alpha'));
    expect(alphaSt.isSymbolicLink()).toBe(true);
    expect(await readlink(join(home, '.claude', 'skills', 'alpha'))).toBe(join(store, 'alpha'));
    await lstat(join(home, '.claude', 'skills', 'beta'));
    await lstat(join(home, '.gemini', 'skills', 'beta'));
  });

  it('is idempotent: second run is all noop', async () => {
    const d = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['claude-code'], enabled: true, mode: 'symlink' },
      { name: 'beta', source: join(store, 'beta'), agents: ['claude-code', 'gemini-cli'], enabled: true, mode: 'copy' },
    ]);
    await applySync(home, d);
    const { actions } = await applySync(home, d);
    expect(actions.every((a) => a.kind === 'noop')).toBe(true);
    expect(actions).toHaveLength(3);
  });

  it('removes targets when a skill is disabled', async () => {
    const enabled = decl([
      { name: 'beta', source: join(store, 'beta'), agents: ['claude-code', 'gemini-cli'], enabled: true, mode: 'copy' },
    ]);
    await applySync(home, enabled);

    const disabled = decl([
      { name: 'beta', source: join(store, 'beta'), agents: ['claude-code', 'gemini-cli'], enabled: false, mode: 'copy' },
    ]);
    const { actions } = await applySync(home, disabled);
    expect(actions.filter((a) => a.kind === 'remove')).toHaveLength(2);
    await expect(lstat(join(home, '.claude', 'skills', 'beta'))).rejects.toThrow();

    // 再跑一次:目标已不存在 → noop(remove 也幂等)
    const again = await applySync(home, disabled);
    expect(again.actions.every((a) => a.kind === 'noop')).toBe(true);
  });

  it('repairs a tampered copy target (replace) and restores content', async () => {
    const d = decl([
      { name: 'beta', source: join(store, 'beta'), agents: ['claude-code'], enabled: true, mode: 'copy' },
    ]);
    await applySync(home, d);
    const target = join(home, '.claude', 'skills', 'beta', 'SKILL.md');
    await writeFile(target, 'TAMPERED\n');

    const { actions } = await applySync(home, d);
    expect(actions.map((a) => a.kind)).toEqual(['replace']);
    expect(await readFile(target, 'utf8')).toContain('Body of beta');
  });

  it('F3: uses per-agent source/mode overrides when present', async () => {
    const claudeSource = await makeSkill('shared-claude-source', 'Claude source body.');
    const geminiSource = await makeSkill('shared-gemini-source', 'Gemini source body.');
    const d = decl([
      {
        name: 'shared',
        source: claudeSource,
        agents: ['claude-code', 'gemini-cli'],
        enabled: true,
        mode: 'copy',
        agentSources: {
          'gemini-cli': { source: geminiSource, mode: 'copy' },
        },
      },
    ]);

    await applySync(home, d);
    expect(await readFile(join(home, '.claude', 'skills', 'shared', 'SKILL.md'), 'utf8')).toContain('Claude source body.');
    expect(await readFile(join(home, '.gemini', 'skills', 'shared', 'SKILL.md'), 'utf8')).toContain('Gemini source body.');

    await writeFile(join(home, '.gemini', 'skills', 'shared', 'SKILL.md'), 'TAMPERED\n');
    const { actions } = await applySync(home, d);
    expect(actions.find((a) => a.agent === 'gemini-cli')?.kind).toBe('replace');
    expect(await readFile(join(home, '.gemini', 'skills', 'shared', 'SKILL.md'), 'utf8')).toContain('Gemini source body.');
  });

  it('repairs a symlink pointing at the wrong place', async () => {
    const d = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['claude-code'], enabled: true, mode: 'symlink' },
    ]);
    await applySync(home, d);
    // 把链接指向别处
    const target = join(home, '.claude', 'skills', 'alpha');
    await rm(target, { force: true });
    const { symlink } = await import('node:fs/promises');
    await symlink(join(store, 'beta'), target, 'dir');

    const { actions } = await applySync(home, d);
    expect(actions.map((a) => a.kind)).toEqual(['replace']);
    expect(await readlink(target)).toBe(join(store, 'alpha'));
  });

  it('never touches undeclared dirs in the agent skills dir', async () => {
    await mkdir(join(home, '.claude', 'skills', 'manual-skill'), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', 'manual-skill', 'SKILL.md'), 'mine\n');

    const d = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['claude-code'], enabled: true, mode: 'symlink' },
    ]);
    await applySync(home, d);
    expect(await readFile(join(home, '.claude', 'skills', 'manual-skill', 'SKILL.md'), 'utf8')).toBe('mine\n');
  });

  it('fails fast on an unknown agent in the declaration', async () => {
    const d = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['no-such' as never], enabled: true, mode: 'symlink' },
    ]);
    await expect(applySync(home, d)).rejects.toThrow(/agent/i);
  });

  it('readDeclaration returns an empty declaration for a missing file', async () => {
    expect(await readDeclaration(join(home, 'nope.json'))).toEqual({ version: 1, skills: [] });
  });
});
