// R11-a: Property/fuzz tests for the CONFIG auditors.
// Seed namespace: 0x5eed_00c* (distinct from audit-fuzz 0x5eed_00a* and core-state-fuzz 0x5eed_00b*).
//
// Invariants under test:
//   1. auditSettingsJson(s) — never throws, always returns AuditFinding[]; each finding has valid shape.
//   2. auditMcpConfig(s)    — same invariants.
//   3. auditConfigFiles(home) — never throws on temp homes with random file contents.
//
// Both auditSettingsJson and auditMcpConfig are pure synchronous functions with no I/O,
// so fuzz iterations are very fast; numRuns kept at 150/100 for fast CI.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { auditConfigFiles } from '../src/core/audit/config-discovery.ts';
import { auditMcpConfig } from '../src/core/audit/mcp-audit.ts';
import { auditSettingsJson } from '../src/core/audit/settings-audit.ts';

// ── Fixed seeds + run counts ─────────────────────────────────────────────────
// auditors are pure/fast — 150/100 is still generous for never-throw coverage.
const FUZZ  = { seed: 0x5eed_00c0, numRuns: 150 };
const MED   = { seed: 0x5eed_00c1, numRuns: 100 };

// ── Temp-dir lifecycle (for auditConfigFiles tests) ──────────────────────────
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

/** Arbitrary strings: ASCII, unicode graphemes, binary bytes as utf-8, empty. */
const anyString = fc.oneof(
  fc.string({ unit: 'grapheme-ascii', maxLength: 2048 }),
  fc.constant(''),
  fc.string({ unit: 'grapheme', maxLength: 512 }),
  fc.uint8Array({ maxLength: 1024 }).map((b) => Buffer.from(b).toString('utf8')),
  // Literal edge cases that commonly trip parsers
  fc.constant('null'),
  fc.constant('true'),
  fc.constant('[]'),
  fc.constant('{}'),
  fc.constant('\0\0\0'),
);

/** Arbitrary JSON serialised from diverse value types (incl. deeply nested). */
const anyJsonString = fc
  .jsonValue({ depthSize: 'medium' })
  .map((v) => JSON.stringify(v));

/** Arbitrary deeply-nested object serialised to JSON. */
const deepJsonString = fc
  .object({ maxDepth: 6, maxKeys: 8 })
  .map((v) => JSON.stringify(v));

/**
 * JSON objects whose shape partially resembles a settings.json — diverse hook,
 * permission, and env-like keys mixed with random noise.
 */
const settingsLikeJson = fc.oneof(
  // Well-formed but empty
  fc.constant('{}'),
  // hooks with varying shapes
  fc.record({
    hooks: fc.record({
      PostToolUse: fc.array(
        fc.record({
          command: fc.string({ unit: 'grapheme-ascii', maxLength: 256 }),
        }),
        { maxLength: 4 },
      ),
    }),
  }).map((v) => JSON.stringify(v)),
  // permissions section
  fc.record({
    permissions: fc.record({
      allow: fc.array(fc.string({ unit: 'grapheme-ascii', maxLength: 64 }), { maxLength: 6 }),
      deny: fc.array(fc.string({ unit: 'grapheme-ascii', maxLength: 64 }), { maxLength: 4 }),
    }),
  }).map((v) => JSON.stringify(v)),
  // auto-approve style keys
  fc.record({
    dangerouslySkipPermissions: fc.boolean(),
    autoApprove: fc.boolean(),
    confirmations: fc.oneof(
      fc.string({ unit: 'grapheme-ascii', maxLength: 32 }),
      fc.boolean(),
    ),
  }).map((v) => JSON.stringify(v)),
  // env-like nested objects with secret-looking keys
  fc.record({
    env: fc.record({
      OPENAI_API_KEY: fc.string({ unit: 'grapheme-ascii', maxLength: 80 }),
      GITHUB_TOKEN: fc.string({ unit: 'grapheme-ascii', maxLength: 80 }),
    }),
  }).map((v) => JSON.stringify(v)),
);

