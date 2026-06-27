// S8.4 packs/cooccurrence — 共现分析层单元测试。
// 所有 fixture 都在临时 home 里用合成 JSONL 搭建,不依赖磁盘上任何已安装 skill。
// 测试覆盖:确定性、单 skill 无 pair、同 session 共现、多 session 计数、时间窗过滤、
// 内容安全(只有 skill 名进入报告)。
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { analyzeCooccurrence } from '../src/core/packs/cooccurrence.ts';

// ── 测试辅助 ─────────────────────────────────────────────────────────────────

/** 构造一行带 Skill tool_use 的 assistant JSONL 行 */
function skillLine(skill: string, timestamp?: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `u-${skill}-${timestamp ?? 'no-ts'}`,
    ...(timestamp ? { timestamp } : {}),
    sessionId: 'irrelevant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_x', name: 'Skill', input: { skill } }],
    },
  });
}

/** ISO 字符串:N 天前 */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/** 写入一个 session 文件(JSONL) */
async function writeSession(home: string, projDir: string, fileName: string, lines: string[]) {
  const dir = join(home, '.claude', 'projects', projDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), `${lines.join('\n')}\n`);
}

// ── 测试主体 ─────────────────────────────────────────────────────────────────

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ss-cooccur-'));
});

describe('analyzeCooccurrence — 基础场景', () => {
  it('无 transcript 时返回空报告,不抛', async () => {
    const report = await analyzeCooccurrence(home);
    expect(report.sessionCount).toBe(0);
    expect(report.usage).toEqual([]);
    expect(report.pairs).toEqual([]);
    expect(report.windowDays).toBeUndefined();
  });

  it('单 skill 使用:usage 有记录但无 pair', async () => {
    await writeSession(home, 'p', 'solo.jsonl', [
      skillLine('code-review', daysAgo(1)),
      skillLine('code-review', daysAgo(1)),
    ]);
    const report = await analyzeCooccurrence(home);
    expect(report.sessionCount).toBe(1);
    expect(report.usage).toHaveLength(1);
    expect(report.usage[0]).toMatchObject({ skill: 'code-review', count: 2, sessions: 1 });
    expect(report.pairs).toHaveLength(0);
  });

  it('同一 session 两个 skill → 生成 pair,strength = 1', async () => {
    await writeSession(home, 'p', 'duo.jsonl', [
      skillLine('loop', daysAgo(1)),
      skillLine('run', daysAgo(1)),
    ]);
    const report = await analyzeCooccurrence(home);
    expect(report.sessionCount).toBe(1);
    expect(report.pairs).toHaveLength(1);
    const pair = report.pairs[0];
    expect(pair.sessionsTogether).toBe(1);
    expect(pair.strength).toBeCloseTo(1); // min(1,1) = 1; 1/1 = 1
    // a < b 字典序
    expect(pair.a).toBe('loop');
    expect(pair.b).toBe('run');
  });

  it('两个不同 session 各有不同 skill → 不构成 pair', async () => {
    await writeSession(home, 'p', 'sess1.jsonl', [skillLine('loop', daysAgo(1))]);
    await writeSession(home, 'p', 'sess2.jsonl', [skillLine('run', daysAgo(1))]);
    const report = await analyzeCooccurrence(home);
    expect(report.sessionCount).toBe(2);
    expect(report.pairs).toHaveLength(0);
    expect(report.usage).toHaveLength(2);
  });
});

