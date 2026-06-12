// S7.1:drift 三方 diff — 上游 HEAD(ls-remote)vs lock.commit vs 本地 sha256。
// 三态各一用例 + 双向漂移(diverged);上游用本地 file:// git 仓模拟,离线。
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkDrift } from '../src/core/drift.ts';
import { installFromSource } from '../src/core/install.ts';

let work: string;
let home: string;
let upstream: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    stdio: 'pipe',
  });
}

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), 'skill-switch-drift-'));
  home = join(work, 'home');
  await mkdir(home, { recursive: true });

  upstream = join(work, 'upstream');
  await mkdir(join(upstream, 'tidy-notes'), { recursive: true });
  await writeFile(
    join(upstream, 'tidy-notes', 'SKILL.md'),
    '---\nname: tidy-notes\ndescription: drift fixture.\n---\n\nv1.\n',
  );
  execFileSync('git', ['init', '-q', upstream]);
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-qm', 'v1');

  await installFromSource(`file://${upstream}`, { home, agent: 'claude-code', mode: 'copy' });
});

async function advanceUpstream(): Promise<void> {
  await writeFile(
    join(upstream, 'tidy-notes', 'SKILL.md'),
    '---\nname: tidy-notes\ndescription: drift fixture.\n---\n\nv2 upstream.\n',
  );
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-qm', 'v2');
}

describe('core/drift 三态', () => {
  it('安装后立即检查 → in-sync', async () => {
    const entries = await checkDrift(home);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: 'tidy-notes',
      state: 'in-sync',
      upstreamAhead: false,
      localModified: false,
    });
  });

  it('上游前进一个 commit → upstream-ahead', async () => {
    await advanceUpstream();
    const entries = await checkDrift(home);
    expect(entries[0]!.state).toBe('upstream-ahead');
    expect(entries[0]!.upstreamAhead).toBe(true);
    expect(entries[0]!.localModified).toBe(false);
    expect(entries[0]!.upstreamCommit).not.toBe(entries[0]!.lockCommit);
  });

  it('本地篡改安装产物 → local-modified', async () => {
    await writeFile(join(home, '.claude', 'skills', 'tidy-notes', 'SKILL.md'), 'TAMPERED\n');
    const entries = await checkDrift(home);
    expect(entries[0]!.state).toBe('local-modified');
    expect(entries[0]!.localModified).toBe(true);
    expect(entries[0]!.upstreamAhead).toBe(false);
  });

  it('上游前进 + 本地篡改并存 → diverged(两个标志都真)', async () => {
    await advanceUpstream();
    await writeFile(join(home, '.claude', 'skills', 'tidy-notes', 'SKILL.md'), 'TAMPERED\n');
    const entries = await checkDrift(home);
    expect(entries[0]!.state).toBe('diverged');
    expect(entries[0]!.upstreamAhead).toBe(true);
    expect(entries[0]!.localModified).toBe(true);
  });

  it('空锁 home 返回空列表', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'skill-switch-drift-empty-'));
    expect(await checkDrift(empty)).toEqual([]);
  });
});
