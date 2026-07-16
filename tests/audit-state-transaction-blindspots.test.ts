// Transaction regression coverage for multi-file state operations.
// These tests deliberately fail an operation after one of its durable mutations;
// callers must observe the complete old state rather than a torn intermediate state.
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSkillsLockPath } from '../src/core/lock.ts';
import { removeSkill } from '../src/core/remove.ts';
import {
  applySync,
  getSkillsJsonPath,
  readDeclaration,
  type SkillsDeclarationFile,
} from '../src/core/sync.ts';
import { toggleSkill } from '../src/core/toggle.ts';

let home: string;
let source: string;
let target: string;
let declarationPath: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'skill-switch-audit-state-tx-'));
  source = join(home, '.skill-switch', 'store', 'delta');
  target = join(home, '.claude', 'skills', 'delta');
  declarationPath = getSkillsJsonPath(home);

  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: delta\ndescription: tx fixture.\n---\n');
  const declaration: SkillsDeclarationFile = {
    version: 1,
    skills: [{
      name: 'delta',
      source,
      agents: ['claude-code'],
      enabled: true,
      mode: 'copy',
    }],
  };
  await mkdir(join(home, '.skill-switch'), { recursive: true });
  await writeFile(declarationPath, `${JSON.stringify(declaration, null, 2)}\n`);
  await applySync(home, declaration);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('audit blind spot: multi-file state rollback', () => {
  it('toggle snapshot failure leaves both declaration and materialized target unchanged', async () => {
    // snapshot() calls mkdir(backups, { recursive: true }); a regular file here
    // deterministically fails after the legacy implementation writes skills.json.
    await writeFile(join(home, '.skill-switch', 'backups'), 'block snapshot directory\n');

    await expect(toggleSkill(home, 'delta', false)).rejects.toThrow();

    const declaration = await readDeclaration(declarationPath);
    expect(declaration.skills[0]!.enabled).toBe(true);
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('name: delta');
  });

  it.skipIf(process.platform === 'win32')(
    'toggle apply failure compensates the declaration and partially changed target',
    async () => {
      const skillsDir = join(home, '.claude', 'skills');
      const beforeDeclaration = await readFile(declarationPath, 'utf8');
      const beforeTarget = await readFile(join(target, 'SKILL.md'), 'utf8');

      // plan and snapshot only need read access. applySync can delete files inside target,
      // but cannot unlink target from a non-writable parent, forcing a post-write failure.
      await chmod(skillsDir, 0o500);
      try {
        await expect(toggleSkill(home, 'delta', false)).rejects.toThrow();
      } finally {
        await chmod(skillsDir, 0o700).catch(() => undefined);
        // restoreSnapshot intentionally keeps a best-effort backup if its cleanup is
        // blocked by the injected mode. Remove only that test artifact after restoring
        // permissions so afterEach can delete the temporary home.
        for (const entry of await readdir(join(home, '.claude'))) {
          if (!entry.startsWith('skills.restore-bak-')) continue;
          const backup = join(home, '.claude', entry);
          await chmod(backup, 0o700).catch(() => undefined);
          await rm(backup, { recursive: true, force: true });
        }
      }

      expect(await readFile(declarationPath, 'utf8')).toBe(beforeDeclaration);
      expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe(beforeTarget);
    },
  );

  it('remove lock failure leaves target, declaration, and lock in their pre-operation state', async () => {
    const lockPath = getSkillsLockPath(home);
    const corruptLock = '{ deliberately invalid lock JSON\n';
    await writeFile(lockPath, corruptLock);

    await expect(removeSkill(home, 'delta', 'claude-code')).rejects.toThrow(/JSON|状态|lock/i);

    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('name: delta');
    expect((await readDeclaration(declarationPath)).skills.map((skill) => skill.name)).toContain('delta');
    expect(await readFile(lockPath, 'utf8')).toBe(corruptLock);
  });

  it('remove declaration preflight failure leaves target and lock untouched', async () => {
    const lockPath = getSkillsLockPath(home);
    const validLock = `${JSON.stringify({ version: 1, skills: [] }, null, 2)}\n`;
    const corruptDeclaration = '{ deliberately invalid declaration JSON\n';
    await writeFile(lockPath, validLock);
    await writeFile(declarationPath, corruptDeclaration);

    await expect(removeSkill(home, 'delta', 'claude-code')).rejects.toThrow(/JSON|状态|声明/i);

    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('name: delta');
    expect(await readFile(lockPath, 'utf8')).toBe(validLock);
    expect(await readFile(declarationPath, 'utf8')).toBe(corruptDeclaration);
  });

  it.skipIf(process.platform === 'win32')(
    'remove lock write failure restores a target deleted earlier in the operation',
    async () => {
      const stateDir = join(home, '.skill-switch');
      const lockPath = getSkillsLockPath(home);
      const validLock = `${JSON.stringify({ version: 1, skills: [] }, null, 2)}\n`;
      await writeFile(lockPath, validLock);
      // snapshot archives remain writable while state-file temp creation in stateDir fails.
      await mkdir(join(stateDir, 'backups'), { recursive: true });
      const beforeDeclaration = await readFile(declarationPath, 'utf8');
      const beforeTarget = await readFile(join(target, 'SKILL.md'), 'utf8');

      await chmod(stateDir, 0o500);
      try {
        await expect(removeSkill(home, 'delta', 'claude-code')).rejects.toThrow();
      } finally {
        await chmod(stateDir, 0o700);
      }

      expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe(beforeTarget);
      expect(await readFile(declarationPath, 'utf8')).toBe(beforeDeclaration);
      expect(await readFile(lockPath, 'utf8')).toBe(validLock);
    },
  );
});