describe('analyzeCooccurrence — 多 session 共现计数', () => {
  it('两 skill 在 3 个 session 都出现 → sessionsTogether = 3,strength = 1', async () => {
    for (let i = 0; i < 3; i++) {
      await writeSession(home, 'p', `s${i}.jsonl`, [
        skillLine('alpha', daysAgo(1)),
        skillLine('beta', daysAgo(1)),
      ]);
    }
    const report = await analyzeCooccurrence(home);
    expect(report.sessionCount).toBe(3);
    const pair = report.pairs.find((p) => p.a === 'alpha' && p.b === 'beta');
    expect(pair?.sessionsTogether).toBe(3);
    expect(pair?.strength).toBeCloseTo(1);
  });

  it('skill-A 出现 3 次,skill-B 出现 2 次,同 session 2 次 → strength = 2/2 = 1', async () => {
    // session 0: A + B
    await writeSession(home, 'p', 's0.jsonl', [
      skillLine('alpha', daysAgo(1)),
      skillLine('beta', daysAgo(1)),
    ]);
    // session 1: A + B
    await writeSession(home, 'p', 's1.jsonl', [
      skillLine('alpha', daysAgo(1)),
      skillLine('beta', daysAgo(1)),
    ]);
    // session 2: A only
    await writeSession(home, 'p', 's2.jsonl', [skillLine('alpha', daysAgo(1))]);

    const report = await analyzeCooccurrence(home);
    const usageA = report.usage.find((u) => u.skill === 'alpha');
    const usageB = report.usage.find((u) => u.skill === 'beta');
    expect(usageA?.sessions).toBe(3);
    expect(usageB?.sessions).toBe(2);

    const pair = report.pairs[0];
    expect(pair.sessionsTogether).toBe(2);
    // strength = 2 / min(3, 2) = 2/2 = 1
    expect(pair.strength).toBeCloseTo(1);
  });

  it('strength = sessionsTogether / min(sessionsA, sessionsB)', async () => {
    // alpha 出现 4 session;beta 出现 2 session;共现 1 session → strength = 1/2 = 0.5
    for (let i = 0; i < 4; i++) {
      const lines = [skillLine('alpha', daysAgo(1))];
      if (i < 2) lines.push(skillLine('beta', daysAgo(1)));
      // 只有 session 0 包含两者,其余只有 alpha or beta alone
      const content = i === 0 ? [skillLine('alpha', daysAgo(1)), skillLine('beta', daysAgo(1))] : [skillLine('alpha', daysAgo(1))];
      await writeSession(home, 'p', `s${i}.jsonl`, content);
    }
    // 额外一个只含 beta 的 session
    await writeSession(home, 'p', 'sbeta.jsonl', [skillLine('beta', daysAgo(1))]);

    const report = await analyzeCooccurrence(home);
    const pair = report.pairs.find((p) => p.a === 'alpha' && p.b === 'beta');
    expect(pair?.sessionsTogether).toBe(1);
    // alpha.sessions = 4, beta.sessions = 2 → min = 2 → 1/2 = 0.5
    expect(pair?.strength).toBeCloseTo(0.5);
  });

  it('同一 session 内 skill 重复调用不影响共现 sessions 计数', async () => {
    // 同一 session 里 loop 调用 3 次 + run 调用 2 次
    await writeSession(home, 'p', 's.jsonl', [
      skillLine('loop', daysAgo(1)),
      skillLine('loop', daysAgo(1)),
      skillLine('loop', daysAgo(1)),
      skillLine('run', daysAgo(1)),
      skillLine('run', daysAgo(1)),
    ]);
    const report = await analyzeCooccurrence(home);
    expect(report.usage.find((u) => u.skill === 'loop')?.count).toBe(3);
    expect(report.usage.find((u) => u.skill === 'run')?.count).toBe(2);
    // 共现 session 仍只是 1
    expect(report.pairs[0].sessionsTogether).toBe(1);
    expect(report.pairs[0].strength).toBeCloseTo(1);
  });
});

describe('analyzeCooccurrence — 时间窗过滤', () => {
  it('windowDays 排除窗口外触发,report.windowDays 被赋值', async () => {
    await writeSession(home, 'p', 'recent.jsonl', [
      skillLine('loop', daysAgo(1)),
      skillLine('run', daysAgo(1)),
    ]);
    await writeSession(home, 'p', 'old.jsonl', [
      skillLine('loop', daysAgo(40)),
      skillLine('run', daysAgo(40)),
    ]);
    const report = await analyzeCooccurrence(home, { windowDays: 7 });
    expect(report.windowDays).toBe(7);
    // old session 的触发被排除 → 只有 1 session
    expect(report.sessionCount).toBe(1);
    expect(report.pairs).toHaveLength(1);
    expect(report.pairs[0].sessionsTogether).toBe(1);
  });

  it('有窗口时无 timestamp 的触发被排除', async () => {
    // no-ts 行没有 timestamp
    await writeSession(home, 'p', 'no-ts.jsonl', [
      skillLine('loop'), // 无 timestamp
      skillLine('run'),  // 无 timestamp
    ]);
    await writeSession(home, 'p', 'with-ts.jsonl', [
      skillLine('loop', daysAgo(1)),
      skillLine('run', daysAgo(1)),
    ]);
    const report = await analyzeCooccurrence(home, { windowDays: 7 });
    // no-ts.jsonl 的触发被完全排除;只有 with-ts.jsonl
    expect(report.sessionCount).toBe(1);
  });

  it('全窗口(不设 windowDays)时无 timestamp 的触发也计入', async () => {
    await writeSession(home, 'p', 'no-ts.jsonl', [
      skillLine('loop'),
      skillLine('run'),
    ]);
    const report = await analyzeCooccurrence(home);
    expect(report.sessionCount).toBe(1);
    expect(report.pairs).toHaveLength(1);
  });
});

