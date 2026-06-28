// P3-D6:lift/confidence 指标测试 + suggest.ts 的 minLift 过滤
// 验证:lift 数值正确、高频 skill 假共现被 lift 过滤、confidenceAB/BA 正确、
//       additive:原有 strength 字段不受影响,现有 packs-cooccurrence 测试期望不变。

import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { analyzeCooccurrence } from '../src/core/packs/cooccurrence.ts';
import { suggestPacks } from '../src/core/packs/suggest.ts';
import type { CooccurrenceReport } from '../src/core/packs/types.ts';

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

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

async function writeSession(home: string, projDir: string, fileName: string, lines: string[]) {
  const dir = join(home, '.claude', 'projects', projDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), `${lines.join('\n')}\n`);
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ss-lift-'));
});

// ── lift 数值正确性 ───────────────────────────────────────────────────────────

describe('SkillCooccurrence — lift 数值', () => {
  it('两 skill 在 4 session 中全部共现,总共 4 session → lift = 4*4/(4*4) = 1', async () => {
    // alpha 和 beta 都出现在全部 4 个 session
    for (let i = 0; i < 4; i++) {
      await writeSession(home, 'p', `s${i}.jsonl`, [
        skillLine('alpha', daysAgo(1)),
        skillLine('beta', daysAgo(1)),
      ]);
    }
    const report = await analyzeCooccurrence(home);
    const pair = report.pairs.find((p) => p.a === 'alpha' && p.b === 'beta');
    expect(pair).toBeDefined();
    // sessions(alpha)=4, sessions(beta)=4, sessionsTogether=4, total=4
    // lift = (4*4)/(4*4) = 1.0
    expect(pair!.lift).toBeCloseTo(1.0);
  });

  it('lift > 1:两 skill 共现比随机更多', async () => {
    // 设置:10 个 session,alpha 出现 5 次,beta 出现 5 次,但共现 4 次
    // P(A) = 5/10 = 0.5, P(B) = 5/10 = 0.5, P(A∩B) = 4/10 = 0.4
    // lift = 0.4 / (0.5 * 0.5) = 0.4 / 0.25 = 1.6
    for (let i = 0; i < 4; i++) {
      await writeSession(home, 'p', `ab${i}.jsonl`, [
        skillLine('alpha', daysAgo(1)),
        skillLine('beta', daysAgo(1)),
      ]);
    }
    await writeSession(home, 'p', 'a4.jsonl', [skillLine('alpha', daysAgo(1))]);
    await writeSession(home, 'p', 'b4.jsonl', [skillLine('beta', daysAgo(1))]);
    // 4个只有其他 skill 的 session,让总数凑到 10
    for (let i = 0; i < 4; i++) {
      await writeSession(home, 'p', `other${i}.jsonl`, [skillLine('gamma', daysAgo(1))]);
    }
    const report = await analyzeCooccurrence(home);
    expect(report.sessionCount).toBe(10);
    const pair = report.pairs.find((p) => p.a === 'alpha' && p.b === 'beta');
    expect(pair).toBeDefined();
    // lift = (4 * 10) / (5 * 5) = 40 / 25 = 1.6
    expect(pair!.lift).toBeCloseTo(1.6);
    expect(pair!.lift).toBeGreaterThan(1);
  });

  it('高频 skill 与低相关 skill 的 lift 接近或低于 1(揭示假关联)', async () => {
    // superFreq 出现在全部 10 session(高频),rare 只出现在 3 session,共现 3 session
    // P(superFreq) = 10/10 = 1.0, P(rare) = 3/10 = 0.3, P(AB) = 3/10 = 0.3
    // lift = 0.3 / (1.0 * 0.3) = 1.0 (正好等于 1:独立)
    // strength = 3 / min(10, 3) = 3/3 = 1.0 (强度高!但 lift 揭示只是独立关系)
    for (let i = 0; i < 10; i++) {
      const lines = [skillLine('superFreq', daysAgo(1))];
      if (i < 3) lines.push(skillLine('rare', daysAgo(1)));
      await writeSession(home, 'p', `s${i}.jsonl`, lines);
    }
    const report = await analyzeCooccurrence(home);
    const pair = report.pairs.find(
      (p) =>
        (p.a === 'superFreq' && p.b === 'rare') || (p.a === 'rare' && p.b === 'superFreq'),
    );
    expect(pair).toBeDefined();
    // strength 高(3/3=1)但 lift = (3*10)/(10*3) = 1.0 ≈ 独立
    expect(pair!.strength).toBeCloseTo(1.0);
    // lift 接近 1,不显示强正相关
    expect(pair!.lift).toBeCloseTo(1.0, 1);
  });

  it('sessionsTogether < 2 时 lift 置 0(小样本门槛防虚高)', async () => {
    // 只有 1 次共现:样本太少,lift 不可信
    await writeSession(home, 'p', 's0.jsonl', [
      skillLine('alpha', daysAgo(1)),
      skillLine('beta', daysAgo(1)),
    ]);
    // 再加一些只有 alpha 的 session
    for (let i = 1; i < 4; i++) {
      await writeSession(home, 'p', `a${i}.jsonl`, [skillLine('alpha', daysAgo(1))]);
    }
    const report = await analyzeCooccurrence(home);
    const pair = report.pairs.find((p) => p.a === 'alpha' && p.b === 'beta');
    expect(pair).toBeDefined();
    expect(pair!.sessionsTogether).toBe(1);
    // sessionsTogether < 2 → lift = 0
    expect(pair!.lift).toBe(0);
  });
});

