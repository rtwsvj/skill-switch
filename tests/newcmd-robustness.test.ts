// W5-a: Robustness + error-contract tests for the four newer commands.
//
// Covers gaps NOT already present in:
//   tests/init.test.ts, tests/profile.test.ts, tests/audit-config-wiring.test.ts
//
// Error-format contract (from exit-code-contract.test.ts):
//   errors → `错误: <msg>` on stderr, exit 1, no stack trace (no "    at " lines)
//   read-only success → exit 0, empty stderr
//
// Test scope:
//   export  – no-stack-trace contract; no skills.json (extra assertions)
//   import  – nonexistent file (no stack); invalid JSON (no stack); missing
//             `profile`/`declaration`/`lock` fields individually; malformed
//             inner declaration; --dry-run writes nothing into empty home;
//             --home isolation for import
//   init    – --json --force shape; --json --dry-run --force shape; no stack
//             on no error path (just confirms exit 0 stays clean)
//   audit --configs – invalid JSON settings.json → low "unparseable" finding
//                     (not a crash, exit 0); no .claude dir → 0 findings, exit 0;
//                     --json + invalid JSON returns finding array; no-stack-trace

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditConfigFiles, flattenConfigFindings } from '../src/core/audit/config-discovery.ts';
import { getSkillsJsonPath } from '../src/core/sync.ts';
import { getSkillsLockPath, type SkillsLockFile } from '../src/core/lock.ts';
import type { SkillsDeclarationFile } from '../src/core/sync.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

// ── CLI runner ──────────────────────────────────────────────────────────────

/** Run CLI via spawnSync; never throws. */
function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

/** Run CLI via execFileSync; throws on non-zero exit — useful for assertions that rely on stdio. */
function runStrict(args: string[]): { stdout: string; stderr: string; status: number } {
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

// ── Temp dir management ────────────────────────────────────────────────────

let tempDirs: string[] = [];

function freshHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'ss-robust-'));
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const SAMPLE_DECL: SkillsDeclarationFile = {
  version: 1,
  skills: [
    { name: 'a-skill', source: '/tmp/a-skill', agents: ['claude-code'], enabled: true, mode: 'copy' },
  ],
};

