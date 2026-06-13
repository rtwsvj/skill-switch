// A2: all write paths must reject unsafe skill names before joining target paths.
import { mkdtempSync } from 'node:fs';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFromSource } from '../src/core/install.ts';
import { removeSkill } from '../src/core/remove.ts';
import { applySync, type SkillsDeclarationFile } from '../src/core/sync.ts';

let home: string;
let source: string;

async function writeSkill(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: path safety fixture.\n---\n\nBody.\n`,
  );
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-path-safety-'));
  source = join(home, 'source');
  await writeSkill(source, 'safe-skill');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('A2 path safety for skill names', () => {
  it('sync rejects unsafe declaration names before writing outside the skills dir', async () => {
    const badNames = ['../../escape', '/tmp/escape', 'nested/name', '.hidden', 'bad\0name'];

    for (const name of badNames) {
      const declaration: SkillsDeclarationFile = {
        version: 1,
        skills: [
          {
            name,
            source: join(source, 'safe-skill'),
            agents: ['claude-code'],
            enabled: true,
            mode: 'copy',
          },
        ],
      };

      await expect(applySync(home, declaration)).rejects.toThrow(/Unsafe declaration skill name/);
      await expect(lstat(join(home, '.claude'))).rejects.toThrow();
    }
  });

  it('remove rejects traversal names before deleting escaped targets', async () => {
    const escaped = join(home, '.claude', 'escape');
    await mkdir(escaped, { recursive: true });
    await writeFile(join(escaped, 'sentinel.txt'), 'do not delete\n');

    await expect(removeSkill(home, '../../escape', 'claude-code')).rejects.toThrow(
      /Unsafe remove skill name/,
    );

    await expect(readFile(join(escaped, 'sentinel.txt'), 'utf8')).resolves.toBe('do not delete\n');
    await expect(lstat(join(home, '.skill-switch', 'backups'))).rejects.toThrow();
  });

  it('install skips unsafe discovered source directory basenames', async () => {
    await writeSkill(source, '.hidden-skill');

    const result = await installFromSource(source, {
      home,
      agent: 'claude-code',
      mode: 'copy',
    });

    expect(result.installed.map((s) => s.name)).toEqual(['safe-skill']);
    await expect(lstat(join(home, '.claude', 'skills', '.hidden-skill'))).rejects.toThrow();
  });

  it('install rejects unsafe skill filters before clone or write', async () => {
    await expect(
      installFromSource(source, {
        home,
        agent: 'claude-code',
        mode: 'copy',
        skill: '../../escape',
      }),
    ).rejects.toThrow(/Unsafe install skill filter/);

    await expect(lstat(join(home, '.claude'))).rejects.toThrow();
  });
});