// ── confidence 数值正确性 ────────────────────────────────────────────────────

describe('SkillCooccurrence — confidenceAB/BA', () => {
  it('confidenceAB = sessionsTogether / sessions(a)', async () => {
    // alpha:3 session,beta:2 session,共现:2 session
    for (let i = 0; i < 2; i++) {
      await writeSession(home, 'p', `ab${i}.jsonl`, [
        skillLine('alpha', daysAgo(1)),
        skillLine('beta', daysAgo(1)),
      ]);
    }
    await writeSession(home, 'p', 'a2.jsonl', [skillLine('alpha', daysAgo(1))]);
    const report = await analyzeCooccurrence(home);
    const pair = report.pairs.find((p) => p.a === 'alpha' && p.b === 'beta');
    expect(pair).toBeDefined();
    // confidenceAB = 2/3 ≈ 0.667
    expect(pair!.confidenceAB).toBeCloseTo(2 / 3);
    // confidenceBA = 2/2 = 1.0
    expect(pair!.confidenceBA).toBeCloseTo(1.0);
  });

  it('对称对:confidenceAB 和 confidenceBA 可以不对称', async () => {
    // alpha:5 session,beta:3 session,共现:2
    for (let i = 0; i < 2; i++) {
      await writeSession(home, 'p', `ab${i}.jsonl`, [
        skillLine('alpha', daysAgo(1)),
        skillLine('beta', daysAgo(1)),
      ]);
    }
    for (let i = 0; i < 3; i++) {
      await writeSession(home, 'p', `a${i}.jsonl`, [skillLine('alpha', daysAgo(1))]);
    }
    await writeSession(home, 'p', 'b0.jsonl', [skillLine('beta', daysAgo(1))]);
    const report = await analyzeCooccurrence(home);
    const pair = report.pairs.find((p) => p.a === 'alpha' && p.b === 'beta');
    expect(pair).toBeDefined();
    // confidenceAB = 2/5 = 0.4
    expect(pair!.confidenceAB).toBeCloseTo(2 / 5);
    // confidenceBA = 2/3 ≈ 0.667
    expect(pair!.confidenceBA).toBeCloseTo(2 / 3);
  });
});

// ── strength 向后兼容(additive 证明) ─────────────────────────────────────────

describe('SkillCooccurrence — strength 字段保持不变(additive)', () => {
  it('strength 值与加 lift 之前一致', async () => {
    // 重复原有测试:两 skill 在 3 session 都出现 → strength = 1
    for (let i = 0; i < 3; i++) {
      await writeSession(home, 'p', `s${i}.jsonl`, [
        skillLine('alpha', daysAgo(1)),
        skillLine('beta', daysAgo(1)),
      ]);
    }
    const report = await analyzeCooccurrence(home);
    const pair = report.pairs.find((p) => p.a === 'alpha' && p.b === 'beta');
    expect(pair).toBeDefined();
    expect(pair!.sessionsTogether).toBe(3);
    expect(pair!.strength).toBeCloseTo(1.0);
    // 新字段也存在
    expect(typeof pair!.lift).toBe('number');
    expect(typeof pair!.confidenceAB).toBe('number');
    expect(typeof pair!.confidenceBA).toBe('number');
  });
});

