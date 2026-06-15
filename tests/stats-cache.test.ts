// M0-5.12:stats 限流/缓存/透明报告。
import { mkdtempSync } from 'node:fs';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildStats } from '../src/core/stats.ts';

let home: string;
let projDir: string;

function invocationLine(skill: string, timestamp?: string): string {
  return JSON.stringify({
    ...(timestamp ? { timestamp } : {}),
    message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] },
  });
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-statscache-'));
  projDir = join(home, '.claude', 'projects', 'proj');
  await mkdir(projDir, { recursive: true });
});

const env = {}; // 不让 CLAUDE_CONFIG_DIR 干扰,走 home/.claude/projects

describe('M0-5.12 stats cache + limits + coverage', () => {
  it('parses on first run (cacheMiss) and serves from cache on the second run (cacheHit)', async () => {
    await writeFile(join(projDir, 'a.jsonl'), `${invocationLine('foo', new Date().toISOString())}\n`);

    const first = await buildStats(home, undefined, env);
    expect(first.scannedFiles).toBe(1);
    expect(first.cacheMisses).toBe(1);
    expect(first.cacheHits).toBe(0);
    expect(first.invocations).toBe(1);

    const second = await buildStats(home, undefined, env);
    expect(second.cacheHits).toBe(1);
    expect(second.cacheMisses).toBe(0);
    expect(second.invocations).toBe(1);
  });

  it('skips files modified before the --days window via mtime pre-filter', async () => {
    const old = join(projDir, 'old.jsonl');
    await writeFile(old, `${invocationLine('stale')}\n`);
    const longAgo = new Date(Date.now() - 100 * 86_400_000);
    await utimes(old, longAgo, longAgo); // 100 天前

    const report = await buildStats(home, 30, env); // 仅最近 30 天
    expect(report.skippedFiles).toBeGreaterThanOrEqual(1);
    expect(report.scannedFiles).toBe(0);
  });

  it('counts malformed lines as parseErrors and never crashes', async () => {
    await writeFile(
      join(projDir, 'mixed.jsonl'),
      `${invocationLine('foo', new Date().toISOString())}\n{ this is not json\n\n`,
    );
    const report = await buildStats(home, undefined, env);
    expect(report.parseErrors).toBeGreaterThanOrEqual(1);
    expect(report.invocations).toBe(1); // 好行仍被计入
  });
});
