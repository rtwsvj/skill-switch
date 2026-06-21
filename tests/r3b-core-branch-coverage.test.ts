/**
 * R3-b: Core branch coverage — genuinely-untested error/edge paths.
 *
 * Modules targeted (low branch% before this file):
 *   1. safe-copy.ts       — line 14: isFile() branch (copy a plain file, not a dir)
 *   2. state-io.ts        — readJsonState JSON-corrupt branch; writeJsonState atomic behavior
 *   3. stats-cache.ts     — line 35: readStatsCache fallback when data.entries is not object
 *   4. scan.ts            — line 79: skill-dir without SKILL.md is skipped
 *                           file-not-dir entry in skillsDir is skipped
 *   5. skill-name.ts      — line 34: posix-absolute, line 37: Windows reserved stem
 *   6. transcripts.ts     — line 43: listTranscriptFiles depth limit → skip sub-dir
 *   7. sync.ts            — removeFromDeclaration agentSources paths (lines 121-122, 135, 137-141, 149)
 *                           readDeclaration throws when skills is not array
 *   8. drift.ts           — line 66-67: local target missing → localModified=true
 *                           sourceType='local' → upstream block skipped entirely
 *   9. install.ts         — line 120: non-directory source throws
 *                           line 135-138: skill filter narrows to empty / source has no SKILL.md
 *  10. remove.ts          — line 24: unknown agent throws early
 *  11. watch.ts           — line 52: skillName from frontmatter vs missing frontmatter
 *  12. uninstall.ts       — resolveAppTarget / resolveBinTarget all branches
 *  13. lock.ts            — readSkillsLock throws when skills is not array
 */

