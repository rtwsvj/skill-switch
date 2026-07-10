// Security regression coverage for archive entry types.
// A snapshot restore must reject links before replacing the existing target:
// validating entry names alone does not make symlink/hardlink archives safe.
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreSnapshot } from '../src/core/backup.ts';

let work: string;
let target: string;
let store: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'skill-switch-audit-archive-links-'));
  target = join(work, 'target');
  store = join(work, 'store');
  await mkdir(target, { recursive: true });
  await mkdir(store, { recursive: true });
  await writeFile(join(target, 'sentinel.txt'), 'keep-existing-target\n');
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function archive(payload: string, name: string): string {
  const path = join(store, name);
  execFileSync('tar', ['-czf', path, '-C', payload, '.']);
  return path;
}

async function expectRejectedWithoutReplacingTarget(path: string): Promise<void> {
  await expect(restoreSnapshot(path, target)).rejects.toThrow(/hardlink|link|symlink|不安全/i);
  expect(await readFile(join(target, 'sentinel.txt'), 'utf8')).toBe('keep-existing-target\n');
}

describe('audit blind spot: snapshot archive link entries', () => {
  it('rejects a symbolic-link entry before extraction or target replacement', async () => {
    const payload = join(work, 'symlink-payload');
    await mkdir(payload, { recursive: true });
    await writeFile(join(work, 'outside.txt'), 'outside-data\n');
    await symlink('../../outside.txt', join(payload, 'pivot'));

    const path = archive(payload, '9999999999991__symlink.tar.gz');
    const verboseListing = execFileSync('tar', ['-tvzf', path], { encoding: 'utf8' });
    expect(verboseListing).toMatch(/pivot/);

    await expectRejectedWithoutReplacingTarget(path);
  });

  it('rejects a hard-link entry before extraction or target replacement', async () => {
    const payload = join(work, 'hardlink-payload');
    await mkdir(payload, { recursive: true });
    const original = join(payload, 'original.txt');
    const alias = join(payload, 'alias.txt');
    await writeFile(original, 'shared-inode\n');
    await link(original, alias);

    const path = archive(payload, '9999999999992__hardlink.tar.gz');
    const verboseListing = execFileSync('tar', ['-tvzf', path], { encoding: 'utf8' });
    expect(verboseListing).toMatch(/alias\.txt|original\.txt/);

    await expectRejectedWithoutReplacingTarget(path);
  });
});
