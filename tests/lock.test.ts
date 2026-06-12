// S3.4:skills.lock 验收 — schema 字段、git commit SHA、幂等(重复安装不漂移)。
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installFromSource } from '../src/core/install.ts';
import { getSkillsLockPath, readSkillsLock } from '../src/core/lock.ts';

let work: string;
let repo: string;
let localSource: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { encoding: 'utf8' },
  ).trim();
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'skill-switch-lock-'));
  repo = join(work, 'repo');
  await mkdir(join(repo, 'tidy-notes'), { recursive: true });
  await writeFile(
    join(repo, 'tidy-notes', 'SKILL.md'),
    '---\nname: tidy-notes\ndescription: lock test fixture.\n---\n\nKeep notes tidy.\n',
  );
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');

  localSource = join(work, 'local-src');
  await mkdir(join(localSource, 'local-skill'), { recursive: true });
  await writeFile(
    join(localSource, 'local-skill', 'SKILL.md'),
    '---\nname: local-skill\ndescription: local lock fixture.\n---\n\nLocal.\n',
  );
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('core/lock via install', () => {
  it('writes a lock entry with source/commit/sha256 for a git install', async () => {
    const home = mkdtempSync(join(tmpdir(), 'skill-switch-lhome-'));
    await installFromSource(`file://${repo}`, { home, agent: 'claude-code', mode: 'copy' });

    const lock = await readSkillsLock(getSkillsLockPath(home));
    expect(lock.version).toBe(1);
    expect(lock.skills).toHaveLength(1);
    const entry = lock.skills[0]!;
    expect(entry).toMatchObject({
      name: 'tidy-notes',
      agent: 'claude-code',
      sourceType: 'git',
      mode: 'copy',
    });
    expect(entry.source).toBe(`file://${repo}`);
    expect(entry.commit).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(entry.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.sha256).toMatch(/^[0-9a-f]{16,}$/);
  });

  it('is idempotent: reinstalling the same source leaves the lock byte-identical', async () => {
    const home = mkdtempSync(join(tmpdir(), 'skill-switch-lhome-'));
    await installFromSource(`file://${repo}`, { home, agent: 'claude-code', mode: 'copy' });
    const first = await readFile(getSkillsLockPath(home), 'utf8');
    await installFromSource(`file://${repo}`, { home, agent: 'claude-code', mode: 'copy' });
    const second = await readFile(getSkillsLockPath(home), 'utf8');
    expect(second).toBe(first);
  });

  it('local sources lock with sourceType=local and no commit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'skill-switch-lhome-'));
    await installFromSource(localSource, { home, agent: 'claude-code', mode: 'copy' });
    const lock = await readSkillsLock(getSkillsLockPath(home));
    expect(lock.skills[0]).toMatchObject({ name: 'local-skill', sourceType: 'local' });
    expect(lock.skills[0]!.commit).toBeUndefined();
  });

  it('upserts by (agent, name) and keeps entries sorted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'skill-switch-lhome-'));
    await installFromSource(`file://${repo}`, { home, agent: 'claude-code', mode: 'copy' });
    await installFromSource(localSource, { home, agent: 'claude-code', mode: 'copy' });
    // 重装第一个,确认 upsert 不产生重复
    await installFromSource(`file://${repo}`, { home, agent: 'claude-code', mode: 'copy' });

    const lock = await readSkillsLock(getSkillsLockPath(home));
    expect(lock.skills).toHaveLength(2);
    expect(lock.skills.map((s) => s.name)).toEqual(['local-skill', 'tidy-notes']);
  });

  it('readSkillsLock on a missing file returns an empty lock (no throw)', async () => {
    const lock = await readSkillsLock(join(work, 'nope', 'skills.lock.json'));
    expect(lock).toEqual({ version: 1, skills: [] });
  });
});
