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

  // AUDIT-SEC2:snapshot sidecar 的 sourceDir 是可被篡改的 JSON 字段(backup.ts 的
  // readSnapshotSourceDir 直接 JSON.parse 取值,无范围校验)。restore 把它原样当还原目标
  // 传给 snapshot + restoreSnapshot,攻击者改 backups/*.tar.gz.json 的 sourceDir 成任意
  // 目录(如 ~/.ssh),用户跑 restore --latest 时会先快照该目录再铺攻击者控制的 tar →
  // 任意目录写入。修复后:sourceDir 经 path.resolve 归一化后必须落在受管 agent 快照根内
  // (codex 的 .codex 或其余 agent 的 skills 目录),否则拒绝。
  it('AUDIT-SEC2: rejects restore when sidecar sourceDir is outside governed roots', async () => {
    const target = join(home, '.claude', 'skills');
    const store = join(home, '.skill-switch', 'backups');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'note.txt'), 'original\n');
    const snap = await snapshot(target, { store, label: 'pre-install' });
    const sidecar = `${snap.path}.json`;

    // 篡改 sourceDir 指向受管范围外(用 .. 越界到 home/.ssh)
    const evilTarget = `${target}/../../.ssh`;
    const evilActual = join(home, '.ssh');
    await mkdir(evilActual, { recursive: true });
    await writeFile(join(evilActual, 'id_rsa'), 'SECRET\n');
    await writeFile(
      sidecar,
      `${JSON.stringify({ sourceDir: evilTarget, label: snap.label, createdAt: snap.createdAt.toISOString() }, null, 2)}\n`,
    );

    const { status, stdout } = runCli(['restore', '--home', home, '--latest', '--json']);
    expect(status).toBe(1);
    expect(stdout).not.toContain('"restored": true');
    // evilActual 的既有内容未被触碰(没有先快照再铺 tar)
    expect(await readFile(join(evilActual, 'id_rsa'), 'utf8')).toBe('SECRET\n');
  });

  it('AUDIT-SEC2: accepts a normalized spelling of a governed restore root', async () => {
    const target = join(home, '.claude', 'skills');
    const store = join(home, '.skill-switch', 'backups');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'note.txt'), 'v1\n');
    const snap = await snapshot(target, { store, label: 'normalized' });
    const sidecar = `${snap.path}.json`;

    // sidecar 写等价的归一化拼写(含 ./../skills),合法还原应被允许
    const normalizedSpelling = `${target}/../skills/`;
    await writeFile(
      sidecar,
      `${JSON.stringify({ sourceDir: normalizedSpelling, label: snap.label, createdAt: snap.createdAt.toISOString() }, null, 2)}\n`,
    );

    const { status } = runCli(['restore', '--home', home, '--latest', '--json']);
    expect(status).toBe(0);
    void snap;
  });

  it('AUDIT-SEC2: --id restores the matching snapshot by epochMs', async () => {
    const target = join(home, '.claude', 'skills');
    const store = join(home, '.skill-switch', 'backups');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'note.txt'), 'v1\n');
    const snap = await snapshot(target, { store, label: 'by-id' });
    const id = String(snap.createdAt.getTime());

    const { status, stdout } = runCli(['restore', '--home', home, '--id', id, '--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { restored: true };
    expect(parsed.restored).toBe(true);
  });

  it('AUDIT-SEC2: --id with unknown epochMs exits 1 with a clean error', async () => {
    const { status } = runCli(['restore', '--home', home, '--id', '99999999999999']);
    expect(status).toBe(1);
  });

  it('AUDIT-SEC2: --id and --latest are mutually exclusive', async () => {
    const { status } = runCli(['restore', '--home', home, '--id', '1', '--latest']);
    expect(status).toBe(1);
  });
});