describe('analyzeCooccurrence — 确定性', () => {
  it('两次调用相同数据返回相同结果(pair 顺序稳定)', async () => {
    for (let i = 0; i < 3; i++) {
      await writeSession(home, 'p', `s${i}.jsonl`, [
        skillLine('beta', daysAgo(1)),
        skillLine('alpha', daysAgo(1)),
        skillLine('gamma', daysAgo(1)),
      ]);
    }
    const r1 = await analyzeCooccurrence(home);
    const r2 = await analyzeCooccurrence(home);
    expect(r1.pairs.map((p) => `${p.a}|${p.b}`)).toEqual(r2.pairs.map((p) => `${p.a}|${p.b}`));
    expect(r1.usage.map((u) => u.skill)).toEqual(r2.usage.map((u) => u.skill));
  });

  it('pair.a < pair.b 字典序(skill 名排序稳定)', async () => {
    await writeSession(home, 'p', 's.jsonl', [
      skillLine('zebra', daysAgo(1)),
      skillLine('apple', daysAgo(1)),
    ]);
    const report = await analyzeCooccurrence(home);
    expect(report.pairs[0].a).toBe('apple');
    expect(report.pairs[0].b).toBe('zebra');
  });
});

describe('analyzeCooccurrence — 内容安全', () => {
  it('报告里只有 skill 名,不含对话正文或任何其他字段', async () => {
    // 行里含大量敏感字段,检查报告里看不到
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'u-secret',
      timestamp: daysAgo(1),
      secretContent: 'TOP SECRET USER DATA',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'private conversation content' },
          { type: 'tool_use', id: 'toolu_x', name: 'Skill', input: { skill: 'loop', args: 'sensitive args here' } },
        ],
      },
    });
    const dir = join(home, '.claude', 'projects', 'p');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 's.jsonl'), `${line}\n`);

    const report = await analyzeCooccurrence(home);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('TOP SECRET');
    expect(serialized).not.toContain('private conversation');
    expect(serialized).not.toContain('sensitive args');
    // skill 名本身是要暴露的
    expect(serialized).toContain('loop');
  });
});

describe('analyzeCooccurrence — 排序', () => {
  it('usage 按 count 降序', async () => {
    // heavy 出现 3 次,light 出现 1 次
    await writeSession(home, 'p', 's1.jsonl', [
      skillLine('heavy', daysAgo(1)),
      skillLine('heavy', daysAgo(1)),
      skillLine('heavy', daysAgo(1)),
      skillLine('light', daysAgo(1)),
    ]);
    const report = await analyzeCooccurrence(home);
    expect(report.usage[0].skill).toBe('heavy');
    expect(report.usage[1].skill).toBe('light');
  });

  it('pairs 按 strength 降序,同 strength 按 sessionsTogether 降序', async () => {
    // pair(x,y):同现 2 session,各自只出现 2 session → strength = 1
    for (let i = 0; i < 2; i++) {
      await writeSession(home, 'p', `xy${i}.jsonl`, [
        skillLine('x', daysAgo(1)),
        skillLine('y', daysAgo(1)),
      ]);
    }
    // pair(a,b):同现 1 session,各自只出现 1 session → strength = 1,但 sessionsTogether = 1
    await writeSession(home, 'p', 'ab.jsonl', [
      skillLine('a', daysAgo(1)),
      skillLine('b', daysAgo(1)),
    ]);

    const report = await analyzeCooccurrence(home);
    // 两对 strength 都是 1;(x,y) 同现 2 → 排在前面
    expect(report.pairs[0].sessionsTogether).toBeGreaterThanOrEqual(
      report.pairs[1].sessionsTogether,
    );
  });
});
