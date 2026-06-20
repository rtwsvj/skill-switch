// S8.2:stats — 每 skill 触发计数、--days 时间窗、僵尸(已装零触发)分析。
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildStats } from '../src/core/stats.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

let home: string;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function skillLine(skill: string, timestamp?: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `u-${skill}-${timestamp ?? 'na'}`,
    ...(timestamp ? { timestamp } : {}),
    sessionId: 's',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_x', name: 'Skill', input: { skill } }],
    },
  });
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-stats-'));
  // 已安装:used-skill(有触发)与 zombie-skill(零触发)
  for (const name of ['used-skill', 'zombie-skill']) {
    await mkdir(join(home, '.claude', 'skills', name), { recursive: true });
    await writeFile(
      join(home, '.claude', 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: stats fixture.\n---\nB.\n`,
    );
  }
  // transcripts:used-skill 近期 1 次 + 40 天前 1 次;uninstalled-skill(触发过但未安装)1 次
  const proj = join(home, '.claude', 'projects', '-proj');
  await mkdir(proj, { recursive: true });
  await writeFile(
    join(proj, 'session.jsonl'),
    `${[
      skillLine('used-skill', isoDaysAgo(1)),
      skillLine('used-skill', isoDaysAgo(40)),
      skillLine('uninstalled-skill', isoDaysAgo(2)),
    ].join('\n')}\n`,
  );
});

describe('core/stats', () => {
  it('全窗口:计数、lastUsed、僵尸清单', async () => {
    const report = await buildStats(home);
    const used = report.usage.find((u) => u.skill === 'used-skill');
    expect(used).toMatchObject({ count: 2 });
    expect(used!.lastUsed).toBe(
      report.usage.find((u) => u.skill === 'used-skill')!.lastUsed,
    );
    expect(report.usage.find((u) => u.skill === 'uninstalled-skill')!.count).toBe(1);
    expect(report.zombies.map((z) => z.name)).toEqual(['zombie-skill']);
    expect(report.invocations).toBe(3);
  });

  it('--days 7:窗口外触发被排除,计数随之变化', async () => {
    const report = await buildStats(home, 7);
    expect(report.usage.find((u) => u.skill === 'used-skill')!.count).toBe(1);
    expect(report.since).toBeTruthy();
    // 僵尸判定基于窗口内触发:zombie-skill 仍是僵尸,used-skill 不是
    expect(report.zombies.map((z) => z.name)).toEqual(['zombie-skill']);
  });

  it('usage 按 count 降序', async () => {
    const report = await buildStats(home);
    const counts = report.usage.map((u) => u.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('无 transcripts 的 home:全部已装 skill 都是僵尸,不抛', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'skill-switch-stats-bare-'));
    await mkdir(join(bare, '.claude', 'skills', 'alone'), { recursive: true });
    await writeFile(
      join(bare, '.claude', 'skills', 'alone', 'SKILL.md'),
      '---\nname: alone\ndescription: d.\n---\nB.\n',
    );
    const report = await buildStats(bare);
    expect(report.usage).toEqual([]);
    expect(report.zombies.map((z) => z.name)).toEqual(['alone']);
  });
});

describe('stats CLI(真实子进程)', () => {
  it('--json 输出可解析且 exit 0', () => {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', CLI, 'stats', '--home', home, '--days', '7', '--json'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    const report = JSON.parse(stdout) as { zombies: Array<{ name: string }> };
    expect(report.zombies.map((z) => z.name)).toEqual(['zombie-skill']);
  });
});
