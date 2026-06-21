// W3-b:export / import CLI 验收测试 — 导出 .ssp 档案,从档案还原,全程写临时目录。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSkillsJsonPath, type SkillsDeclarationFile } from '../src/core/sync.ts';
import { getSkillsLockPath, type SkillsLockFile } from '../src/core/lock.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

// ----------------------------------------------------------
// Helper: run CLI as child process
// ----------------------------------------------------------
function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

// ----------------------------------------------------------
// Fixture helpers
// ----------------------------------------------------------
const SAMPLE_DECL: SkillsDeclarationFile = {
  version: 1,
  skills: [
    { name: 'tidy-notes', source: '/home/user/.skill-switch/store/tidy-notes', agents: ['claude-code'], enabled: true, mode: 'copy' },
    { name: 'git-helper', source: '/home/user/.skill-switch/store/git-helper', agents: ['codex'], enabled: false, mode: 'symlink' },
  ],
};

const SAMPLE_LOCK: SkillsLockFile = {
  version: 1,
  skills: [
    {
      name: 'tidy-notes',
      agent: 'claude-code',
      source: 'https://github.com/example/tidy-notes',
      sourceType: 'git',
      commit: 'abc123',
      sha256: 'aabbcc',
      mode: 'copy',
    },
  ],
};

async function writeFixtures(home: string): Promise<void> {
  await mkdir(join(home, '.skill-switch'), { recursive: true });
  await writeFile(getSkillsJsonPath(home), `${JSON.stringify(SAMPLE_DECL, null, 2)}\n`, 'utf8');
  await writeFile(getSkillsLockPath(home), `${JSON.stringify(SAMPLE_LOCK, null, 2)}\n`, 'utf8');
}

// ----------------------------------------------------------
// Temp directory management
// ----------------------------------------------------------
let tempDirs: string[] = [];

function freshHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'ss-profile-'));
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

