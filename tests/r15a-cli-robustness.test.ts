// R15-a: CLI-boundary robustness regression tests.
//
// Each test locks in the ALREADY-GRACEFUL bad-input behavior of three commands:
//   - import  : directory-as-file, empty/truncated file
//   - lock    : corrupt JSON, wrong structure (skills not array), with/without --verify/--json
//   - doctor  : corrupt skills.json, corrupt skills.lock.json, with/without --ci/--json
//   - lint    : nonexistent path no-stack-trace contract
//
// All cases were verified to already produce clean "错误: …" stderr + exit 1 with no
// stack trace before this test was added (probe results in R15-a commit message).
//
// Method: real subprocess via spawnSync; all writes go to temp dirs.

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

/** Run CLI; never throws. Captures stdout, stderr, exit status. */
function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

// ── temp dir management ──────────────────────────────────────────────────────

const tempDirs: string[] = [];

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ss-r15a-'));
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// ─────────────────────────────────────────────────────────────────────────────
// import: directory passed instead of a file
// ─────────────────────────────────────────────────────────────────────────────

describe('import: directory-as-file input', () => {
  it('exit 1', async () => {
    const dir = freshDir();
    const home = freshDir();
    const r = run(['import', dir, '--home', home]);
    expect(r.status).toBe(1);
  });

  it('stderr contains 错误:', async () => {
    const dir = freshDir();
    const home = freshDir();
    const r = run(['import', dir, '--home', home]);
    expect(r.stderr).toMatch(/^错误:/m);
  });

  it('stdout is empty', async () => {
    const dir = freshDir();
    const home = freshDir();
    const r = run(['import', dir, '--home', home]);
    expect(r.stdout).toBe('');
  });

  it('no stack trace', async () => {
    const dir = freshDir();
    const home = freshDir();
    const r = run(['import', dir, '--home', home]);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// import: empty file (zero bytes)
// ─────────────────────────────────────────────────────────────────────────────

describe('import: empty file', () => {
  it('exit 1 + 错误: + no stack + stdout empty', async () => {
    const dir = freshDir();
    const home = freshDir();
    const emptyFile = join(dir, 'empty.ssp');
    await writeFile(emptyFile, '', 'utf8');

    const r = run(['import', emptyFile, '--home', home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
    expect(r.stdout).toBe('');
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// import: truncated (partial) JSON file
// ─────────────────────────────────────────────────────────────────────────────

describe('import: truncated JSON file', () => {
  it('exit 1 + 错误: + no stack + stdout empty', async () => {
    const dir = freshDir();
    const home = freshDir();
    const truncFile = join(dir, 'trunc.ssp');
    await writeFile(truncFile, '{"profile":1,"declaration":{"version":1,"sk', 'utf8');

    const r = run(['import', truncFile, '--home', home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
    expect(r.stdout).toBe('');
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lock: corrupt JSON in skills.lock.json (table mode)
// ─────────────────────────────────────────────────────────────────────────────

describe('lock: corrupt JSON skills.lock.json', () => {
  async function makeCorruptLockHome(): Promise<string> {
    const home = freshDir();
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(join(home, '.skill-switch', 'skills.lock.json'), '{not valid json\n', 'utf8');
    return home;
  }

  it('exit 1', async () => {
    const home = await makeCorruptLockHome();
    expect(run(['lock', '--home', home]).status).toBe(1);
  });

  it('stderr contains 错误:', async () => {
    const home = await makeCorruptLockHome();
    expect(run(['lock', '--home', home]).stderr).toMatch(/^错误:/m);
  });

  it('stdout is empty', async () => {
    const home = await makeCorruptLockHome();
    expect(run(['lock', '--home', home]).stdout).toBe('');
  });

  it('no stack trace', async () => {
    const home = await makeCorruptLockHome();
    const r = run(['lock', '--home', home]);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });

  it('--json flag: still exit 1 + 错误: + no stack', async () => {
    const home = await makeCorruptLockHome();
    const r = run(['lock', '--home', home, '--json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lock: skills.lock.json exists but skills field is not an array
// ─────────────────────────────────────────────────────────────────────────────

describe('lock: skills.lock.json with skills not an array', () => {
  async function makeWrongStructureLockHome(): Promise<string> {
    const home = freshDir();
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(
      join(home, '.skill-switch', 'skills.lock.json'),
      JSON.stringify({ version: 1, skills: 'not-an-array' }),
      'utf8',
    );
    return home;
  }

  it('exit 1 + 错误: + no stack', async () => {
    const home = await makeWrongStructureLockHome();
    const r = run(['lock', '--home', home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lock --verify: corrupt JSON in skills.lock.json
// ─────────────────────────────────────────────────────────────────────────────

describe('lock --verify: corrupt JSON skills.lock.json', () => {
  async function makeCorruptVerifyHome(): Promise<string> {
    const home = freshDir();
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(join(home, '.skill-switch', 'skills.lock.json'), '{CORRUPT', 'utf8');
    return home;
  }

  it('exit 1', async () => {
    const home = await makeCorruptVerifyHome();
    expect(run(['lock', '--home', home, '--verify']).status).toBe(1);
  });

  it('stderr contains 错误:', async () => {
    const home = await makeCorruptVerifyHome();
    expect(run(['lock', '--home', home, '--verify']).stderr).toMatch(/^错误:/m);
  });

  it('no stack trace', async () => {
    const home = await makeCorruptVerifyHome();
    const r = run(['lock', '--home', home, '--verify']);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });

  it('--json flag: exit 1 + 错误: + no stack', async () => {
    const home = await makeCorruptVerifyHome();
    const r = run(['lock', '--home', home, '--verify', '--json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// doctor: corrupt skills.json
// ─────────────────────────────────────────────────────────────────────────────

describe('doctor: corrupt skills.json', () => {
  async function makeCorruptDeclHome(): Promise<string> {
    const home = freshDir();
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(join(home, '.skill-switch', 'skills.json'), '{not valid json\n', 'utf8');
    return home;
  }

  it('exit 1', async () => {
    const home = await makeCorruptDeclHome();
    expect(run(['doctor', '--home', home]).status).toBe(1);
  });

  it('stderr contains 错误:', async () => {
    const home = await makeCorruptDeclHome();
    expect(run(['doctor', '--home', home]).stderr).toMatch(/^错误:/m);
  });

  it('stdout is empty', async () => {
    const home = await makeCorruptDeclHome();
    expect(run(['doctor', '--home', home]).stdout).toBe('');
  });

  it('no stack trace', async () => {
    const home = await makeCorruptDeclHome();
    const r = run(['doctor', '--home', home]);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });

  it('--ci flag: still exit 1 + 错误: + no stack', async () => {
    const home = await makeCorruptDeclHome();
    const r = run(['doctor', '--home', home, '--ci']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });

  it('--json flag: still exit 1 + 错误: + no stack', async () => {
    const home = await makeCorruptDeclHome();
    const r = run(['doctor', '--home', home, '--json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// doctor: corrupt skills.lock.json (skills.json is fine)
// ─────────────────────────────────────────────────────────────────────────────

describe('doctor: corrupt skills.lock.json', () => {
  async function makeCorruptLockDoctorHome(): Promise<string> {
    const home = freshDir();
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    // Valid skills.json
    await writeFile(
      join(home, '.skill-switch', 'skills.json'),
      JSON.stringify({ version: 1, skills: [] }),
      'utf8',
    );
    // Corrupt lock
    await writeFile(join(home, '.skill-switch', 'skills.lock.json'), '{BROKEN JSON\n', 'utf8');
    return home;
  }

  it('exit 1 + 错误: + no stack', async () => {
    const home = await makeCorruptLockDoctorHome();
    const r = run(['doctor', '--home', home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });

  it('--ci: exit 1 + 错误: + no stack', async () => {
    const home = await makeCorruptLockDoctorHome();
    const r = run(['doctor', '--home', home, '--ci']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lint: nonexistent path — no-stack-trace contract
// ─────────────────────────────────────────────────────────────────────────────

describe('lint: nonexistent path — no stack trace', () => {
  it('exit 1', () => {
    const r = run(['lint', '/nonexistent-path-r15a-skill-switch']);
    expect(r.status).toBe(1);
  });

  it('no stack trace in combined output', () => {
    const r = run(['lint', '/nonexistent-path-r15a-skill-switch']);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });
});
