// Step2 套餐建议测试 —— 全用合成 CooccurrenceReport,不调用真实分析器。
// 覆盖:三角团一个套餐、两个独立团两个套餐、低于阈值无建议、
//       确定性(相同输入→相同输出含 id)、阈值生效、rationale 含真实数字。

import { describe, expect, it } from 'vitest';
import type { CooccurrenceReport } from '../src/core/packs/types.ts';
import { suggestPacks } from '../src/core/packs/suggest.ts';

// ── 合成 fixture 工厂 ──────────────────────────────────────────────────────────

/** 构造一个简单的三角团:A-B-C 两两强共现 */
function makeTriangle(
  windowDays?: number,
): CooccurrenceReport {
  return {
    windowDays,
    sessionCount: 30,
    usage: [
      { skill: 'typescript', count: 25, sessions: 20 },
      { skill: 'eslint', count: 18, sessions: 15 },
      { skill: 'prettier', count: 12, sessions: 10 },
    ],
    pairs: [
      { a: 'typescript', b: 'eslint', sessionsTogether: 12, strength: 0.8 },
      { a: 'typescript', b: 'prettier', sessionsTogether: 10, strength: 0.83 },
      { a: 'eslint', b: 'prettier', sessionsTogether: 9, strength: 0.9 },
    ],
  };
}

/** 两个独立团:A-B-C 和 D-E */
function makeTwoCliques(): CooccurrenceReport {
  return {
    windowDays: 14,
    sessionCount: 50,
    usage: [
      { skill: 'typescript', count: 30, sessions: 25 },
      { skill: 'eslint', count: 20, sessions: 18 },
      { skill: 'prettier', count: 15, sessions: 12 },
      { skill: 'vitest', count: 22, sessions: 20 },
      { skill: 'playwright', count: 16, sessions: 14 },
    ],
    pairs: [
      // 团1: typescript-eslint-prettier
      { a: 'typescript', b: 'eslint', sessionsTogether: 14, strength: 0.78 },
      { a: 'typescript', b: 'prettier', sessionsTogether: 11, strength: 0.73 },
      { a: 'eslint', b: 'prettier', sessionsTogether: 10, strength: 0.83 },
      // 团2: vitest-playwright
      { a: 'vitest', b: 'playwright', sessionsTogether: 13, strength: 0.93 },
      // 跨团弱边(不成立)
      { a: 'typescript', b: 'vitest', sessionsTogether: 2, strength: 0.3 },
    ],
  };
}

/** 所有对都低于阈值 */
function makeWeakPairs(): CooccurrenceReport {
  return {
    sessionCount: 20,
    usage: [
      { skill: 'foo', count: 5, sessions: 5 },
      { skill: 'bar', count: 4, sessions: 4 },
    ],
    pairs: [
      // strength 低于默认 0.5
      { a: 'foo', b: 'bar', sessionsTogether: 2, strength: 0.4 },
    ],
  };
}

/** sessionsTogether 低于默认阈值(3) */
function makeLowSessionsPairs(): CooccurrenceReport {
  return {
    sessionCount: 20,
    usage: [
      { skill: 'foo', count: 10, sessions: 10 },
      { skill: 'bar', count: 8, sessions: 8 },
    ],
    pairs: [
      // strength 够但 sessionsTogether 只有 2
      { a: 'foo', b: 'bar', sessionsTogether: 2, strength: 0.9 },
    ],
  };
}

// ── 测试 ──────────────────────────────────────────────────────────────────────

describe('suggestPacks — 三角团', () => {
  it('一个三角团应产出恰好一个套餐', () => {
    const result = suggestPacks(makeTriangle());
    expect(result).toHaveLength(1);
  });

  it('套餐应包含三个正确的 skill(排序)', () => {
    const [pack] = suggestPacks(makeTriangle());
    expect(pack!.skills).toEqual(['eslint', 'prettier', 'typescript']);
  });

  it('suggestedName 应以 usage.count 最高的 skill 命名', () => {
    const [pack] = suggestPacks(makeTriangle());
    // typescript count=25 最高
    expect(pack!.suggestedName).toBe('typescript-工作流');
  });

  it('strength 应为组内所有对的平均值(四舍五入4位)', () => {
    const [pack] = suggestPacks(makeTriangle());
    // (0.8 + 0.83 + 0.9) / 3 ≈ 0.8433
    expect(pack!.strength).toBeCloseTo(0.8433, 3);
  });

  it('rationale 应含 skill 数量 + sessionsTogether 总和 + strength', () => {
    const [pack] = suggestPacks(makeTriangle(30));
    // sessions: 12+10+9 = 31
    expect(pack!.rationale).toContain('过去30天');
    expect(pack!.rationale).toContain('3个 skill');
    expect(pack!.rationale).toContain('31 次对话');
    expect(pack!.rationale).toContain('平均共现强度');
  });

  it('无 windowDays 时 rationale 不含"过去N天"', () => {
    const report = makeTriangle();
    delete report.windowDays;
    const [pack] = suggestPacks(report);
    expect(pack!.rationale).not.toContain('过去');
    expect(pack!.rationale).toContain('3个 skill');
  });

  it('id 应以 "pack-" 开头 + 8位 hex', () => {
    const [pack] = suggestPacks(makeTriangle());
    expect(pack!.id).toMatch(/^pack-[0-9a-f]{8}$/);
  });
});