/**
 * JSON objects whose shape partially resembles an MCP config — random server
 * entries with varying command/args/env shapes.
 */
const mcpLikeJson = fc.oneof(
  fc.constant('{}'),
  fc.constant('{"mcpServers":{}}'),
  // Valid-ish mcpServers with one entry
  fc.record({
    mcpServers: fc.record({
      myServer: fc.record({
        command: fc.string({ unit: 'grapheme-ascii', maxLength: 128 }),
        args: fc.array(fc.string({ unit: 'grapheme-ascii', maxLength: 64 }), { maxLength: 6 }),
        env: fc.record({
          MY_TOKEN: fc.string({ unit: 'grapheme-ascii', maxLength: 80 }),
        }),
      }),
    }),
  }).map((v) => JSON.stringify(v)),
  // Multiple servers with random names (may include tricky chars)
  fc.dictionary(
    fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 32 }),
    fc.record({
      command: fc.string({ unit: 'grapheme-ascii', maxLength: 128 }),
    }),
    { maxKeys: 5 },
  ).map((servers) => JSON.stringify({ mcpServers: servers })),
);

// ── AuditFinding shape checker ───────────────────────────────────────────────

function assertFindingShape(f: unknown, label: string): void {
  expect(f, `${label}: finding is defined`).toBeDefined();
  expect(typeof (f as { ruleId?: unknown }).ruleId, `${label}.ruleId`).toBe('string');
  expect(typeof (f as { severity?: unknown }).severity, `${label}.severity`).toBe('string');
  expect(['critical', 'high', 'medium', 'low']).toContain((f as { severity?: string }).severity);
  expect(typeof (f as { file?: unknown }).file, `${label}.file`).toBe('string');
  expect(typeof (f as { line?: unknown }).line, `${label}.line`).toBe('number');
  expect(typeof (f as { message?: unknown }).message, `${label}.message`).toBe('string');
  expect(typeof (f as { excerpt?: unknown }).excerpt, `${label}.excerpt`).toBe('string');
  // excerpt must respect the 200-char cap (+ optional 1-char ellipsis '…')
  expect((f as { excerpt: string }).excerpt.length, `${label}.excerpt.length`).toBeLessThanOrEqual(201);
}

