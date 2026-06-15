// A1: parser hardening. Fixed-seed property tests keep fuzz coverage reproducible.
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { listSnapshots } from '../src/core/backup.ts';
import { validateMetadata } from '../src/core/lint/spec-validator.ts';
import { readSkillsLock } from '../src/core/lock.ts';
import { scanHome } from '../src/core/scan.ts';
import { readDeclaration } from '../src/core/sync.ts';
import { parseSkillInvocations } from '../src/core/transcripts.ts';
import { parseSource } from '../src/vendor/vercel-skills/source-parser.ts';

const FUZZ = { seed: 0x5eed_0001, numRuns: 80 };

const rawText = fc.oneof(
  fc.string({ maxLength: 4096 }),
  fc.uint8Array({ maxLength: 4096 }).map((bytes) => Buffer.from(bytes).toString('utf8')),
  fc.constant('---\nname: [unterminated\n---\nbody'),
  fc.constant('\0\0\0---\nname: bad\ndescription: bad\n---\n'),
  fc.constant('---\nname: x\n'.repeat(512)),
);

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('A1 adversarial parser inputs', () => {
  it('scan frontmatter parsing never throws on malformed skill files', async () => {
    await fc.assert(
      fc.asyncProperty(rawText, async (raw) => {
        await withTempDir('skill-switch-a1-scan-', async (home) => {
          const skillDir = join(home, '.claude', 'skills', 'fuzz-skill');
          await mkdir(skillDir, { recursive: true });
          await writeFile(join(skillDir, 'SKILL.md'), raw);

          const records = await scanHome(home);
          expect(records).toHaveLength(1);
          expect(records[0]!.dirName).toBe('fuzz-skill');
        });
      }),
      FUZZ,
    );
  });

  it('transcript JSONL parsing skips malformed lines without throwing', () => {
    fc.assert(
      fc.property(rawText, (jsonl) => {
        expect(() => parseSkillInvocations(jsonl, 'fuzz.jsonl')).not.toThrow();
      }),
      FUZZ,
    );
  });

  it('metadata validation reports errors instead of throwing for arbitrary values', () => {
    fc.assert(
      fc.property(fc.anything({ maxDepth: 3, withObjectString: true }), (metadata) => {
        expect(() => validateMetadata(metadata, 'fuzz-skill')).not.toThrow();
      }),
      FUZZ,
    );
  });

  it('declaration and lock JSON readers reject malformed files instead of silently downgrading to empty', async () => {
    // M0-5.1:一个存在但损坏的状态文件绝不能被当成"空声明/空锁"——否则后续写入会把它永久覆盖丢失。
    // 要么按内容解析成功(内容本就是合法的 { version, skills:[] }),要么抛错;绝不无中生有出空状态。
    const isValidState = (raw: string): boolean => {
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
    };
    await fc.assert(
      fc.asyncProperty(rawText, rawText, async (declRaw, lockRaw) => {
        await withTempDir('skill-switch-a1-json-', async (home) => {
          const root = join(home, '.skill-switch');
          await mkdir(root, { recursive: true });
          const declPath = join(root, 'skills.json');
          const lockPath = join(root, 'skills.lock.json');
          await writeFile(declPath, declRaw);
          await writeFile(lockPath, lockRaw);

          if (isValidState(declRaw)) await expect(readDeclaration(declPath)).resolves.toEqual(JSON.parse(declRaw));
          else await expect(readDeclaration(declPath)).rejects.toBeTruthy();

          if (isValidState(lockRaw)) await expect(readSkillsLock(lockPath)).resolves.toEqual(JSON.parse(lockRaw));
          else await expect(readSkillsLock(lockPath)).rejects.toBeTruthy();
        });
      }),
      FUZZ,
    );
  });

  it('snapshot manifest parsing tolerates malformed sidecars', async () => {
    await fc.assert(
      fc.asyncProperty(rawText, async (manifestRaw) => {
        await withTempDir('skill-switch-a1-manifest-', async (store) => {
          const snap = join(store, '1781310000000__fuzz.tar.gz');
          await writeFile(snap, 'not a real tarball');
          await writeFile(`${snap}.json`, manifestRaw);

          const snapshots = await listSnapshots(store);
          expect(snapshots).toHaveLength(1);
          expect(snapshots[0]!.label).toBe('fuzz');
        });
      }),
      FUZZ,
    );
  });

  it('source parsing never throws on malformed or adversarial source strings', () => {
    const sourceText = fc.oneof(
      rawText,
      fc.constant('owner/repo/../../escape'),
      fc.constant('https://github.com/owner/repo/tree/main/../../escape'),
      fc.constant('https://gitlab.com/group/repo/-/tree/main/../../escape'),
      fc.constant('gitlab:group/repo#main@../../escape'),
    );

    fc.assert(
      fc.property(sourceText, (source) => {
        expect(() => parseSource(source)).not.toThrow();
        expect(parseSource(source).type).toMatch(/^(github|gitlab|git|local|well-known)$/);
      }),
      FUZZ,
    );
  });
});