describe('suggestPacks — 两个独立团', () => {
  it('应产出恰好两个套餐', () => {
    const result = suggestPacks(makeTwoCliques());
    expect(result).toHaveLength(2);
  });

  it('两个套餐的 skill 集合应各自独立', () => {
    const result = suggestPacks(makeTwoCliques());
    const allSkills = result.flatMap((p) => p.skills);
    // 无重叠
    expect(new Set(allSkills).size).toBe(allSkills.length);
  });

  it('按强度降序排列', () => {
    const result = suggestPacks(makeTwoCliques());
    expect(result[0]!.strength).toBeGreaterThanOrEqual(result[1]!.strength);
  });

  it('vitest-playwright 对(strength 0.93)应在强度更高的套餐里', () => {
    const result = suggestPacks(makeTwoCliques());
    const testPack = result.find((p) => p.skills.includes('vitest'));
    expect(testPack).toBeDefined();
    expect(testPack!.skills).toContain('playwright');
  });

  it('跨团弱边不应合并两个团', () => {
    const result = suggestPacks(makeTwoCliques());
    // 没有一个 pack 同时包含 typescript 和 vitest
    for (const pack of result) {
      const hasTs = pack.skills.includes('typescript');
      const hasVitest = pack.skills.includes('vitest');
      expect(hasTs && hasVitest).toBe(false);
    }
  });
});

describe('suggestPacks — 低于阈值', () => {
  it('所有对 strength 低于默认阈值时返回空数组', () => {
    expect(suggestPacks(makeWeakPairs())).toHaveLength(0);
  });

  it('sessionsTogether 低于默认阈值时返回空数组', () => {
    expect(suggestPacks(makeLowSessionsPairs())).toHaveLength(0);
  });

  it('空 pairs 时返回空数组', () => {
    const report: CooccurrenceReport = {
      sessionCount: 10,
      usage: [],
      pairs: [],
    };
    expect(suggestPacks(report)).toHaveLength(0);
  });
});

describe('suggestPacks — 阈值参数生效', () => {
  it('提高 minStrength 可以排除弱边、拆分分量', () => {
    // 只保留 strength >= 0.85 时,eslint-prettier(0.9)仍在,其余断开
    // → eslint 和 prettier 成为孤立 2-node 团
    const result = suggestPacks(makeTriangle(), { minStrength: 0.85, minSessionsTogether: 1 });
    // 只有 eslint-prettier 对满足
    expect(result).toHaveLength(1);
    expect(result[0]!.skills).toEqual(['eslint', 'prettier']);
  });

  it('提高 minSessionsTogether 可以过滤会话数不足的对', () => {
    const result = suggestPacks(makeTriangle(), { minSessionsTogether: 11 });
    // 只有 sessionsTogether >= 11 的对:typescript-eslint(12), typescript-prettier(10→排除)
    // eslint-prettier(9→排除), typescript-eslint(12)→仅这一对
    // → 只剩 typescript-eslint 2-node 团
    expect(result).toHaveLength(1);
    expect(result[0]!.skills).toEqual(['eslint', 'typescript']);
  });

  it('maxPacks 限制输出数量', () => {
    const result = suggestPacks(makeTwoCliques(), { maxPacks: 1 });
    expect(result).toHaveLength(1);
  });
});

describe('suggestPacks — 确定性', () => {
  it('相同输入两次调用输出完全相同(含 id)', () => {
    const report = makeTriangle(30);
    const r1 = suggestPacks(report);
    const r2 = suggestPacks(report);
    expect(r1).toEqual(r2);
  });

  it('相同 skill 集合 id 稳定(与入参顺序无关)', () => {
    // 两张报告 pairs 顺序不同,但 skill 集合相同
    const base = makeTriangle();
    const shuffled: CooccurrenceReport = {
      ...base,
      pairs: [...base.pairs].reverse(),
    };
    const r1 = suggestPacks(base);
    const r2 = suggestPacks(shuffled);
    expect(r1[0]!.id).toBe(r2[0]!.id);
  });

  it('rationale 中的数字与 fixture 数据一致', () => {
    const [pack] = suggestPacks(makeTriangle(30));
    // 总 sessionsTogether: 12+10+9 = 31
    expect(pack!.rationale).toMatch(/31 次对话/);
    // skill 数
    expect(pack!.rationale).toMatch(/3个 skill/);
    // windowDays
    expect(pack!.rationale).toMatch(/过去30天/);
  });
});
