// F8:sync CLI — 应用整份 skills.json,支持 dry-run 和执行前快照。
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listSnapshots } from '../src/core/backup.ts';
import { getSkillsJsonPath, type SkillsDeclarationFile } from '../src/core/sync.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

let home: string;
let source: string;
let target: string;

function runSync(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', CLI, 'sync', '--home', home, ...args], {
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
  home = mkdtempSync(join(tmpdir(), 'skill-switch-sync-cli-'));
  source = join(home, '.skill-switch', 'store', 'delta');
  target = join(home, '.claude', 'skills', 'delta');

  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: delta\ndescription: sync cli fixture.\n---\nSOURCE.\n');
  const declaration: SkillsDeclarationFile = {
    version: 1,
    skills: [{ name: 'delta', source, agents: ['claude-code'], enabled: true, mode: 'copy' }],
  };
  await mkdir(join(home, '.skill-switch'), { recursive: true });
  await writeFile(getSkillsJsonPath(home), `${JSON.stringify(declaration, null, 2)}\n`);
});

describe('sync CLI(真实子进程)', () => {
  it('--dry-run reports actions but does not write disk or snapshots', async () => {
    const result = runSync(['--dry-run', '--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      dryRun: boolean;
      actions: Array<{ kind: string; name: string }>;
      snapshots: unknown[];
    };

    expect(parsed.dryRun).toBe(true);
    expect(parsed.actions).toEqual([expect.objectContaining({ kind: 'create', name: 'delta' })]);
    expect(parsed.snapshots).toEqual([]);
    await expect(lstat(target)).rejects.toThrow();
    expect(await listSnapshots(join(home, '.skill-switch', 'backups'))).toEqual([]);
  });

  it('repairs drift, snapshots first, and second run is all noop', async () => {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), 'TAMPERED\n');

    const result = runSync(['--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      dryRun: boolean;
      actions: Array<{ kind: string; name: string }>;
      snapshots: Array<{ path: string }>;
    };

    expect(parsed.dryRun).toBe(false);
    expect(parsed.actions).toEqual([expect.objectContaining({ kind: 'replace', name: 'delta' })]);
    expect(parsed.snapshots.length).toBe(1);
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('SOURCE.');

    const again = JSON.parse(runSync(['--json']).stdout) as {
      actions: Array<{ kind: string }>;
      snapshots: unknown[];
    };
    expect(again.actions).toEqual([expect.objectContaining({ kind: 'noop' })]);
    expect(again.snapshots).toEqual([]);
  });
});
