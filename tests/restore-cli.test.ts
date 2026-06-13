import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSnapshots, snapshot } from '../src/core/backup.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

let work: string;
let home: string;
let source: string;

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? -1 };
  }
}

async function writeSkill(body: string): Promise<void> {
  await mkdir(join(source, 'recoverable'), { recursive: true });
  await writeFile(
    join(source, 'recoverable', 'SKILL.md'),
    `---\nname: recoverable\ndescription: recoverable restore fixture.\n---\n\n${body}\n`,
  );
}

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), 'skill-switch-restore-'));
  home = join(work, 'home');
  source = join(work, 'source');
  await mkdir(home, { recursive: true });
  await writeSkill('version 1\n');
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('restore CLI', () => {
  it('lists legacy snapshots with an unknown source instead of crashing', async () => {
    const target = join(home, '.claude', 'skills');
    const store = join(home, '.skill-switch', 'backups');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'note.txt'), 'legacy\n');
    const snap = await snapshot(target, { store, label: 'legacy' });
    await rm(`${snap.path}.json`);

    const { stdout, status } = runCli(['restore', '--home', home]);
    expect(status).toBe(0);
    expect(stdout).toContain('来源未知');
  });

  it('restores --latest to the recorded sourceDir and snapshots current state first', async () => {
    const install1 = runCli(['install', source, '--agent', 'claude-code', '--home', home]);
    expect(install1.status).toBe(0);

    await writeSkill('version 2\n');
    const install2 = runCli(['install', source, '--agent', 'claude-code', '--home', home]);
    expect(install2.status).toBe(0);

    const target = join(home, '.claude', 'skills');
    const skillFile = join(target, 'recoverable', 'SKILL.md');
    expect(await readFile(skillFile, 'utf8')).toContain('version 2');
    await writeFile(skillFile, 'TAMPERED\n');

    const { stdout, status } = runCli(['restore', '--home', home, '--latest', '--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as {
      restored: true;
      target: string;
      safetySnapshot: { path: string; sourceDir?: string };
    };

    expect(parsed.restored).toBe(true);
    expect(parsed.target).toBe(target);
    expect(parsed.safetySnapshot.sourceDir).toBe(target);
    expect(await readFile(skillFile, 'utf8')).toContain('version 1');

    const snapshots = await listSnapshots(join(home, '.skill-switch', 'backups'));
    expect(snapshots[0]!.label).toBe('pre-restore');
    expect(snapshots[0]!.sourceDir).toBe(target);
  });
});