// ----------------------------------------------------------
// export tests
// ----------------------------------------------------------
describe('skill-switch export', () => {
  it('exports a valid bundle from a populated home', async () => {
    const home = freshHome();
    await writeFixtures(home);
    const outDir = freshHome();
    const outFile = join(outDir, 'my.ssp');

    const result = runCli(['export', '--home', home, '--out', outFile]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('exported:');

    const raw = await readFile(outFile, 'utf8');
    const bundle = JSON.parse(raw) as { profile: number; declaration: SkillsDeclarationFile; lock: SkillsLockFile };
    expect(bundle.profile).toBe(1);
    expect(bundle.declaration.version).toBe(1);
    expect(Array.isArray(bundle.declaration.skills)).toBe(true);
    expect(bundle.declaration.skills).toHaveLength(2);
    expect(bundle.lock.version).toBe(1);
    expect(Array.isArray(bundle.lock.skills)).toBe(true);
    expect(bundle.lock.skills).toHaveLength(1);
  });

  it('--json prints bundle to stdout, writes no file', async () => {
    const home = freshHome();
    await writeFixtures(home);

    const result = runCli(['export', '--home', home, '--json']);
    expect(result.status).toBe(0);

    const bundle = JSON.parse(result.stdout) as { profile: number; declaration: object; lock: object };
    expect(bundle.profile).toBe(1);
    expect(typeof bundle.declaration).toBe('object');
    expect(typeof bundle.lock).toBe('object');
  });

  it('exits 1 with 错误: when no skills.json exists', () => {
    const home = freshHome();
    // don't write fixtures

    const result = runCli(['export', '--home', home]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('错误:');
    expect(result.stderr).toContain('skills.json');
  });

  it('defaults to ./skill-switch-profile.ssp when --out is omitted', async () => {
    const home = freshHome();
    await writeFixtures(home);

    // Run with cwd = project root so tsx resolves, but capture output file in a separate dir.
    // We can verify the default filename by checking where the file lands relative to cwd (ROOT).
    const defaultOut = join(ROOT, 'skill-switch-profile.ssp');
    // Clean up any pre-existing file first
    try { await rm(defaultOut, { force: true }); } catch { /* ok */ }

    try {
      const result = runCli(['export', '--home', home]);
      expect(result.status).toBe(0);
      expect(existsSync(defaultOut)).toBe(true);
    } finally {
      // Always clean up the file we wrote to the project root
      await rm(defaultOut, { force: true }).catch(() => undefined);
    }
  });

  it('respects --home isolation', async () => {
    const home1 = freshHome();
    const home2 = freshHome();
    await writeFixtures(home1);
    // home2 is empty — no skills.json

    const outDir = freshHome();
    const out1 = join(outDir, 'h1.ssp');

    // Export from home1 succeeds
    expect(runCli(['export', '--home', home1, '--out', out1]).status).toBe(0);

    // Export from home2 fails (no skills.json)
    const r2 = runCli(['export', '--home', home2]);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain('错误:');
  });
});

// ----------------------------------------------------------
// import tests
// ----------------------------------------------------------
describe('skill-switch import', () => {
  async function makeBundle(home: string): Promise<string> {
    await writeFixtures(home);
    const outDir = freshHome();
    const sspFile = join(outDir, 'test.ssp');
    const r = runCli(['export', '--home', home, '--out', sspFile]);
    if (r.status !== 0) throw new Error(`export failed: ${r.stderr}`);
    return sspFile;
  }

  it('imports declaration and lock into an empty home', async () => {
    const srcHome = freshHome();
    const sspFile = await makeBundle(srcHome);

    const destHome = freshHome();
    const result = runCli(['import', sspFile, '--home', destHome]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('imported declaration');
    expect(result.stdout).toContain('imported lock');
    expect(result.stdout).toContain('skill-switch sync');

    const decl = JSON.parse(await readFile(getSkillsJsonPath(destHome), 'utf8')) as SkillsDeclarationFile;
    expect(decl.version).toBe(1);
    expect(decl.skills).toHaveLength(2);

    const lock = JSON.parse(await readFile(getSkillsLockPath(destHome), 'utf8')) as SkillsLockFile;
    expect(lock.version).toBe(1);
    expect(lock.skills).toHaveLength(1);
    expect(lock.skills[0]!.name).toBe('tidy-notes');
  });

  it('refuses to clobber existing skills.json without --force', async () => {
    const srcHome = freshHome();
    const sspFile = await makeBundle(srcHome);

    const destHome = freshHome();
    // Pre-populate destination
    await writeFixtures(destHome);

    const result = runCli(['import', sspFile, '--home', destHome]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('错误:');
    expect(result.stderr).toContain('--force');
  });

  it('overwrites existing files when --force is given', async () => {
    const srcHome = freshHome();
    const sspFile = await makeBundle(srcHome);

    const destHome = freshHome();
    await writeFixtures(destHome);

    const result = runCli(['import', sspFile, '--home', destHome, '--force']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('imported declaration');
  });

  it('--dry-run prints what would be written without writing anything', async () => {
    const srcHome = freshHome();
    const sspFile = await makeBundle(srcHome);

    const destHome = freshHome();
    const result = runCli(['import', sspFile, '--home', destHome, '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dry-run');
    expect(result.stdout).toContain(getSkillsJsonPath(destHome));
    expect(result.stdout).toContain(getSkillsLockPath(destHome));

    // Nothing actually written
    expect(existsSync(getSkillsJsonPath(destHome))).toBe(false);
    expect(existsSync(getSkillsLockPath(destHome))).toBe(false);
  });

  it('round-trip: export → import into fresh home reproduces identical files', async () => {
    const srcHome = freshHome();
    await writeFixtures(srcHome);

    const outDir = freshHome();
    const sspFile = join(outDir, 'round.ssp');
    runCli(['export', '--home', srcHome, '--out', sspFile]);

    const destHome = freshHome();
    runCli(['import', sspFile, '--home', destHome]);

    const srcDecl = await readFile(getSkillsJsonPath(srcHome), 'utf8');
    const destDecl = await readFile(getSkillsJsonPath(destHome), 'utf8');
    // Compare parsed to avoid whitespace differences
    expect(JSON.parse(destDecl)).toEqual(JSON.parse(srcDecl));

    const srcLock = await readFile(getSkillsLockPath(srcHome), 'utf8');
    const destLock = await readFile(getSkillsLockPath(destHome), 'utf8');
    expect(JSON.parse(destLock)).toEqual(JSON.parse(srcLock));
  });

  it('respects --home isolation (imports only to specified home)', async () => {
    const srcHome = freshHome();
    const sspFile = await makeBundle(srcHome);

    const destHome1 = freshHome();
    const destHome2 = freshHome();

    runCli(['import', sspFile, '--home', destHome1]);

    // destHome2 must remain untouched
    expect(existsSync(getSkillsJsonPath(destHome2))).toBe(false);
    expect(existsSync(getSkillsLockPath(destHome2))).toBe(false);
  });

  it('exits 1 with 错误: on a malformed bundle (bad profile field)', async () => {
    const destHome = freshHome();
    const badBundleDir = freshHome();
    const badFile = join(badBundleDir, 'bad.ssp');
    await writeFile(badFile, JSON.stringify({ profile: 99, declaration: {}, lock: {} }), 'utf8');

    const result = runCli(['import', badFile, '--home', destHome]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('错误:');
  });

  it('exits 1 with 错误: on a bundle with missing fields', async () => {
    const destHome = freshHome();
    const badBundleDir = freshHome();
    const badFile = join(badBundleDir, 'bad.ssp');
    await writeFile(badFile, JSON.stringify({ profile: 1, declaration: null }), 'utf8');

    const result = runCli(['import', badFile, '--home', destHome]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('错误:');
  });

  it('exits 1 with 错误: when the archive file does not exist', () => {
    const destHome = freshHome();
    const result = runCli(['import', '/tmp/nonexistent-skill-switch-bundle-xyz.ssp', '--home', destHome]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('错误:');
    expect(result.stderr).toContain('找不到');
  });

  it('exits 1 with 错误: when the archive file contains invalid JSON', async () => {
    const destHome = freshHome();
    const badDir = freshHome();
    const badFile = join(badDir, 'corrupt.ssp');
    await writeFile(badFile, '{ not valid json ]]]', 'utf8');

    const result = runCli(['import', badFile, '--home', destHome]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('错误:');
    expect(result.stderr).toContain('JSON');
  });
});
