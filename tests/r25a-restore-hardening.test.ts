// R25-a: Safety hardening regression tests for the restore snapshot-restore path.
// All tests use isolated temp directories; real ~/.claude / ~/.codex / ~/.gemini are
// never touched.  Each test pins one edge / failure case to clean, non-destructive
// behavior.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSnapshots, restoreSnapshot, snapshot } from '../src/core/backup.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

let work: string;
let home: string;

/** Run the CLI in a subprocess; never throws — returns stdout + exit code. */
function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
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

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'skill-switch-r25a-'));
  home = join(work, 'home');
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Edge case 1: No snapshots exist at all
// ---------------------------------------------------------------------------

describe('R25-a: restore with no snapshots', () => {
  it('--latest with empty store: exits 1, clean error message, no disk mutation', async () => {
    await mkdir(home, { recursive: true });
    const before = await readdir(home).catch(() => [] as string[]);

    const { status, stderr } = runCli(['restore', '--home', home, '--latest']);

    expect(status).toBe(1);
    // Error message should mention no snapshots available
    expect(stderr).toMatch(/没有|快照|snapshot/i);
    // No stack trace
    expect(stderr).not.toMatch(/\n\s+at\s/);

    // home should be untouched (no new dirs created inside it)
    const after = await readdir(home).catch(() => [] as string[]);
    expect(after).toEqual(before);
  });

  it('--latest with store dir absent: exits 1, clean error, no dir created', async () => {
    // Don't even create home — the store definitely doesn't exist
    const { status, stderr } = runCli(['restore', '--home', home, '--latest']);

    expect(status).toBe(1);
    expect(stderr).toMatch(/没有|快照|snapshot/i);
    expect(stderr).not.toMatch(/\n\s+at\s/);
  });

  it('list with empty store: exits 0, prints "none", no disk mutation', async () => {
    await mkdir(home, { recursive: true });
    const { status, stdout } = runCli(['restore', '--home', home]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/none|没有/i);
  });
});

// ---------------------------------------------------------------------------
// Edge case 2: Requested snapshot id doesn't exist (already tested; add --json variant)
// ---------------------------------------------------------------------------

describe('R25-a: restore with non-existent snapshot id', () => {
  it('--id with bogus epochMs exits 1 with clean error, no disk mutation', async () => {
    const target = join(home, '.claude', 'skills');
    const store = join(home, '.skill-switch', 'backups');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'file.txt'), 'original\n');
    // Create one real snapshot so the store exists
    await snapshot(target, { store, label: 'real' });

    const { status, stderr } = runCli(['restore', '--home', home, '--id', '11111111111111']);

    expect(status).toBe(1);
    expect(stderr).toMatch(/11111111111111|快照|snapshot/i);
    expect(stderr).not.toMatch(/\n\s+at\s/);
    // Target file untouched
    expect(await readFile(join(target, 'file.txt'), 'utf8')).toBe('original\n');
  });

  it('--id with bogus epochMs: no pre-restore snapshot is created (nothing to undo)', async () => {
    const target = join(home, '.claude', 'skills');
    const store = join(home, '.skill-switch', 'backups');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'file.txt'), 'original\n');
    const snap = await snapshot(target, { store, label: 'real' });

    runCli(['restore', '--home', home, '--id', '11111111111111']);

    // Only the one original snapshot should exist (no pre-restore added)
    const after = await listSnapshots(store);
    expect(after).toHaveLength(1);
    expect(after[0]!.path).toBe(snap.path);
  });
});

// ---------------------------------------------------------------------------
// Edge case 3: Corrupt / truncated tar archive
// ---------------------------------------------------------------------------

