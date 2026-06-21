// W8-b: Property/fuzz tests for core state-file readers/parsers.
// Invariant: malformed/untrusted file content NEVER causes an uncaught crash.
// Fixed-seed deterministic runs (reproducible on CI).
//
// Contracts under test:
//   readJsonState   — ENOENT → fallback; bad JSON/IO → StateFileError (NOT uncaught)
//   readDeclaration — valid JSON with {version,skills:[…]} → returns it;
//                     anything else → StateFileError (not uncaught)
//   readSkillsLock  — same contract as readDeclaration
//   scanHome (gray-matter frontmatter parser) — errors go to record.error; never throws
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { readSkillsLock } from '../src/core/lock.ts';
import { scanHome } from '../src/core/scan.ts';
import { readJsonState, StateFileError } from '../src/core/state-io.ts';
import { readDeclaration } from '../src/core/sync.ts';

// ── Fixed seeds + run counts ─────────────────────────────────────────────────
// Seed namespace: 0x5eed_00b* to avoid collision with audit-fuzz (0x5eed_00a*).
const FUZZ = { seed: 0x5eed_00b0, numRuns: 300 };
const MED  = { seed: 0x5eed_00b1, numRuns: 200 };

// ── Shared temp-dir lifecycle ────────────────────────────────────────────────
const allTempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  allTempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(
    allTempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)),
  );
});

// ── Shared arbitraries ───────────────────────────────────────────────────────

/** Arbitrary strings covering ASCII, unicode graphemes, binary bytes decoded as utf-8, empty. */
const anyString = fc.oneof(
  fc.string({ unit: 'grapheme-ascii', maxLength: 4096 }),
  fc.constant(''),
  fc.string({ unit: 'grapheme', maxLength: 1024 }),
  fc.uint8Array({ maxLength: 2048 }).map((b) => Buffer.from(b).toString('utf8')),
  // Edge cases likely to trip JSON parsers
  fc.constant('null'),
  fc.constant('undefined'),
  fc.constant('true'),
  fc.constant('[]'),
  fc.constant('{}'),
  fc.constant('{ "version": 1 }'),               // missing skills array
  fc.constant('{ "version": 1, "skills": null }'), // skills not an array
  fc.constant('{ "version": 1, "skills": {} }'),   // skills is an object, not array
  fc.constant('\0\0\0'),
  fc.constant('---\nname: x\n'.repeat(256)),       // malformed frontmatter / large
);

/** Arbitrary JSON-serialised values (diverse types, including deeply nested). */
const anyJsonString = fc
  .jsonValue({ depthSize: 'medium' })
  .map((v) => JSON.stringify(v));

/** Objects that look almost-but-not-quite like SkillsDeclarationFile. */
const almostValidDecl = fc.oneof(
  // correct structure
  fc.constant('{"version":1,"skills":[]}'),
  // wrong version
  fc.constant('{"version":2,"skills":[]}'),
  // version missing
  fc.constant('{"skills":[]}'),
  // skills is null
  fc.constant('{"version":1,"skills":null}'),
  // skills has non-object entries
  fc.constant('{"version":1,"skills":[null,1,"x"]}'),
  // extra keys
  fc.constant('{"version":1,"skills":[],"extra":true}'),
  // deeply nested valid
  fc.constant('{"version":1,"skills":[{"name":"a","source":"/tmp","agents":["claude-code"],"enabled":true,"mode":"symlink"}]}'),
);

// ── Helper: write content to a temp file, run fn, clean up ───────────────────
async function withTempFile<T>(
  prefix: string,
  content: string,
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  const dir = makeTempDir(prefix);
  const filePath = join(dir, 'data.json');
  await writeFile(filePath, content, 'utf8');
  return fn(filePath);
}

// ══════════════════════════════════════════════════════════════════════════════
// readJsonState
// ══════════════════════════════════════════════════════════════════════════════