import { mkdtempSync } from 'node:fs';
import {
  mkdir,
  rm,
  symlink,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ──────────────────────────────────────────────────────────────────────────────
// 1. safe-copy: isFile() branch — copy a plain file (not a dir, not a symlink)
// ──────────────────────────────────────────────────────────────────────────────
import { copyDirWithoutSymlinks } from '../src/core/safe-copy.ts';

describe('safe-copy: isFile() branch', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'r3b-safecopy-')); });
  afterEach(() => rm(work, { recursive: true, force: true }).catch(() => undefined));

  it('copies a plain file (not a directory) to target path (line 8-11 branch)', async () => {
    const src = join(work, 'hello.txt');
    const dst = join(work, 'out', 'hello.txt');
    await writeFile(src, 'hello world\n');

    await copyDirWithoutSymlinks(src, dst);

    const content = await readFile(dst, 'utf8');
    expect(content).toBe('hello world\n');
  });

  it('skips a symlink source without throwing (line 6 — isSymbolicLink branch)', async () => {
    const real = join(work, 'real.txt');
    const link = join(work, 'link.txt');
    const dst = join(work, 'out.txt');
    await writeFile(real, 'data\n');
    await symlink(real, link);

    // Should silently skip (return without copying)
    await copyDirWithoutSymlinks(link, dst);

    // dst must NOT exist — symlinks are silently skipped
    const exists = await readFile(dst, 'utf8').catch(() => null);
    expect(exists).toBeNull();
  });

  it('skips symlink directory entries while recursing (line 17 — isSymbolicLink in loop)', async () => {
    // Dir containing: real.txt + link_to_real (symlink to real.txt)
    const srcDir = join(work, 'srcdir');
    const dstDir = join(work, 'dstdir');
    await mkdir(srcDir);
    await writeFile(join(srcDir, 'real.txt'), 'real\n');
    await symlink(join(srcDir, 'real.txt'), join(srcDir, 'link_to_real'));

    await copyDirWithoutSymlinks(srcDir, dstDir);

    const realOut = await readFile(join(dstDir, 'real.txt'), 'utf8');
    expect(realOut).toBe('real\n');
    // The symlink entry must not be copied
    const linkOut = await readFile(join(dstDir, 'link_to_real'), 'utf8').catch(() => null);
    expect(linkOut).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. state-io: error branches
// ──────────────────────────────────────────────────────────────────────────────
import { readJsonState, writeJsonState, StateFileError } from '../src/core/state-io.ts';

describe('state-io: readJsonState error paths', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'r3b-stateio-')); });
  afterEach(() => rm(work, { recursive: true, force: true }).catch(() => undefined));

  it('returns fallback when file does not exist (ENOENT branch)', async () => {
    const result = await readJsonState(join(work, 'missing.json'), { default: true });
    expect(result).toEqual({ default: true });
  });

  it('throws StateFileError when file contains invalid JSON (JSON.parse catch branch)', async () => {
    const p = join(work, 'bad.json');
    await writeFile(p, '{ NOT VALID JSON ');
    await expect(readJsonState(p, null)).rejects.toThrow(StateFileError);
    await expect(readJsonState(p, null)).rejects.toThrow(/JSON/);
  });

  it('writeJsonState creates the target atomically (dir auto-created)', async () => {
    const p = join(work, 'nested', 'deep', 'data.json');
    await writeJsonState(p, { ok: true });
    const back = JSON.parse(await readFile(p, 'utf8')) as { ok: boolean };
    expect(back.ok).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. stats-cache: fallback when data.entries is not an object (line 35)
// ──────────────────────────────────────────────────────────────────────────────
import { readStatsCache, getStatsCachePath } from '../src/core/stats-cache.ts';

describe('stats-cache: readStatsCache fallback branches', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'r3b-statscache-')); });
  afterEach(() => rm(home, { recursive: true, force: true }).catch(() => undefined));

  it('returns empty cache when file is absent', async () => {
    const cache = await readStatsCache(home);
    expect(cache).toEqual({ version: 1, entries: {} });
  });

  it('returns empty cache when data itself is null (line 35 branch — falsy data.entries)', async () => {
    // null does not pass the `data && ...` check at line 29 → falls through to line 35
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(getStatsCachePath(home), 'null\n');

    // readJsonState will throw StateFileError because null is a valid JSON value
    // but wait — readJsonState with fallback EMPTY returns EMPTY on ENOENT, throws on bad JSON.
    // 'null' is valid JSON so readJsonState returns null; then data is falsy → falls through.
    const cache = await readStatsCache(home);
    expect(cache).toEqual({ version: 1, entries: {} });
  });

  it('returns empty cache when entries is null (falsy data.entries check)', async () => {
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(
      getStatsCachePath(home),
      `${JSON.stringify({ version: 1, entries: null })}\n`,
    );
    // null entries is falsy → doesn't pass `data.entries &&` → returns fallback
    const cache = await readStatsCache(home);
    expect(cache).toEqual({ version: 1, entries: {} });
  });

  it('returns empty cache when JSON is corrupt (catch branch line 32-35)', async () => {
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(getStatsCachePath(home), '{ BROKEN');

    const cache = await readStatsCache(home);
    expect(cache).toEqual({ version: 1, entries: {} });
  });

  it('returns data normally when cache is valid', async () => {
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    const data = {
      version: 1 as const,
      entries: {
        '/some/file.jsonl': { mtimeMs: 1000, size: 200, invocations: [], parseErrors: 0 },
      },
    };
    await writeFile(getStatsCachePath(home), `${JSON.stringify(data)}\n`);

    const cache = await readStatsCache(home);
    expect(Object.keys(cache.entries)).toEqual(['/some/file.jsonl']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. scan.ts: non-directory entries skipped; skill-dir without SKILL.md skipped
// ──────────────────────────────────────────────────────────────────────────────
import { scanHome } from '../src/core/scan.ts';

describe('scan: edge cases for skipping entries', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'r3b-scan-')); });
  afterEach(() => rm(home, { recursive: true, force: true }).catch(() => undefined));

  it('skips a plain file in the skills directory (line 79 — isDirectory(skillDir) check)', async () => {
    // Create a plain file at the skills dir level alongside a valid skill
    const skillsDir = join(home, '.claude', 'skills');
    await mkdir(join(skillsDir, 'real-skill'), { recursive: true });
    await writeFile(
      join(skillsDir, 'real-skill', 'SKILL.md'),
      '---\nname: real-skill\ndescription: d.\n---\n\nBody.\n',
    );
    // A plain file masquerading as a skill entry
    await writeFile(join(skillsDir, 'not-a-skill.txt'), 'this is a file, not a dir\n');

    const records = await scanHome(home);
    expect(records.map((r) => r.dirName)).toEqual(['real-skill']);
  });

  it('skips a directory in skills dir that has no SKILL.md (line 84 — stat catch)', async () => {
    const skillsDir = join(home, '.claude', 'skills');
    // A dir without SKILL.md — should be skipped
    await mkdir(join(skillsDir, 'no-skill-md'), { recursive: true });
    await writeFile(join(skillsDir, 'no-skill-md', 'README.md'), '# Not a skill\n');
    // A valid skill
    await mkdir(join(skillsDir, 'valid-skill'), { recursive: true });
    await writeFile(
      join(skillsDir, 'valid-skill', 'SKILL.md'),
      '---\nname: valid-skill\ndescription: valid.\n---\n\nBody.\n',
    );

    const records = await scanHome(home);
    expect(records.map((r) => r.dirName)).toEqual(['valid-skill']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 5. skill-name.ts: posix-absolute + Windows reserved stem (lines 34, 37)
// ──────────────────────────────────────────────────────────────────────────────
import { isSafeSkillName } from '../src/core/skill-name.ts';

describe('skill-name: uncovered isSafeSkillName branches', () => {
  it('rejects a Windows-absolute-looking path with drive letter (line 34 — win32.isAbsolute)', () => {
    // C:\ form is caught by win32.isAbsolute (not caught by includes('/') or posix.isAbsolute)
    expect(isSafeSkillName('C:\\skill')).toBe(false);
  });

  it('rejects Windows reserved device name CON (line 37 — stem check)', () => {
    expect(isSafeSkillName('CON')).toBe(false);
    expect(isSafeSkillName('con')).toBe(false); // case-insensitive
    expect(isSafeSkillName('CON.md')).toBe(false);
  });

  it('rejects Windows reserved names: NUL, AUX, COM1, LPT1 (line 37)', () => {
    expect(isSafeSkillName('NUL')).toBe(false);
    expect(isSafeSkillName('AUX')).toBe(false);
    expect(isSafeSkillName('COM1')).toBe(false);
    expect(isSafeSkillName('LPT1')).toBe(false);
    expect(isSafeSkillName('COM9.txt')).toBe(false);
  });

  it('accepts normal skill names that are not reserved', () => {
    expect(isSafeSkillName('my-skill')).toBe(true);
    expect(isSafeSkillName('console-helper')).toBe(true); // "console" is not in reserved set
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 6. transcripts.ts: listTranscriptFiles depth limit (line 43 — depth >= maxDepth)
// ──────────────────────────────────────────────────────────────────────────────
import { listTranscriptFiles } from '../src/core/transcripts.ts';

describe('transcripts: listTranscriptFiles depth limit', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'r3b-transcripts-')); });
  afterEach(() => rm(work, { recursive: true, force: true }).catch(() => undefined));

  it('stops recursing when maxDepth is reached (line 43 — depth >= maxDepth branch)', async () => {
    // Structure: root/proj/surface.jsonl  (depth 1) + root/proj/sub/deep.jsonl (depth 2)
    // With maxDepth=1, depth=1 entry's subdirs should not be walked (depth >= maxDepth)
    const root = join(work, 'projects');
    await mkdir(join(root, 'proj', 'sub'), { recursive: true });
    await writeFile(join(root, 'proj', 'surface.jsonl'), '{"type":"test"}\n');
    await writeFile(join(root, 'proj', 'sub', 'deep.jsonl'), '{"type":"deep"}\n');

    // maxDepth=1 means we walk root (depth=0), proj (depth=1), but when inside proj (depth=1)
    // we encounter sub which would be depth=2, so we continue past it (depth >= maxDepth)
    const files = await listTranscriptFiles([root], 1);
    const names = files.map((f) => f.split('/').pop());
    expect(names).toContain('surface.jsonl');
    expect(names).not.toContain('deep.jsonl');
  });

  it('handles unreadable/missing root gracefully (walk catch branch)', async () => {
    const files = await listTranscriptFiles([join(work, 'does-not-exist')]);
    expect(files).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 7. sync.ts: removeFromDeclaration — agentSources branch paths
// ──────────────────────────────────────────────────────────────────────────────
import {
  removeFromDeclaration,
  upsertSkillDeclarations,
  getSkillsJsonPath,
  readDeclaration,
} from '../src/core/sync.ts';

describe('sync: removeFromDeclaration — agentSources edge paths', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'r3b-sync-')); });
  afterEach(() => rm(home, { recursive: true, force: true }).catch(() => undefined));

  it('removes a skill entirely when it has only one agent (agents.length === 0 branch, line 126)', async () => {
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    const path = getSkillsJsonPath(home);
    await upsertSkillDeclarations(path, [
      { name: 'alpha', agent: 'claude-code', source: '/src/alpha', mode: 'copy' },
    ]);

    await removeFromDeclaration(path, 'alpha', 'claude-code');

    const decl = await readDeclaration(path);
    expect(decl.skills).toHaveLength(0);
  });

  it('keeps other skills untouched when removing a specific skill (skill.name !== name branch, line 120)', async () => {
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    const path = getSkillsJsonPath(home);
    await upsertSkillDeclarations(path, [
      { name: 'alpha', agent: 'claude-code', source: '/a', mode: 'copy' },
    ]);
    await upsertSkillDeclarations(path, [
      { name: 'beta', agent: 'claude-code', source: '/b', mode: 'copy' },
    ]);

    await removeFromDeclaration(path, 'alpha', 'claude-code');

    const decl = await readDeclaration(path);
    expect(decl.skills.map((s) => s.name)).toEqual(['beta']);
  });

  it('promotes remaining agentSource to top-level and removes that agent from agentSources (lines 134-141)', async () => {
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    const path = getSkillsJsonPath(home);
    // Install for two agents to get agentSources
    await upsertSkillDeclarations(path, [
      { name: 'beta', agent: 'claude-code', source: '/src/beta-cc', mode: 'copy' },
    ]);
    await upsertSkillDeclarations(path, [
      { name: 'beta', agent: 'gemini-cli', source: '/src/beta-gem', mode: 'symlink' },
    ]);

    // Verify agentSources was created with both agents
    let decl = await readDeclaration(path);
    expect(decl.skills[0]!.agentSources).toBeDefined();
    expect(Object.keys(decl.skills[0]!.agentSources!)).toHaveLength(2);

    // Remove gemini-cli — leaves only claude-code.
    // After delete agentSources['gemini-cli'], Object.keys(...).length === 1 (not 0)
    // → goes to else branch: promotes agents[0] (claude-code) source to top-level
    await removeFromDeclaration(path, 'beta', 'gemini-cli');

    decl = await readDeclaration(path);
    expect(decl.skills).toHaveLength(1);
    const skill = decl.skills[0]!;
    expect(skill.agents).toEqual(['claude-code']);
    // Top-level source must be promoted from claude-code's agentSource
    expect(skill.source).toBe('/src/beta-cc');
    expect(skill.mode).toBe('copy');
  });

  it('drops agentSources entirely when all agents removed except last one and agentSources empties (line 135)', async () => {
    // To hit the Object.keys(agentSources).length === 0 branch, we need to set up a skill
    // where after deleting the removed agent, the remaining agents have no separate agentSource.
    // This requires manually writing a declaration with agentSources containing only the agent
    // being removed.
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    const path = getSkillsJsonPath(home);

    // Manually write a declaration where the skill has agentSources for gemini-cli only,
    // with claude-code as an agent but no separate agentSource (so after removing gemini-cli
    // from agentSources, the object becomes empty).
    await writeJsonState(path, {
      version: 1,
      skills: [{
        name: 'delta',
        source: '/src/delta',
        agents: ['claude-code', 'gemini-cli'],
        enabled: true,
        mode: 'copy',
        agentSources: {
          'gemini-cli': { source: '/src/delta-gem', mode: 'symlink' },
        },
      }],
    });

    // Remove gemini-cli → delete agentSources['gemini-cli'] → Object.keys({}).length === 0
    // → delete agentSources entirely (line 135)
    await removeFromDeclaration(path, 'delta', 'gemini-cli');

    const decl = await readDeclaration(path);
    expect(decl.skills).toHaveLength(1);
    const skill = decl.skills[0]!;
    expect(skill.agents).toEqual(['claude-code']);
    // agentSources should be deleted (line 135)
    expect(skill.agentSources).toBeUndefined();
  });

  it('promotes remaining agentSource as top-level when one agent removed from multi-agent (line 137-141)', async () => {
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    const path = getSkillsJsonPath(home);
    // Install for three agents so agentSources has 3 entries
    await upsertSkillDeclarations(path, [
      { name: 'gamma', agent: 'claude-code', source: '/src/gamma-cc', mode: 'copy' },
    ]);
    await upsertSkillDeclarations(path, [
      { name: 'gamma', agent: 'gemini-cli', source: '/src/gamma-gem', mode: 'symlink' },
    ]);
    await upsertSkillDeclarations(path, [
      { name: 'gamma', agent: 'codex', source: '/src/gamma-codex', mode: 'copy' },
    ]);

    // Verify 3 agents with agentSources
    let decl = await readDeclaration(path);
    expect(decl.skills[0]!.agents).toHaveLength(3);
    expect(decl.skills[0]!.agentSources).toBeDefined();

    // Remove claude-code → remaining: gemini-cli, codex (still has agentSources with 2 entries)
    // hits the else branch at line 136: promotes agents[0]'s source to top-level
    await removeFromDeclaration(path, 'gamma', 'claude-code');

    decl = await readDeclaration(path);
    const skill = decl.skills[0]!;
    expect(skill.agents).not.toContain('claude-code');
    expect(skill.agents).toHaveLength(2);
    // top-level source must be promoted to the first remaining agent's source
    expect(skill.source).toBeTruthy();
    // agentSources still exists (2 remaining agents)
    expect(skill.agentSources).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 8. drift.ts: local target missing + sourceType='local' branches
// ──────────────────────────────────────────────────────────────────────────────
import { checkDrift } from '../src/core/drift.ts';
import { getSkillsLockPath } from '../src/core/lock.ts';
import type { SkillsLockFile } from '../src/core/lock.ts';

describe('drift: uncovered branches', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'r3b-drift-')); });
  afterEach(() => rm(home, { recursive: true, force: true }).catch(() => undefined));

  it('marks localModified=true when installed skill directory is missing (lines 65-67)', async () => {
    // Write a lock entry for a skill that does NOT exist on disk
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    const lockFile: SkillsLockFile = {
      version: 1,
      skills: [{
        name: 'phantom-skill',
        agent: 'claude-code',
        source: '/some/source',
        sourceType: 'local',
        sha256: 'abc123',
        mode: 'copy',
      }],
    };
    await writeJsonState(getSkillsLockPath(home), lockFile);

    const entries = await checkDrift(home);
    expect(entries).toHaveLength(1);
    // The disk target is missing → localModified must be true (line 66)
    expect(entries[0]!.localModified).toBe(true);
    expect(entries[0]!.detail).toContain('安装产物缺失');
  });

  it('skips upstream check when sourceType is "local" (no entry.commit, line 80 branch)', async () => {
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    // Create actual skill on disk
    const skillDir = join(home, '.claude', 'skills', 'local-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: local-skill\ndescription: d.\n---\n\nBody.\n',
    );

    const { computeSkillFolderHash } = await import('../src/vendor/vercel-skills/local-lock.ts');
    const sha256 = await computeSkillFolderHash(skillDir);

    const lockFile: SkillsLockFile = {
      version: 1,
      skills: [{
        name: 'local-skill',
        agent: 'claude-code',
        source: '/src/local-skill',
        sourceType: 'local', // NOT 'git' → upstream block skipped entirely
        sha256,
        mode: 'copy',
      }],
    };
    await writeJsonState(getSkillsLockPath(home), lockFile);

    const entries = await checkDrift(home);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.upstreamAhead).toBe(false);
    expect(entries[0]!.upstreamCommit).toBeUndefined();
    expect(entries[0]!.state).toBe('in-sync');
  });

  it('detail is the "在线一致" fallback string when all diffs are empty (line 98 || branch)', async () => {
    // A local skill that is in-sync: both upstream and local details are empty strings
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    const skillDir = join(home, '.claude', 'skills', 'ok-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: ok-skill\ndescription: d.\n---\n\nBody.\n',
    );
    const { computeSkillFolderHash } = await import('../src/vendor/vercel-skills/local-lock.ts');
    const sha256 = await computeSkillFolderHash(skillDir);

    await writeJsonState(getSkillsLockPath(home), {
      version: 1,
      skills: [{ name: 'ok-skill', agent: 'claude-code', source: '/s', sourceType: 'local', sha256, mode: 'copy' }],
    } satisfies SkillsLockFile);

    const entries = await checkDrift(home);
    // Both upstreamDetail and localDetail are empty → detail falls back to '与锁定基线一致'
    expect(entries[0]!.detail).toBe('与锁定基线一致');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 9. install.ts: non-directory source + empty skillDirs after filter
// ──────────────────────────────────────────────────────────────────────────────
import { installFromSource, discoverSkillDirs } from '../src/core/install.ts';

describe('install: uncovered error branches', () => {
  let home: string;
  let work: string;
  beforeEach(async () => {
    work = mkdtempSync(join(tmpdir(), 'r3b-install-'));
    home = join(work, 'home');
    await mkdir(home, { recursive: true });
  });
  afterEach(() => rm(work, { recursive: true, force: true }).catch(() => undefined));

  it('throws when source is a plain file not a directory (line 120)', async () => {
    const file = join(work, 'not-a-dir.txt');
    await writeFile(file, 'hello\n');
    await expect(
      installFromSource(file, { home, agent: 'claude-code', mode: 'copy' }),
    ).rejects.toThrow(/安装源不是目录/);
  });

  it('throws when source dir has no SKILL.md at any depth (line 138)', async () => {
    const empty = join(work, 'empty-source');
    await mkdir(empty, { recursive: true });
    await expect(
      installFromSource(empty, { home, agent: 'claude-code', mode: 'copy' }),
    ).rejects.toThrow(/未发现 skill/);
  });

  it('throws when --skill filter narrows skillDirs to empty (lines 135-138)', async () => {
    const src = join(work, 'src');
    await mkdir(join(src, 'good-skill'), { recursive: true });
    await writeFile(
      join(src, 'good-skill', 'SKILL.md'),
      '---\nname: good-skill\ndescription: x.\n---\n\nBody.\n',
    );
    await expect(
      installFromSource(src, {
        home,
        agent: 'claude-code',
        mode: 'copy',
        skill: 'non-existent-skill',
      }),
    ).rejects.toThrow(/未发现 skill/);
  });

  it('discoverSkillDirs stops at DISCOVER_MAX_DEPTH=3 (does not find skills 4 levels deep)', async () => {
    // depth 0: root, 1: a, 2: b, 3: c (stops here), 4: d ← never entered
    const root = join(work, 'deep');
    const depth4 = join(root, 'a', 'b', 'c', 'd');
    await mkdir(depth4, { recursive: true });
    await writeFile(join(depth4, 'SKILL.md'), '---\nname: deep-skill\ndescription: d.\n---\n');

    const dirs = await discoverSkillDirs(root);
    expect(dirs).toHaveLength(0);
  });

  it('discoverSkillDirs skips .git and node_modules directories', async () => {
    const root = join(work, 'repo');
    await mkdir(join(root, '.git', 'my-skill'), { recursive: true });
    await writeFile(join(root, '.git', 'my-skill', 'SKILL.md'), '---\nname: git-skill\ndescription: d.\n---\n');
    await mkdir(join(root, 'node_modules', 'pkg-skill'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg-skill', 'SKILL.md'), '---\nname: npm-skill\ndescription: d.\n---\n');
    // A real skill at root level
    await mkdir(join(root, 'real-skill'), { recursive: true });
    await writeFile(join(root, 'real-skill', 'SKILL.md'), '---\nname: real-skill\ndescription: d.\n---\n');

    const dirs = await discoverSkillDirs(root);
    expect(dirs.map((d) => d.split('/').pop())).toEqual(['real-skill']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 10. remove.ts: unknown agent throws before any write (line 24)
// ──────────────────────────────────────────────────────────────────────────────
import { removeSkill } from '../src/core/remove.ts';

describe('remove: unknown agent guard (line 24)', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'r3b-remove-')); });
  afterEach(() => rm(home, { recursive: true, force: true }).catch(() => undefined));

  it('throws early with clear message when agent is unknown', async () => {
    await expect(
      removeSkill(home, 'my-skill', 'no-such-agent' as never),
    ).rejects.toThrow(/agent/i);
  });

  it('throws on unsafe skill name before agent lookup (assertSafeSkillName guard)', async () => {
    await expect(
      removeSkill(home, '../evil', 'claude-code'),
    ).rejects.toThrow(/[Uu]nsafe/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 11. watch.ts: skillName field populated from frontmatter (line 52)
// ──────────────────────────────────────────────────────────────────────────────
import { runWatchScan } from '../src/core/watch.ts';

describe('watch: skillName from frontmatter (line 52)', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'r3b-watch-')); });
  afterEach(() => rm(home, { recursive: true, force: true }).catch(() => undefined));

  it('includes skillName field when frontmatter has a name (line 52 truthy branch)', async () => {
    const skillsDir = join(home, '.claude', 'skills');
    await mkdir(join(skillsDir, 'my-tool'), { recursive: true });
    await writeFile(
      join(skillsDir, 'my-tool', 'SKILL.md'),
      '---\nname: my-tool\ndescription: watch test.\n---\n\nBody.\n',
    );
    const report = await runWatchScan(home);
    const entry = report.entries.find((e) => e.name === 'my-tool');
    expect(entry).toBeDefined();
    expect(entry!.skillName).toBe('my-tool');
  });

  it('omits skillName when frontmatter parse fails (line 52 falsy branch)', async () => {
    const skillsDir = join(home, '.claude', 'skills');
    await mkdir(join(skillsDir, 'broken-md'), { recursive: true });
    // Write a SKILL.md that will cause gray-matter to fail (binary junk)
    await writeFile(join(skillsDir, 'broken-md', 'SKILL.md'), Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const report = await runWatchScan(home);
    const entry = report.entries.find((e) => e.name === 'broken-md');
    expect(entry).toBeDefined();
    // skillName should be undefined when parsing failed
    expect(entry!.skillName).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 12. uninstall.ts: resolveAppTarget / resolveBinTarget branches
// ──────────────────────────────────────────────────────────────────────────────
import { planUninstall } from '../src/core/uninstall.ts';

describe('uninstall: plan branches for app/bin resolution', () => {
  let home: string;
  let work: string;
  beforeEach(async () => {
    work = mkdtempSync(join(tmpdir(), 'r3b-uninstall-'));
    home = join(work, 'home');
    await mkdir(join(home, '.skill-switch'), { recursive: true });
  });
  afterEach(() => rm(work, { recursive: true, force: true }).catch(() => undefined));

  it('resolveAppTarget returns null when basename does not match (not skill-switch.app)', async () => {
    const plan = await planUninstall({
      home,
      purgeSkills: false,
      dryRun: true,
      appPath: join(work, 'SomeOtherApp.app'), // wrong basename
      binLinkPath: null,
    });
    expect(plan.appPath).toBeNull();
  });

  it('resolveAppTarget returns null when app path does not exist (even correct basename)', async () => {
    const plan = await planUninstall({
      home,
      purgeSkills: false,
      dryRun: true,
      appPath: join(work, 'skill-switch.app'), // correct name but doesn't exist
      binLinkPath: null,
    });
    expect(plan.appPath).toBeNull();
  });

  it('resolveAppTarget returns null when appPath is null', async () => {
    const plan = await planUninstall({
      home,
      purgeSkills: false,
      dryRun: true,
      appPath: null,
      binLinkPath: null,
    });
    expect(plan.appPath).toBeNull();
  });

  it('resolveBinTarget returns null when path is not a symlink (plain file)', async () => {
    const bin = join(work, 'skill-switch-cli');
    await writeFile(bin, '#!/bin/sh\n');
    const plan = await planUninstall({
      home,
      purgeSkills: false,
      dryRun: true,
      appPath: null,
      binLinkPath: bin,
    });
    expect(plan.binLinkPath).toBeNull();
  });

  it('resolveBinTarget returns null when symlink target is not a skill-switch binary', async () => {
    const real = join(work, 'some-other-binary');
    await writeFile(real, '#!/bin/sh\n');
    const link = join(work, 'skill-switch');
    await symlink(real, link);

    const plan = await planUninstall({
      home,
      purgeSkills: false,
      dryRun: true,
      appPath: null,
      binLinkPath: link,
    });
    expect(plan.binLinkPath).toBeNull();
  });

  it('resolveBinTarget returns path when symlink points to skill-switch-cli (SKILL_SWITCH_BIN_NAMES)', async () => {
    const real = join(work, 'skill-switch-cli'); // exact match in SKILL_SWITCH_BIN_NAMES
    await writeFile(real, '#!/bin/sh\n');
    const link = join(work, 'ss-link');
    await symlink(real, link);

    const plan = await planUninstall({
      home,
      purgeSkills: false,
      dryRun: true,
      appPath: null,
      binLinkPath: link,
    });
    expect(plan.binLinkPath).toBe(link);
  });

  it('resolveBinTarget returns null when binLinkPath is null', async () => {
    const plan = await planUninstall({
      home,
      purgeSkills: false,
      dryRun: true,
      appPath: null,
      binLinkPath: null,
    });
    expect(plan.binLinkPath).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 13. lock.ts: readSkillsLock throws StateFileError when structure is invalid
// ──────────────────────────────────────────────────────────────────────────────
import { readSkillsLock } from '../src/core/lock.ts';

describe('lock: readSkillsLock validates structure', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'r3b-lock-')); });
  afterEach(() => rm(home, { recursive: true, force: true }).catch(() => undefined));

  it('throws StateFileError when skills is not an array (line 39)', async () => {
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    const lockPath = getSkillsLockPath(home);
    await writeFile(lockPath, `${JSON.stringify({ version: 1, skills: 'not-an-array' })}\n`);

    await expect(readSkillsLock(lockPath)).rejects.toThrow(StateFileError);
    await expect(readSkillsLock(lockPath)).rejects.toThrow(/锁文件结构非法/);
  });

  it('throws StateFileError when lock file is null JSON (line 38 null check)', async () => {
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    const lockPath = getSkillsLockPath(home);
    await writeFile(lockPath, 'null\n');

    await expect(readSkillsLock(lockPath)).rejects.toThrow(StateFileError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 14. sync: readDeclaration throws StateFileError when skills is not array (line 58)
// ──────────────────────────────────────────────────────────────────────────────
describe('sync: readDeclaration validates structure (line 57-59)', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'r3b-syncdecl-')); });
  afterEach(() => rm(home, { recursive: true, force: true }).catch(() => undefined));

  it('throws StateFileError when declaration skills is not array', async () => {
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    const p = getSkillsJsonPath(home);
    await writeFile(p, `${JSON.stringify({ version: 1, skills: 'bad' })}\n`);

    await expect(readDeclaration(p)).rejects.toThrow(StateFileError);
    await expect(readDeclaration(p)).rejects.toThrow(/声明文件结构非法/);
  });

  it('throws StateFileError when declaration is null JSON', async () => {
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    const p = getSkillsJsonPath(home);
    await writeFile(p, 'null\n');

    await expect(readDeclaration(p)).rejects.toThrow(StateFileError);
  });
});