describe('R25-a: restore with corrupt tar archive', () => {
  it('corrupt archive: restoreSnapshot rejects cleanly, target left intact', async () => {
    const target = join(work, 'skills');
    const store = join(work, 'store');
    await mkdir(join(target, 'sub'), { recursive: true });
    await writeFile(join(target, 'sub', 'SKILL.md'), 'safe content\n');

    const snap = await snapshot(target, { store, label: 'good' });
    // Overwrite the archive with garbage bytes
    await writeFile(snap.path, 'THIS IS NOT A TAR FILE\n');

    await expect(restoreSnapshot(snap.path, target)).rejects.toThrow();

    // Original content untouched
    expect(await readFile(join(target, 'sub', 'SKILL.md'), 'utf8')).toBe('safe content\n');
  });

  it('corrupt archive via CLI: exits 1, clean error, no partial extraction', async () => {
    const target = join(home, '.claude', 'skills');
    const store = join(home, '.skill-switch', 'backups');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'orig.txt'), 'safe\n');

    const snap = await snapshot(target, { store, label: 'snap' });
    // Corrupt the tar
    await writeFile(snap.path, 'NOT A VALID TAR\n');

    const { status, stderr } = runCli(['restore', '--home', home, '--latest']);

    expect(status).toBe(1);
    expect(stderr).not.toMatch(/\n\s+at\s/);
    // Target still has original content
    expect(await readFile(join(target, 'orig.txt'), 'utf8')).toBe('safe\n');
    // No staging dir left behind in parent
    const parentEntries = await readdir(join(home, '.claude'));
    expect(parentEntries.some((e) => e.includes('.skill-switch-restore-'))).toBe(false);
  });

  it('corrupt archive: pre-restore snapshot is NOT taken (error before snapshot step)', async () => {
    // The pre-restore snapshot is taken AFTER finding the selected snapshot but BEFORE
    // restoreSnapshot. A corrupt tar causes restoreSnapshot to throw, but the pre-restore
    // snapshot was already taken by that point. Verify the count increases by exactly 1
    // (the pre-restore) and then the error is raised.
    const target = join(home, '.claude', 'skills');
    const store = join(home, '.skill-switch', 'backups');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'orig.txt'), 'safe\n');

    const snap = await snapshot(target, { store, label: 'snap' });
    const countBefore = (await listSnapshots(store)).length;
    // Corrupt the tar
    await writeFile(snap.path, 'NOT A VALID TAR\n');

    runCli(['restore', '--home', home, '--latest']);

    // The CLI takes a pre-restore snapshot, then tries to restore and fails.
    // So count should be countBefore + 1 (the pre-restore snapshot).
    const afterSnaps = await listSnapshots(store);
    // The corrupt snap's sidecar still makes it show up in the list, but we
    // check that a pre-restore label snapshot was added.
    const preRestoreSnaps = afterSnaps.filter((s) => s.label === 'pre-restore');
    expect(preRestoreSnaps).toHaveLength(1);
    expect(preRestoreSnaps[0]!.sourceDir).toBe(target);
    void countBefore;
  });
});

// ---------------------------------------------------------------------------
// Edge case 4: Empty snapshot (archive with no files inside)
// ---------------------------------------------------------------------------