// ── suggest.ts 的 minLift 过滤 ──────────────────────────────────────────────

describe('suggestPacks — minLift 过滤高频 skill 假关联', () => {
  // 构造一个合成报告:superFreq 与所有 skill 都 strength=1(因为它出现在所有 session),
  // 但 lift 揭示只是独立关系(lift≈1)。真实配对(alpha-beta)有 lift>1。
  function makeHighFreqReport(): CooccurrenceReport {
    return {
      sessionCount: 20,
      usage: [
        { skill: 'superFreq', count: 20, sessions: 20 }, // 每次都用
        { skill: 'alpha', count: 6, sessions: 6 },
        { skill: 'beta', count: 6, sessions: 6 },
      ],
      pairs: [
        // superFreq-alpha: strength=1(min(20,6)=6,sessionsTogether=6),但 lift = (6*20)/(20*6)=1.0
        {
          a: 'alpha',
          b: 'superFreq',
          sessionsTogether: 6,
          strength: 1.0,
          lift: 1.0,
          confidenceAB: 1.0,
          confidenceBA: 0.3,
        },
        // superFreq-beta: 同理
        {
          a: 'beta',
          b: 'superFreq',
          sessionsTogether: 6,
          strength: 1.0,
          lift: 1.0,
          confidenceAB: 1.0,
          confidenceBA: 0.3,
        },
        // alpha-beta: 真实配对,lift = (5*20)/(6*6) ≈ 2.78
        {
          a: 'alpha',
          b: 'beta',
          sessionsTogether: 5,
          strength: 0.83,
          lift: 2.78,
          confidenceAB: 0.83,
          confidenceBA: 0.83,
        },
      ],
    };
  }

  it('不设 minLift 时(默认),superFreq 假关联也会被建议', () => {
    const result = suggestPacks(makeHighFreqReport(), {
      minStrength: 0.5,
      minSessionsTogether: 3,
    });
    // 所有 strength >= 0.5 的对都成立,三者连通 → 可能合并成一个大团
    expect(result.length).toBeGreaterThan(0);
  });

  it('设 minLift >= 1.5 时,lift=1 的假关联对被过滤,只剩真实配对', () => {
    const result = suggestPacks(makeHighFreqReport(), {
      minStrength: 0.5,
      minSessionsTogether: 3,
      minLift: 1.5,
    });
    // 只有 alpha-beta (lift=2.78) 通过;superFreq 的对被过滤
    expect(result).toHaveLength(1);
    const pack = result[0]!;
    expect(pack.skills).toContain('alpha');
    expect(pack.skills).toContain('beta');
    expect(pack.skills).not.toContain('superFreq');
  });

  it('minLift 超过所有对的 lift 时返回空数组', () => {
    const result = suggestPacks(makeHighFreqReport(), { minLift: 99 });
    expect(result).toHaveLength(0);
  });

  it('pair 缺少 lift 字段(旧数据)时,有 minLift 则被排除(视为 lift=0)', () => {
    // 合成旧数据格式:没有 lift 字段
    const oldReport: CooccurrenceReport = {
      sessionCount: 10,
      usage: [
        { skill: 'x', count: 5, sessions: 5 },
        { skill: 'y', count: 5, sessions: 5 },
      ],
      pairs: [
        // 旧格式:只有 a/b/sessionsTogether/strength(lift/confidenceAB/BA 均为 undefined)
        { a: 'x', b: 'y', sessionsTogether: 5, strength: 1.0 },
      ],
    };
    // 有 minLift:缺失 lift 视为 0,被排除
    expect(suggestPacks(oldReport, { minLift: 1.5, minSessionsTogether: 1 })).toHaveLength(0);
    // 没有 minLift:正常通过
    expect(suggestPacks(oldReport, { minSessionsTogether: 1 })).toHaveLength(1);
  });
});