const SAMPLE_LOCK: SkillsLockFile = {
  version: 1,
  skills: [
    {
      name: 'a-skill',
      agent: 'claude-code',
      source: 'https://github.com/example/a-skill',
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

async function makeBundle(srcHome: string): Promise<string> {
  await writeFixtures(srcHome);
  const outDir = freshHome();
  const sspFile = join(outDir, 'test.ssp');
  const r = run(['export', '--home', srcHome, '--out', sspFile]);
  if (r.status !== 0) throw new Error(`export failed: ${r.stderr}`);
  return sspFile;
}

// ─────────────────────────────────────────────────────────────────────────────
// export: error-contract gaps
// ─────────────────────────────────────────────────────────────────────────────

describe('export: error-contract gaps', () => {
  it('no skills.json → stderr 含 错误:, no stack trace', () => {
    const home = freshHome();
    const r = runStrict(['export', '--home', home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
    expect(r.stderr).not.toMatch(/\n\s+at\s/);
  });

  it('no skills.json → stderr mentions skills.json', () => {
    const home = freshHome();
    const r = run(['export', '--home', home]);
    expect(r.stderr).toContain('skills.json');
  });

  it('no skills.json → stdout is empty', () => {
    const home = freshHome();
    const r = run(['export', '--home', home]);
    expect(r.stdout).toBe('');
  });

  it('--json + no skills.json → exit 1, 错误: on stderr, stdout empty', () => {
    const home = freshHome();
    const r = run(['export', '--home', home, '--json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
    expect(r.stdout).toBe('');
  });

  it('successful export → exit 0, empty stderr', async () => {
    const home = freshHome();
    await writeFixtures(home);
    const outDir = freshHome();
    const r = run(['export', '--home', home, '--out', join(outDir, 'out.ssp')]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// import: error-contract + edge-case gaps
// ─────────────────────────────────────────────────────────────────────────────

describe('import: nonexistent file → error contract', () => {
  it('exit 1', () => {
    const home = freshHome();
    const r = run(['import', '/tmp/does-not-exist-skill-switch-w5a.ssp', '--home', home]);
    expect(r.status).toBe(1);
  });

  it('stderr 含 错误:', () => {
    const home = freshHome();
    const r = runStrict(['import', '/tmp/does-not-exist-skill-switch-w5a.ssp', '--home', home]);
    expect(r.stderr).toMatch(/^错误:/m);
  });

  it('no stack trace', () => {
    const home = freshHome();
    const r = runStrict(['import', '/tmp/does-not-exist-skill-switch-w5a.ssp', '--home', home]);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });

  it('stdout is empty', () => {
    const home = freshHome();
    const r = run(['import', '/tmp/does-not-exist-skill-switch-w5a.ssp', '--home', home]);
    expect(r.stdout).toBe('');
  });
});

describe('import: invalid JSON file → error contract', () => {
  it('exit 1 + 错误: + no stack + stdout empty', async () => {
    const home = freshHome();
    const badDir = freshHome();
    const badFile = join(badDir, 'bad.ssp');
    await writeFile(badFile, '{ this is not json', 'utf8');

    const r = runStrict(['import', badFile, '--home', home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
    expect(r.stderr).toContain('JSON');
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
    expect(r.stdout).toBe('');
  });
});

describe('import: bundle missing required fields individually', () => {
  it('missing `profile` field → exit 1 + 错误:', async () => {
    const home = freshHome();
    const badDir = freshHome();
    const badFile = join(badDir, 'no-profile.ssp');
    // missing profile entirely
    await writeFile(badFile, JSON.stringify({ declaration: SAMPLE_DECL, lock: SAMPLE_LOCK }), 'utf8');
    const r = run(['import', badFile, '--home', home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
  });

  it('missing `declaration` field → exit 1 + 错误:', async () => {
    const home = freshHome();
    const badDir = freshHome();
    const badFile = join(badDir, 'no-decl.ssp');
    await writeFile(badFile, JSON.stringify({ profile: 1, lock: SAMPLE_LOCK }), 'utf8');
    const r = run(['import', badFile, '--home', home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
  });

  it('missing `lock` field → exit 1 + 错误:', async () => {
    const home = freshHome();
    const badDir = freshHome();
    const badFile = join(badDir, 'no-lock.ssp');
    await writeFile(badFile, JSON.stringify({ profile: 1, declaration: SAMPLE_DECL }), 'utf8');
    const r = run(['import', badFile, '--home', home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
  });

  it('declaration with wrong version → exit 1 + 错误:', async () => {
    const home = freshHome();
    const badDir = freshHome();
    const badFile = join(badDir, 'bad-decl-ver.ssp');
    // declaration.version is 99, not 1
    const bundle = {
      profile: 1,
      declaration: { version: 99, skills: [] },
      lock: SAMPLE_LOCK,
    };
    await writeFile(badFile, JSON.stringify(bundle), 'utf8');
    const r = run(['import', badFile, '--home', home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
  });

  it('declaration where skills is not an array → exit 1 + 错误:', async () => {
    const home = freshHome();
    const badDir = freshHome();
    const badFile = join(badDir, 'bad-decl-skills.ssp');
    const bundle = {
      profile: 1,
      declaration: { version: 1, skills: 'not-an-array' },
      lock: SAMPLE_LOCK,
    };
    await writeFile(badFile, JSON.stringify(bundle), 'utf8');
    const r = run(['import', badFile, '--home', home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
  });

  it('lock with wrong version → exit 1 + 错误:', async () => {
    const home = freshHome();
    const badDir = freshHome();
    const badFile = join(badDir, 'bad-lock-ver.ssp');
    const bundle = {
      profile: 1,
      declaration: SAMPLE_DECL,
      lock: { version: 99, skills: [] },
    };
    await writeFile(badFile, JSON.stringify(bundle), 'utf8');
    const r = run(['import', badFile, '--home', home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
  });

  it('root value is a JSON array (not object) → exit 1 + 错误:', async () => {
    const home = freshHome();
    const badDir = freshHome();
    const badFile = join(badDir, 'array.ssp');
    await writeFile(badFile, JSON.stringify([1, 2, 3]), 'utf8');
    const r = run(['import', badFile, '--home', home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
  });
});

describe('import: --dry-run writes nothing into empty home', () => {
  it('dry-run exits 0', async () => {
    const srcHome = freshHome();
    const sspFile = await makeBundle(srcHome);
    const destHome = freshHome();
    const r = run(['import', sspFile, '--home', destHome, '--dry-run']);
    expect(r.status).toBe(0);
  });

  it('dry-run: skills.json not created in empty home', async () => {
    const srcHome = freshHome();
    const sspFile = await makeBundle(srcHome);
    const destHome = freshHome();
    run(['import', sspFile, '--home', destHome, '--dry-run']);
    expect(existsSync(getSkillsJsonPath(destHome))).toBe(false);
  });

  it('dry-run: skills.lock.json not created in empty home', async () => {
    const srcHome = freshHome();
    const sspFile = await makeBundle(srcHome);
    const destHome = freshHome();
    run(['import', sspFile, '--home', destHome, '--dry-run']);
    expect(existsSync(getSkillsLockPath(destHome))).toBe(false);
  });

  it('dry-run stdout mentions expected file paths', async () => {
    const srcHome = freshHome();
    const sspFile = await makeBundle(srcHome);
    const destHome = freshHome();
    const r = run(['import', sspFile, '--home', destHome, '--dry-run']);
    expect(r.stdout).toContain(getSkillsJsonPath(destHome));
    expect(r.stdout).toContain(getSkillsLockPath(destHome));
  });

  it('dry-run notes existing files without crashing (--force not needed for --dry-run)', async () => {
    const srcHome = freshHome();
    const sspFile = await makeBundle(srcHome);
    const destHome = freshHome();
    // Pre-populate destination
    await writeFixtures(destHome);
    // dry-run should still exit 0 even though files exist
    const r = run(['import', sspFile, '--home', destHome, '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});

describe('import: --home isolation', () => {
  it('import only writes to specified --home, leaves other dirs untouched', async () => {
    const srcHome = freshHome();
    const sspFile = await makeBundle(srcHome);
    const destHome = freshHome();
    const bystander = freshHome();

    run(['import', sspFile, '--home', destHome]);

    expect(existsSync(getSkillsJsonPath(bystander))).toBe(false);
    expect(existsSync(getSkillsLockPath(bystander))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// init: --json output shape gaps
// ─────────────────────────────────────────────────────────────────────────────

describe('init: --json output shape gaps', () => {
  it('--json --force on fresh home → status: written, skills: number', async () => {
    const home = freshHome();
    const r = run(['init', '--home', home, '--json', '--force']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { status: string; skills: number };
    expect(parsed.status).toBe('written');
    expect(typeof parsed.skills).toBe('number');
  });

  it('--json --dry-run --force → dryRun: true, draft defined', async () => {
    const home = freshHome();
    // pre-populate so --force matters
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(getSkillsJsonPath(home), JSON.stringify({ version: 1, skills: [] }));
    const r = run(['init', '--home', home, '--json', '--dry-run', '--force']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { dryRun: boolean; draft: unknown };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.draft).toBeDefined();
  });

  it('--json output has `path` field on success', async () => {
    const home = freshHome();
    const r = run(['init', '--home', home, '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { path: string };
    expect(typeof parsed.path).toBe('string');
    expect(parsed.path).toContain('skills.json');
  });

  it('--json --dry-run output has `path` field', async () => {
    const home = freshHome();
    const r = run(['init', '--home', home, '--json', '--dry-run']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { path: string };
    expect(typeof parsed.path).toBe('string');
    expect(parsed.path).toContain('skills.json');
  });

  it('--json when file exists → status: exists, message mentions --force', async () => {
    const home = freshHome();
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(getSkillsJsonPath(home), JSON.stringify({ version: 1, skills: [] }));
    const r = run(['init', '--home', home, '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { status: string; message: string };
    expect(parsed.status).toBe('exists');
    expect(parsed.message).toMatch(/--force/i);
  });

  it('exit 0 with no errors produces empty stderr', async () => {
    const home = freshHome();
    const r = run(['init', '--home', home]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// audit --configs: edge-case gaps
// ─────────────────────────────────────────────────────────────────────────────

describe('audit --configs: invalid JSON settings.json (unit)', () => {
  it('invalid JSON yields a low "unparseable" finding (not a crash)', async () => {
    const home = freshHome();
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude/settings.json'), '{ not valid json!!!', 'utf8');

    const results = await auditConfigFiles(home);
    // The file is a regular file (not symlink), so it should be discovered
    const settingsResult = results.find((r) => r.relPath === '.claude/settings.json');
    expect(settingsResult).toBeDefined();
    const findings = flattenConfigFindings(results);
    // Should get the unparseable finding
    expect(findings.some((f) => f.ruleId === 'settings/unparseable')).toBe(true);
    // Severity must be low (not critical, not a crash)
    expect(findings.find((f) => f.ruleId === 'settings/unparseable')?.severity).toBe('low');
  });

  it('invalid JSON yields no critical or high findings', async () => {
    const home = freshHome();
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude/settings.json'), '{ invalid }', 'utf8');

    const results = await auditConfigFiles(home);
    const findings = flattenConfigFindings(results);
    expect(findings.every((f) => f.severity === 'low')).toBe(true);
  });
});

describe('audit --configs: invalid JSON settings.json (CLI subprocess)', () => {
  it('--configs with invalid JSON settings.json → exit 0 (low severity does not block)', async () => {
    const home = freshHome();
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude/settings.json'), '{ bad json', 'utf8');

    const r = runStrict(['audit', '--home', home, '--configs']);
    // low finding never blocks (only critical/high blocks, or score < 70 for skills)
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('--configs with invalid JSON settings.json → output mentions the file', async () => {
    const home = freshHome();
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude/settings.json'), '{ bad json', 'utf8');

    const r = run(['audit', '--home', home, '--configs']);
    expect(r.stdout).toContain('.claude/settings.json');
  });

  it('--configs --json with invalid JSON settings.json → valid JSON output, no crash', async () => {
    const home = freshHome();
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude/settings.json'), '{ not valid json', 'utf8');

    const r = run(['audit', '--home', home, '--configs', '--json']);
    expect(r.status).toBe(0);
    // stdout should parse as valid JSON
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    const parsed = JSON.parse(r.stdout) as {
      configs?: Array<{ relPath: string; findings: unknown[] }>;
      configsBlocked?: boolean;
    };
    expect(Array.isArray(parsed.configs)).toBe(true);
    // configsBlocked should be false (only low finding)
    expect(parsed.configsBlocked).toBe(false);
    // The invalid settings.json should appear in configs with at least one finding
    const settingsCfg = parsed.configs?.find((c) => c.relPath === '.claude/settings.json');
    expect(settingsCfg).toBeDefined();
    expect((settingsCfg?.findings.length ?? 0) > 0).toBe(true);
  });
});

describe('audit --configs: no .claude directory → 0 config findings', () => {
  it('empty home (no .claude dir) + --configs → exit 0', () => {
    const home = freshHome();
    // No .claude directory created at all
    const r = runStrict(['audit', '--home', home, '--configs']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('empty home (no .claude dir) + --configs → config section shows no files found', () => {
    const home = freshHome();
    const r = run(['audit', '--home', home, '--configs']);
    // Should mention config files section but report nothing found
    expect(r.stdout).toMatch(/config files/i);
    expect(r.stdout).toContain('no agent config files found');
  });

  it('empty home + --configs --json → configs is empty array, configsBlocked false', () => {
    const home = freshHome();
    const r = run(['audit', '--home', home, '--configs', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      configs?: unknown[];
      configsBlocked?: boolean;
    };
    expect(Array.isArray(parsed.configs)).toBe(true);
    expect(parsed.configs).toHaveLength(0);
    expect(parsed.configsBlocked).toBe(false);
  });
});

describe('audit --configs: no stack trace on error paths', () => {
  it('unknown audit path → 错误: + exit 1 + no stack trace', () => {
    const r = runStrict(['audit', '/nonexistent-path-skill-switch-w5a']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^错误:/m);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\n\s+at\s/);
  });
});

describe('audit --configs: unit edge cases', () => {
  it('home with only .claude directory (no config files) → zero results', async () => {
    const home = freshHome();
    // Create .claude dir but put no known config files in it
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'unknown-file.json'), '{}', 'utf8');

    const results = await auditConfigFiles(home);
    // unknown-file.json is not a known config — should not appear
    expect(results).toHaveLength(0);
  });

  it('empty settings.json (empty string) → unparseable finding, not a crash', async () => {
    const home = freshHome();
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude/settings.json'), '', 'utf8');

    const results = await auditConfigFiles(home);
    const findings = flattenConfigFindings(results);
    // Empty string is not valid JSON → unparseable
    expect(findings.some((f) => f.ruleId === 'settings/unparseable')).toBe(true);
  });

  it('settings.json with JSON null → zero findings (not object, returned early)', async () => {
    const home = freshHome();
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude/settings.json'), 'null', 'utf8');

    const results = await auditConfigFiles(home);
    const findings = flattenConfigFindings(results);
    // null is valid JSON but parses to null which is not an object → no findings
    expect(findings).toHaveLength(0);
  });

  it('settings.json with JSON array → zero findings (not object, returned early)', async () => {
    const home = freshHome();
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude/settings.json'), '[1,2,3]', 'utf8');

    const results = await auditConfigFiles(home);
    const findings = flattenConfigFindings(results);
    expect(findings).toHaveLength(0);
  });
});