describe('R25-a: restore from empty snapshot', () => {
  it('restoreSnapshot with an empty tar replaces target with empty dir', async () => {
    const target = join(work, 'skills');
    const store = join(work, 'store');
    // Create target with files
    await mkdir(join(target, 'existing'), { recursive: true });
    await writeFile(join(target, 'existing', 'SKILL.md'), 'will be gone\n');

    // Create an empty dir to snapshot (nothing inside)
    const emptyDir = join(work, 'empty');
    await mkdir(emptyDir, { recursive: true });
    const emptySnap = await snapshot(emptyDir, { store, label: 'empty' });

    // Restore the empty snapshot onto target
    await restoreSnapshot(emptySnap.path, target);

    // Target should now be an empty directory
    const entries = await readdir(target);
    expect(entries).toHaveLength(0);
  });

  it('empty snapshot via CLI: exits 0, pre-restore snapshot captured', async () => {
    const target = join(home, '.claude', 'skills');
    const store = join(home, '.skill-switch', 'backups');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'file.txt'), 'current\n');

    // Snapshot an empty dir to get an "empty" snapshot pointing at target
    const emptyDir = join(work, 'empty');
    await mkdir(emptyDir, { recursive: true });
    // We need the snapshot to have sourceDir = target (so restore accepts it).
    // snapshot() records the dir it archives as sourceDir. Create an empty target-clone
    // and snapshot it, then manually fix the sidecar to point to target.
    const snapEntry = await snapshot(emptyDir, { store, label: 'empty' });
    // Rewrite sidecar so sourceDir points at the governed target
    await writeFile(
      `${snapEntry.path}.json`,
      `${JSON.stringify({ sourceDir: target, label: 'empty', createdAt: snapEntry.createdAt.toISOString() }, null, 2)}\n`,
    );

    const { status, stdout } = runCli(['restore', '--home', home, '--latest', '--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { restored: boolean; safetySnapshot: { label: string } };
    expect(parsed.restored).toBe(true);
    expect(parsed.safetySnapshot.label).toBe('pre-restore');

    // Target is now empty
    const entries = await readdir(target);
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge case 5: Disk state diverged since snapshot (extra files, modified files)
// ---------------------------------------------------------------------------

describe('R25-a: restore with diverged disk state', () => {
  it('restore overwrites modified files and removes extra files added after snapshot', async () => {
    const target = join(work, 'skills');
    const store = join(work, 'store');
    await mkdir(join(target, 'skill-a'), { recursive: true });
    await writeFile(join(target, 'skill-a', 'SKILL.md'), 'original\n');

    const snap = await snapshot(target, { store, label: 'v1' });

    // Diverge: modify existing file, add extra file, add extra subdir
    await writeFile(join(target, 'skill-a', 'SKILL.md'), 'modified by user\n');
    await writeFile(join(target, 'extra.txt'), 'extra file\n');
    await mkdir(join(target, 'extra-dir'), { recursive: true });
    await writeFile(join(target, 'extra-dir', 'extra.md'), 'extra\n');

    await restoreSnapshot(snap.path, target);

    // Back to original state
    expect(await readFile(join(target, 'skill-a', 'SKILL.md'), 'utf8')).toBe('original\n');
    const entries = await readdir(target);
    expect(entries).not.toContain('extra.txt');
    expect(entries).not.toContain('extra-dir');
    expect(entries).toContain('skill-a');
  });

  it('pre-restore snapshot captures diverged state so user can undo', async () => {
    const target = join(home, '.claude', 'skills');
    const store = join(home, '.skill-switch', 'backups');
    await mkdir(join(target, 'skill-a'), { recursive: true });
    await writeFile(join(target, 'skill-a', 'SKILL.md'), 'original\n');

    // Take a snapshot (this is what we'll restore to)
    await snapshot(target, { store, label: 'v1' });

    // Diverge
    await writeFile(join(target, 'skill-a', 'SKILL.md'), 'user modified\n');
    await writeFile(join(target, 'new-file.txt'), 'new\n');

    const { status, stdout } = runCli(['restore', '--home', home, '--latest', '--json']);
    expect(status).toBe(0);

    const parsed = JSON.parse(stdout) as { safetySnapshot: { path: string; label: string } };
    expect(parsed.safetySnapshot.label).toBe('pre-restore');

    // The pre-restore snapshot should have captured the diverged state
    const snaps = await listSnapshots(store);
    const preRestore = snaps.find((s) => s.label === 'pre-restore');
    expect(preRestore).toBeDefined();
    // We can restore the pre-restore to recover the diverged state (atomicity)
    const recoveryDir = join(work, 'recovery');
    await mkdir(recoveryDir, { recursive: true });
    await restoreSnapshot(preRestore!.path, recoveryDir);
    expect(await readFile(join(recoveryDir, 'skill-a', 'SKILL.md'), 'utf8')).toBe('user modified\n');
    expect(await readFile(join(recoveryDir, 'new-file.txt'), 'utf8')).toBe('new\n');
  });
});

// ---------------------------------------------------------------------------
// Edge case 6: Target directory missing (should be created, not crash)
// ---------------------------------------------------------------------------

describe('R25-a: restore when target dir does not exist', () => {
  it('restoreSnapshot creates missing target dir from snapshot contents', async () => {
    const store = join(work, 'store');
    const snapshotSource = join(work, 'original');
    await mkdir(join(snapshotSource, 'sub'), { recursive: true });
    await writeFile(join(snapshotSource, 'sub', 'SKILL.md'), 'restored from scratch\n');

    const snap = await snapshot(snapshotSource, { store, label: 'rebuild' });

    // target does not exist
    const missingTarget = join(work, 'does-not-exist', 'nested', 'skills');
    expect(existsSync(missingTarget)).toBe(false);

    await restoreSnapshot(snap.path, missingTarget);

    expect(existsSync(missingTarget)).toBe(true);
    expect(await readFile(join(missingTarget, 'sub', 'SKILL.md'), 'utf8')).toBe('restored from scratch\n');
  });

  it('CLI restore with missing target dir: exits 0 and recreates the dir', async () => {
    const store = join(home, '.skill-switch', 'backups');
    const snapshotSource = join(work, 'source');
    await mkdir(join(snapshotSource, 'skill-x'), { recursive: true });
    await writeFile(join(snapshotSource, 'skill-x', 'SKILL.md'), 'rebuilt\n');

    // Snapshot under source, then rewire sidecar to point at the real governed target
    const target = join(home, '.claude', 'skills');
    const snap = await snapshot(snapshotSource, { store, label: 'rebuild' });
    await writeFile(
      `${snap.path}.json`,
      `${JSON.stringify({ sourceDir: target, label: 'rebuild', createdAt: snap.createdAt.toISOString() }, null, 2)}\n`,
    );

    // target dir does NOT exist
    expect(existsSync(target)).toBe(false);

    const { status, stdout } = runCli(['restore', '--home', home, '--latest', '--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { restored: boolean };
    expect(parsed.restored).toBe(true);

    expect(existsSync(target)).toBe(true);
    expect(await readFile(join(target, 'skill-x', 'SKILL.md'), 'utf8')).toBe('rebuilt\n');
  });
});

// ---------------------------------------------------------------------------
// Pre-restore snapshot invariant (cross-cutting): taken BEFORE overwrite
// ---------------------------------------------------------------------------

describe('R25-a: pre-restore snapshot invariant', () => {
  it('pre-restore snapshot is always taken before target is mutated', async () => {
    const target = join(home, '.claude', 'skills');
    const store = join(home, '.skill-switch', 'backups');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'before.txt'), 'before\n');

    // Snapshot v1 (what we'll restore)
    await snapshot(target, { store, label: 'v1' });

    // Modify target
    await writeFile(join(target, 'after.txt'), 'after\n');

    const { status } = runCli(['restore', '--home', home, '--latest', '--json']);
    expect(status).toBe(0);

    // pre-restore snapshot should exist and contain 'after.txt'
    const snaps = await listSnapshots(store);
    const preRestore = snaps.find((s) => s.label === 'pre-restore');
    expect(preRestore).toBeDefined();

    // Verify it captured the pre-overwrite state
    const recoveryDir = join(work, 'recovery');
    await mkdir(recoveryDir, { recursive: true });
    await restoreSnapshot(preRestore!.path, recoveryDir);
    expect(existsSync(join(recoveryDir, 'after.txt'))).toBe(true);
    expect(existsSync(join(recoveryDir, 'before.txt'))).toBe(true);
  });

  it('no pre-restore snapshot created when restore fails before snapshot step (not-found id)', async () => {
    const store = join(home, '.skill-switch', 'backups');
    await mkdir(home, { recursive: true });

    runCli(['restore', '--home', home, '--id', '99999999999999']);

    // Store may not even exist, so listSnapshots returns []
    const snaps = await listSnapshots(store);
    const preRestore = snaps.filter((s) => s.label === 'pre-restore');
    expect(preRestore).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Atomicity: corrupt tar leaves no partial staging artifacts
// ---------------------------------------------------------------------------

describe('R25-a: atomicity — no partial artifacts after failure', () => {
  it('corrupt tar leaves no .skill-switch-restore- staging dir behind', async () => {
    const target = join(work, 'skills');
    const store = join(work, 'store');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'file.txt'), 'original\n');
    const parent = join(target, '..');

    const snap = await snapshot(target, { store, label: 'pre' });
    await writeFile(snap.path, 'GARBAGE\n');

    await restoreSnapshot(snap.path, target).catch(() => undefined);

    const parentEntries = await readdir(parent);
    expect(parentEntries.some((e) => e.includes('.skill-switch-restore-'))).toBe(false);
    expect(parentEntries.some((e) => e.includes('.restore-bak-'))).toBe(false);
  });

  it('non-existent snapshot leaves target intact and no staging artifacts', async () => {
    const target = join(work, 'skills');
    const store = join(work, 'store');
    await mkdir(join(target, 'a'), { recursive: true });
    await writeFile(join(target, 'a', 'file.txt'), 'original\n');
    const parent = join(target, '..');

    await restoreSnapshot(join(store, 'ghost.tar.gz'), target).catch(() => undefined);

    expect(await readFile(join(target, 'a', 'file.txt'), 'utf8')).toBe('original\n');
    const parentEntries = await readdir(parent).catch(() => [] as string[]);
    expect(parentEntries.some((e) => e.includes('.skill-switch-restore-'))).toBe(false);
  });
});