function assertAllFindingShapes(findings: unknown[], labelPrefix: string): void {
  for (let i = 0; i < findings.length; i++) {
    assertFindingShape(findings[i], `${labelPrefix}[${i}]`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// auditSettingsJson
// ══════════════════════════════════════════════════════════════════════════════

describe('auditSettingsJson — property/fuzz tests', () => {
  it('never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(anyString, (s) => {
        const result = auditSettingsJson(s);
        expect(Array.isArray(result)).toBe(true);
      }),
      FUZZ,
    );
  });

  it('never throws on arbitrary JSON (serialised from random values)', () => {
    fc.assert(
      fc.property(anyJsonString, (s) => {
        const result = auditSettingsJson(s);
        expect(Array.isArray(result)).toBe(true);
      }),
      FUZZ,
    );
  });

  it('never throws on deeply-nested random objects', () => {
    fc.assert(
      fc.property(deepJsonString, (s) => {
        const result = auditSettingsJson(s);
        expect(Array.isArray(result)).toBe(true);
      }),
      MED,
    );
  });

  it('never throws on settings-shaped JSON (hooks / permissions / auto-approve / env keys)', () => {
    fc.assert(
      fc.property(settingsLikeJson, (s) => {
        const result = auditSettingsJson(s);
        expect(Array.isArray(result)).toBe(true);
      }),
      FUZZ,
    );
  });

  it('every returned finding has a valid shape', () => {
    fc.assert(
      fc.property(anyString, (s) => {
        const findings = auditSettingsJson(s);
        assertAllFindingShapes(findings, 'finding');
      }),
      FUZZ,
    );
  });

  it('every finding from settings-shaped input has a valid shape', () => {
    fc.assert(
      fc.property(settingsLikeJson, (s) => {
        const findings = auditSettingsJson(s);
        assertAllFindingShapes(findings, 'settings-shaped');
      }),
      FUZZ,
    );
  });

  it('completes each run well under a second (time-bound)', () => {
    fc.assert(
      fc.property(anyString, (s) => {
        const t0 = performance.now();
        auditSettingsJson(s);
        expect(performance.now() - t0).toBeLessThan(500);
      }),
      FUZZ,
    );
  });

  it('handles empty string without throwing — returns unparseable finding', () => {
    const result = auditSettingsJson('');
    expect(Array.isArray(result)).toBe(true);
  });

  it('handles a clean config — returns empty findings', () => {
    const result = auditSettingsJson('{"version": 1, "theme": "dark"}');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// auditMcpConfig
// ══════════════════════════════════════════════════════════════════════════════

describe('auditMcpConfig — property/fuzz tests', () => {
  it('never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(anyString, (s) => {
        const result = auditMcpConfig(s);
        expect(Array.isArray(result)).toBe(true);
      }),
      FUZZ,
    );
  });

  it('never throws on arbitrary JSON (serialised from random values)', () => {
    fc.assert(
      fc.property(anyJsonString, (s) => {
        const result = auditMcpConfig(s);
        expect(Array.isArray(result)).toBe(true);
      }),
      FUZZ,
    );
  });

  it('never throws on deeply-nested random objects', () => {
    fc.assert(
      fc.property(deepJsonString, (s) => {
        const result = auditMcpConfig(s);
        expect(Array.isArray(result)).toBe(true);
      }),
      MED,
    );
  });

  it('never throws on MCP-shaped JSON (mcpServers with random entries)', () => {
    fc.assert(
      fc.property(mcpLikeJson, (s) => {
        const result = auditMcpConfig(s);
        expect(Array.isArray(result)).toBe(true);
      }),
      FUZZ,
    );
  });

  it('every returned finding has a valid shape', () => {
    fc.assert(
      fc.property(anyString, (s) => {
        const findings = auditMcpConfig(s);
        assertAllFindingShapes(findings, 'finding');
      }),
      FUZZ,
    );
  });

  it('every finding from MCP-shaped input has a valid shape', () => {
    fc.assert(
      fc.property(mcpLikeJson, (s) => {
        const findings = auditMcpConfig(s);
        assertAllFindingShapes(findings, 'mcp-shaped');
      }),
      FUZZ,
    );
  });

  it('completes each run well under a second (time-bound)', () => {
    fc.assert(
      fc.property(anyString, (s) => {
        const t0 = performance.now();
        auditMcpConfig(s);
        expect(performance.now() - t0).toBeLessThan(500);
      }),
      FUZZ,
    );
  });

  it('handles empty string without throwing — returns invalid-json finding', () => {
    const result = auditMcpConfig('');
    expect(Array.isArray(result)).toBe(true);
  });

  it('handles a clean config — returns empty findings', () => {
    const result = auditMcpConfig('{"mcpServers":{}}');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  // Extra: stress the server-name / metadata fields with unicode adversarial strings.
  it('never throws on MCP configs with unicode server names and descriptions', () => {
    const unicodeMcpString = fc
      .string({ unit: 'grapheme', maxLength: 128 })
      .map((name) =>
        JSON.stringify({
          mcpServers: {
            [name]: {
              command: 'node',
              args: ['index.js'],
              description: name, // same random unicode for description
            },
          },
        }),
      );

    fc.assert(
      fc.property(unicodeMcpString, (s) => {
        const result = auditMcpConfig(s);
        expect(Array.isArray(result)).toBe(true);
      }),
      MED,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// auditConfigFiles — async, does I/O; keep numRuns modest
// ══════════════════════════════════════════════════════════════════════════════

describe('auditConfigFiles — property/fuzz tests (temp homes with random file content)', () => {
  /**
   * Write some of the known config files under a temp home dir, then call
   * auditConfigFiles and verify it never throws and always returns a well-shaped result.
   */
  it('never throws on a temp home with random settings.json content', async () => {
    await fc.assert(
      fc.asyncProperty(anyString, async (content) => {
        const home = makeTempDir('ss-caf-settings-');
        await mkdir(join(home, '.claude'), { recursive: true });
        await writeFile(join(home, '.claude', 'settings.json'), content, 'utf8');

        const results = await auditConfigFiles(home);
        // Must return an array and never throw
        expect(Array.isArray(results)).toBe(true);
        for (const r of results) {
          expect(typeof r.absPath).toBe('string');
          expect(typeof r.relPath).toBe('string');
          expect(Array.isArray(r.findings)).toBe(true);
          assertAllFindingShapes(r.findings, 'caf-settings');
        }
      }),
      { seed: 0x5eed_00c2, numRuns: 60 },
    );
  });

  it('never throws on a temp home with random mcp.json content', async () => {
    await fc.assert(
      fc.asyncProperty(anyString, async (content) => {
        const home = makeTempDir('ss-caf-mcp-');
        await mkdir(join(home, '.claude'), { recursive: true });
        await writeFile(join(home, '.claude', 'mcp.json'), content, 'utf8');

        const results = await auditConfigFiles(home);
        expect(Array.isArray(results)).toBe(true);
        for (const r of results) {
          expect(Array.isArray(r.findings)).toBe(true);
          assertAllFindingShapes(r.findings, 'caf-mcp');
        }
      }),
      { seed: 0x5eed_00c3, numRuns: 60 },
    );
  });

  it('never throws on a temp home with multiple random config files', async () => {
    // Write all four known configs simultaneously with random content.
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(anyString, anyString, anyString, anyString),
        async ([s1, s2, s3, s4]) => {
          const home = makeTempDir('ss-caf-multi-');
          await mkdir(join(home, '.claude'), { recursive: true });
          await Promise.all([
            writeFile(join(home, '.claude', 'settings.json'), s1, 'utf8'),
            writeFile(join(home, '.claude', 'settings.local.json'), s2, 'utf8'),
            writeFile(join(home, '.claude', 'claude_desktop_config.json'), s3, 'utf8'),
            writeFile(join(home, '.claude', 'mcp.json'), s4, 'utf8'),
          ]);

          const results = await auditConfigFiles(home);
          expect(Array.isArray(results)).toBe(true);
          // At most 4 results (one per known config file)
          expect(results.length).toBeLessThanOrEqual(4);
          for (const r of results) {
            expect(typeof r.absPath).toBe('string');
            expect(typeof r.relPath).toBe('string');
            expect(Array.isArray(r.findings)).toBe(true);
            assertAllFindingShapes(r.findings, 'caf-multi');
          }
        },
      ),
      { seed: 0x5eed_00c4, numRuns: 40 },
    );
  });

  it('returns empty results on a home dir with no config files', async () => {
    const home = makeTempDir('ss-caf-empty-');
    const results = await auditConfigFiles(home);
    expect(results).toHaveLength(0);
  });

  it('silently skips a non-existent home directory (no throw)', async () => {
    const home = join(tmpdir(), `ss-caf-nonexistent-${Date.now()}`);
    const results = await auditConfigFiles(home);
    expect(results).toHaveLength(0);
  });

  it('every finding from real-config-shaped files has a valid finding shape', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(settingsLikeJson, anyJsonString),
        async (content) => {
          const home = makeTempDir('ss-caf-shaped-');
          await mkdir(join(home, '.claude'), { recursive: true });
          await writeFile(join(home, '.claude', 'settings.json'), content, 'utf8');

          const results = await auditConfigFiles(home);
          for (const r of results) {
            assertAllFindingShapes(r.findings, 'shaped');
          }
        },
      ),
      { seed: 0x5eed_00c5, numRuns: 50 },
    );
  });
});
