// F9:remove — 一致性拆除磁盘产物 + lock + declaration,并保持 doctor clean。
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listSnapshots } from '../src/core/backup.ts';
import { runDoctor } from '../src/core/doctor.ts';
import { installFromSource } from '../src/core/install.ts';
import { getSkillsLockPath, readSkillsLock, removeLockEntries, upsertLockEntries } from '../src/core/lock.ts';
import {
  getSkillsJsonPath,
  readDeclaration,
  removeFromDeclaration,
  type SkillsDeclarationFile,
} from '../src/core/sync.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

let home: string;
let localSource: string;

async function writeSkill(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: remove fixture ${name}.\n---\n\nBody.\n`,
  );
}

function runRemove(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', CLI, 'remove', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? -1 };
  }
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-remove-'));
  localSource = join(home, 'local-src');
  await writeSkill(localSource, 'tidy-notes');
});

describe('core removal helpers', () => {
  it('removeLockEntries deletes only matching (agent,name) keys', async () => {
    const lockPath = getSkillsLockPath(home);
    await upsertLockEntries(lockPath, [
      {
        name: 'tidy-notes', agent: 'claude-code', source: localSource, sourceType: 'local',
        sha256: 'a', mode: 'copy',
      },
      {
        name: 'tidy-notes', agent: 'gemini-cli', source: localSource, sourceType: 'local',
        sha256: 'b', mode: 'copy',
      },
    ]);

    await removeLockEntries(lockPath, [{ name: 'tidy-notes', agent: 'claude-code' }]);
    const lock = await readSkillsLock(lockPath);
    expect(lock.skills).toEqual([
      expect.objectContaining({ name: 'tidy-notes', agent: 'gemini-cli' }),
    ]);
  });

  it('removeFromDeclaration removes one agent and drops an empty skill row', async () => {
    const declarationPath = getSkillsJsonPath(home);
    const declaration: SkillsDeclarationFile = {
      version: 1,
      skills: [
        {
          name: 'tidy-notes',
          source: '/first',
          agents: ['claude-code', 'gemini-cli'],
          enabled: true,
          mode: 'copy',
          agentSources: {
            'claude-code': { source: '/first', mode: 'copy' },
            'gemini-cli': { source: '/second', mode: 'copy' },
          },
        },
      ],
    };
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(declarationPath, `${JSON.stringify(declaration, null, 2)}\n`);

    await removeFromDeclaration(declarationPath, 'tidy-notes', 'claude-code');
    let updated = await readDeclaration(declarationPath);
    expect(updated.skills).toEqual([
      expect.objectContaining({
        name: 'tidy-notes',
        source: '/second',
        agents: ['gemini-cli'],
        mode: 'copy',
        agentSources: { 'gemini-cli': { source: '/second', mode: 'copy' } },
      }),
    ]);

    await removeFromDeclaration(declarationPath, 'tidy-notes', 'gemini-cli');
    updated = await readDeclaration(declarationPath);
    expect(updated.skills).toEqual([]);
  });
});

describe('remove CLI(真实子进程)', () => {
  it('removes a single-agent install and leaves doctor clean', async () => {
    await installFromSource(localSource, { home, agent: 'claude-code', mode: 'copy' });
    const result = runRemove(['tidy-notes', '--agent', 'claude-code', '--home', home]);

    expect(result.status).toBe(0);
    await expect(lstat(join(home, '.claude', 'skills', 'tidy-notes'))).rejects.toThrow();
    expect((await readSkillsLock(getSkillsLockPath(home))).skills).toEqual([]);
    expect((await readDeclaration(getSkillsJsonPath(home))).skills).toEqual([]);
    expect(await runDoctor(home)).toMatchObject({ clean: true, findings: [] });
    expect(await listSnapshots(join(home, '.skill-switch', 'backups'))).toHaveLength(1);
  });

  it('removes one agent while preserving the other agent install', async () => {
    await installFromSource(localSource, { home, agent: 'claude-code', mode: 'copy' });
    await installFromSource(localSource, { home, agent: 'gemini-cli', mode: 'copy' });

    const result = runRemove(['tidy-notes', '--agent', 'claude-code', '--home', home]);
    expect(result.status).toBe(0);

    await expect(lstat(join(home, '.claude', 'skills', 'tidy-notes'))).rejects.toThrow();
    await lstat(join(home, '.gemini', 'skills', 'tidy-notes'));
    expect((await readSkillsLock(getSkillsLockPath(home))).skills).toEqual([
      expect.objectContaining({ name: 'tidy-notes', agent: 'gemini-cli' }),
    ]);
    expect((await readDeclaration(getSkillsJsonPath(home))).skills).toEqual([
      expect.objectContaining({
        name: 'tidy-notes',
        source: join(home, '.skill-switch', 'store', 'gemini-cli', 'tidy-notes'),
        agents: ['gemini-cli'],
        agentSources: {
          'gemini-cli': {
            source: join(home, '.skill-switch', 'store', 'gemini-cli', 'tidy-notes'),
            mode: 'copy',
          },
        },
      }),
    ]);
    expect(await runDoctor(home)).toMatchObject({ clean: true, findings: [] });
  });
});