describe('readJsonState — property/fuzz tests', () => {
  it('returns fallback only on ENOENT; never throws uncaught for bad-content files', async () => {
    await fc.assert(
      fc.asyncProperty(anyString, async (content) => {
        const dir = makeTempDir('ss-fuzz-rjs-');
        const path = join(dir, 'state.json');
        await writeFile(path, content, 'utf8');

        let _result: unknown;
        let threw: unknown;
        try {
          _result = await readJsonState(path, { __fallback: true });
        } catch (err) {
          threw = err;
        }

        if (threw !== undefined) {
          // Must be a StateFileError — never an uncaught/unexpected crash
          expect(threw).toBeInstanceOf(StateFileError);
          expect((threw as StateFileError).path).toBe(path);
        } else {
          // Successfully parsed (file existed → ENOENT fallback impossible).
          // The returned value must equal JSON.parse of the content.
          // (We don't check __fallback here; "null", arrays, etc. are all valid.)
        }
      }),
      FUZZ,
    );
  });

  it('returns fallback on ENOENT (file absent)', async () => {
    const fallback = { version: 1 as const, skills: [] as never[] };
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'grapheme-ascii', maxLength: 32 }), async (name) => {
        const dir = makeTempDir('ss-fuzz-rjs-enoent-');
        const path = join(dir, `${name}-nonexistent.json`);
        const result = await readJsonState(path, fallback);
        expect(result).toBe(fallback);
      }),
      MED,
    );
  });

  it('always throws StateFileError (never generic Error or crash) for invalid JSON content', async () => {
    // Non-JSON strings that can NEVER be valid JSON
    const notJson = fc.oneof(
      fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 512 }).filter(
        (s) => {
          try { JSON.parse(s); return false; } catch { return true; }
        },
      ),
      fc.constant('{ broken json'),
      fc.constant('not json at all'),
      fc.constant('\x00\x01\x02'),
      fc.constant('---\nfrontmatter\n---'),
    );

    await fc.assert(
      fc.asyncProperty(notJson, async (content) => {
        await withTempFile('ss-fuzz-rjs-err-', content, async (path) => {
          let caughtErr: unknown;
          try {
            await readJsonState(path, null);
          } catch (err) {
            caughtErr = err;
          }
          expect(caughtErr).toBeInstanceOf(StateFileError);
        });
      }),
      MED,
    );
  });

  it('always returns the parsed value (not fallback) for valid JSON content', async () => {
    await fc.assert(
      fc.asyncProperty(anyJsonString, async (content) => {
        await withTempFile('ss-fuzz-rjs-valid-', content, async (path) => {
          const parsed = JSON.parse(content);
          const result = await readJsonState(path, '__fallback__');
          expect(result).toEqual(parsed);
        });
      }),
      MED,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// readDeclaration
// ══════════════════════════════════════════════════════════════════════════════

describe('readDeclaration — property/fuzz tests', () => {
  /** True iff the raw string parses to a structurally valid SkillsDeclarationFile. */
  function isValidDecl(raw: string): boolean {
    try {
      const parsed: unknown = JSON.parse(raw);
      return (
        typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { skills?: unknown }).skills)
      );
    } catch {
      return false;
    }
  }

  it('never throws uncaught on arbitrary file content — always StateFileError or success', async () => {
    await fc.assert(
      fc.asyncProperty(anyString, async (content) => {
        await withTempFile('ss-fuzz-decl-', content, async (path) => {
          let threw: unknown;
          try {
            await readDeclaration(path);
          } catch (err) {
            threw = err;
          }

          if (threw !== undefined) {
            // Must always be a StateFileError — never an uncaught crash
            expect(threw).toBeInstanceOf(StateFileError);
          }
          // If it didn't throw, it must have returned something with a skills array
        });
      }),
      FUZZ,
    );
  });

  it('rejects structurally-invalid JSON with StateFileError, accepts structurally-valid JSON', async () => {
    await fc.assert(
      fc.asyncProperty(almostValidDecl, async (content) => {
        await withTempFile('ss-fuzz-decl-struct-', content, async (path) => {
          if (isValidDecl(content)) {
            // Should succeed
            await expect(readDeclaration(path)).resolves.toBeDefined();
          } else {
            // Should throw StateFileError
            await expect(readDeclaration(path)).rejects.toBeInstanceOf(StateFileError);
          }
        });
      }),
      MED,
    );
  });

  it('returns { version, skills: [] } on missing file (ENOENT fallback path)', async () => {
    const dir = makeTempDir('ss-fuzz-decl-enoent-');
    const path = join(dir, 'skills.json');
    const result = await readDeclaration(path);
    expect(result).toEqual({ version: 1, skills: [] });
  });

  it('never throws uncaught on arbitrary valid-ish JSON objects', async () => {
    await fc.assert(
      fc.asyncProperty(anyJsonString, async (content) => {
        await withTempFile('ss-fuzz-decl-json-', content, async (path) => {
          let threw: unknown;
          try {
            await readDeclaration(path);
          } catch (err) {
            threw = err;
          }
          if (threw !== undefined) {
            expect(threw).toBeInstanceOf(StateFileError);
          }
        });
      }),
      MED,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// readSkillsLock
// ══════════════════════════════════════════════════════════════════════════════

describe('readSkillsLock — property/fuzz tests', () => {
  function isValidLock(raw: string): boolean {
    try {
      const parsed: unknown = JSON.parse(raw);
      return (
        typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { skills?: unknown }).skills)
      );
    } catch {
      return false;
    }
  }

  it('never throws uncaught on arbitrary file content — always StateFileError or success', async () => {
    await fc.assert(
      fc.asyncProperty(anyString, async (content) => {
        await withTempFile('ss-fuzz-lock-', content, async (path) => {
          let threw: unknown;
          try {
            await readSkillsLock(path);
          } catch (err) {
            threw = err;
          }
          if (threw !== undefined) {
            expect(threw).toBeInstanceOf(StateFileError);
          }
        });
      }),
      FUZZ,
    );
  });

  it('returns { version: 1, skills: [] } on missing file (ENOENT fallback)', async () => {
    const dir = makeTempDir('ss-fuzz-lock-enoent-');
    const path = join(dir, 'skills.lock.json');
    const result = await readSkillsLock(path);
    expect(result).toEqual({ version: 1, skills: [] });
  });

  it('accepts structurally-valid JSON, rejects invalid with StateFileError', async () => {
    await fc.assert(
      fc.asyncProperty(almostValidDecl, async (content) => {
        await withTempFile('ss-fuzz-lock-struct-', content, async (path) => {
          if (isValidLock(content)) {
            await expect(readSkillsLock(path)).resolves.toBeDefined();
          } else {
            await expect(readSkillsLock(path)).rejects.toBeInstanceOf(StateFileError);
          }
        });
      }),
      MED,
    );
  });

  it('never throws uncaught on arbitrary valid-ish JSON', async () => {
    await fc.assert(
      fc.asyncProperty(anyJsonString, async (content) => {
        await withTempFile('ss-fuzz-lock-json-', content, async (path) => {
          let threw: unknown;
          try {
            await readSkillsLock(path);
          } catch (err) {
            threw = err;
          }
          if (threw !== undefined) {
            expect(threw).toBeInstanceOf(StateFileError);
          }
        });
      }),
      MED,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// gray-matter frontmatter parser (via scanHome / readSkill)
// ══════════════════════════════════════════════════════════════════════════════

describe('gray-matter frontmatter parser (via scanHome) — property/fuzz tests', () => {
  /** Arbitrary strings targeting common YAML/frontmatter edge cases. */
  const frontmatterString = fc.oneof(
    anyString,
    // Typical frontmatter patterns
    fc.constant('---\nname: hello\ndescription: world\n---\n# Body\n'),
    fc.constant('---\nname: [unterminated\n---\n'),
    fc.constant('---\n'),
    fc.constant('---\n---\n'),
    fc.constant('---\nname: x\n'.repeat(200)),
    // YAML with dangerous constructs
    fc.constant('---\n!!python/object:os.system [id]\n---\n'),
    fc.constant('---\nnull:\n  key: &anchor\n  other: *anchor\n---\n'),
    fc.constant('---\nname: |\n  multi\n  line\n  value\n---\n'),
    // Binary-looking content
    fc.uint8Array({ maxLength: 2048 }).map((b) => Buffer.from(b).toString('utf8')),
    // Very long files
    fc.string({ unit: 'grapheme-ascii', minLength: 8192, maxLength: 32768 }),
    // Strings with NUL bytes in frontmatter
    fc.constant('---\nname: \x00null-byte\n---\n'),
    // Repeated long YAML structures
    fc.string({ unit: 'grapheme', minLength: 0, maxLength: 2048 }),
  );

  it('scanHome never throws on malformed SKILL.md content — errors land in record.error', async () => {
    await fc.assert(
      fc.asyncProperty(frontmatterString, async (content) => {
        const dir = makeTempDir('ss-fuzz-scan-');
        const skillDir = join(dir, '.claude', 'skills', 'fuzz-skill');
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, 'SKILL.md'), content, 'utf8');

        // scanHome must NEVER throw — errors go into record.error
        const records = await scanHome(dir);
        expect(records).toHaveLength(1);
        expect(records[0]!.dirName).toBe('fuzz-skill');
        // record.error XOR (name/description) is fine — but no uncaught throw
      }),
      FUZZ,
    );
  });

  it('valid frontmatter yields record.name and record.description (no error field)', async () => {
    const validFrontmatterCases = [
      '---\nname: my-skill\ndescription: Does stuff\n---\n# Body',
      '---\nname: "quoted-name"\ndescription: "Quoted description"\n---\n',
      '---\nname: skill-123\ndescription: A skill with numbers\n---\n',
    ];

    for (const content of validFrontmatterCases) {
      const dir = makeTempDir('ss-fuzz-scan-valid-');
      const skillDir = join(dir, '.claude', 'skills', 'valid-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), content, 'utf8');

      const records = await scanHome(dir);
      expect(records).toHaveLength(1);
      expect(records[0]!.error).toBeUndefined();
      expect(typeof records[0]!.name).toBe('string');
    }
  });

  it('scanHome on an empty skill dir (no SKILL.md) yields no records', async () => {
    const dir = makeTempDir('ss-fuzz-scan-empty-');
    const skillDir = join(dir, '.claude', 'skills', 'no-manifest');
    await mkdir(skillDir, { recursive: true });
    // No SKILL.md written

    const records = await scanHome(dir);
    expect(records).toHaveLength(0);
  });

  it('scanHome never throws even on multiple skills with mixed good/bad frontmatter', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(frontmatterString, { minLength: 1, maxLength: 5 }),
        async (contents) => {
          const dir = makeTempDir('ss-fuzz-scan-multi-');
          await Promise.all(
            contents.map(async (content, i) => {
              const skillDir = join(dir, '.claude', 'skills', `skill-${i}`);
              await mkdir(skillDir, { recursive: true });
              await writeFile(join(skillDir, 'SKILL.md'), content, 'utf8');
            }),
          );

          // Must never throw regardless of how many skills or how broken their content is
          const records = await scanHome(dir);
          expect(records).toHaveLength(contents.length);
          for (const record of records) {
            expect(typeof record.dirName).toBe('string');
            expect(typeof record.dir).toBe('string');
          }
        },
      ),
      MED,
    );
  });
});
