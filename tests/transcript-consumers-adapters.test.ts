import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { analyzeCooccurrence } from '../src/core/packs/cooccurrence.ts';
import { buildStats } from '../src/core/stats.ts';
import { getStatsCachePath } from '../src/core/stats-cache.ts';

function claudeInvocation(skill: string, timestamp?: string, args?: string): string {
  return JSON.stringify({
    ...(timestamp === undefined ? {} : { timestamp }),
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Skill',
          input: { skill, ...(args === undefined ? {} : { args }) },
        },
      ],
    },
  });
}

function codexInvocation(skill: string, timestamp?: string, cmd?: string): string {
  return JSON.stringify({
    ...(timestamp === undefined ? {} : { timestamp }),
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: skill,
      arguments: JSON.stringify(cmd === undefined ? {} : { cmd }),
      call_id: `call-${skill}`,
    },
  });
}

async function writeClaudeSession(home: string, name: string, lines: string[]): Promise<void> {
  const directory = join(home, '.claude', 'projects', 'project');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), `${lines.join('\n')}\n`);
}

async function writeCodexSession(home: string, name: string, lines: string[]): Promise<void> {
  const directory = join(home, '.codex', 'sessions', '2026', '07', '11');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), `${lines.join('\n')}\n`);
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-transcript-consumers-'));
});

describe('stats multi-adapter pipeline', () => {
  it('counts Claude and Codex invocations and keeps the v2 cache free of raw args', async () => {
    const now = new Date().toISOString();
    const secret = 'TRANSCRIPT_ADAPTER_SECRET';
    await writeClaudeSession(home, 'claude.jsonl', [
      claudeInvocation('shared', now),
      claudeInvocation('claude-only', now, `--token ${secret}`),
    ]);
    await writeCodexSession(home, 'codex.jsonl', [
      codexInvocation('shared', now),
      codexInvocation('codex-only', now, `--api-key ${secret}`),
    ]);

    const first = await buildStats(home, undefined, {});
    expect(first.scannedFiles).toBe(2);
    expect(first.cacheMisses).toBe(2);
    expect(first.invocations).toBe(4);
    expect(first.usage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skill: 'shared', count: 2 }),
        expect.objectContaining({ skill: 'claude-only', count: 1 }),
        expect.objectContaining({ skill: 'codex-only', count: 1 }),
      ]),
    );

    const serializedCache = await readFile(getStatsCachePath(home), 'utf8');
    expect(serializedCache).not.toContain(secret);
    expect(serializedCache).not.toContain('"args"');
    expect(serializedCache).not.toContain('"sessionFile"');

    const second = await buildStats(home, undefined, {});
    expect(second.cacheHits).toBe(2);
    expect(second.cacheMisses).toBe(0);
    expect(second.usage).toEqual(first.usage);
  });

  it('applies the same days semantics to both adapters', async () => {
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await writeClaudeSession(home, 'claude.jsonl', [
      claudeInvocation('claude-recent', recent),
      claudeInvocation('claude-old', old),
      claudeInvocation('claude-no-timestamp'),
    ]);
    await writeCodexSession(home, 'codex.jsonl', [
      codexInvocation('codex-recent', recent),
      codexInvocation('codex-old', old),
      codexInvocation('codex-no-timestamp'),
    ]);

    const report = await buildStats(home, 7, {}, { cacheMode: 'disabled' });
    expect(report.usage.map((entry) => entry.skill).sort()).toEqual([
      'claude-recent',
      'codex-recent',
    ]);
    expect(report.invocations).toBe(2);
  });
});

describe('cooccurrence multi-adapter pipeline', () => {
  it('treats Claude and Codex files as sessions while preserving per-session deduplication', async () => {
    const now = new Date().toISOString();
    await writeClaudeSession(home, 'claude.jsonl', [
      claudeInvocation('alpha', now),
      claudeInvocation('alpha', now),
      claudeInvocation('beta', now),
    ]);
    await writeCodexSession(home, 'codex.jsonl', [
      codexInvocation('alpha', now),
      codexInvocation('beta', now),
      codexInvocation('beta', now),
    ]);

    const report = await analyzeCooccurrence(home, {}, {});
    expect(report.sessionCount).toBe(2);
    expect(report.usage).toEqual([
      { skill: 'alpha', count: 3, sessions: 2 },
      { skill: 'beta', count: 3, sessions: 2 },
    ]);
    expect(report.pairs).toEqual([
      expect.objectContaining({ a: 'alpha', b: 'beta', sessionsTogether: 2, strength: 1 }),
    ]);
  });

  it('excludes old and timestamp-less Codex calls only when a window is set', async () => {
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await writeCodexSession(home, 'codex.jsonl', [
      codexInvocation('recent', recent),
      codexInvocation('old', old),
      codexInvocation('no-timestamp'),
    ]);

    const full = await analyzeCooccurrence(home, {}, {});
    expect(full.usage.map((entry) => entry.skill).sort()).toEqual([
      'no-timestamp',
      'old',
      'recent',
    ]);

    const windowed = await analyzeCooccurrence(home, { windowDays: 7 }, {});
    expect(windowed.usage).toEqual([{ skill: 'recent', count: 1, sessions: 1 }]);
  });
});
