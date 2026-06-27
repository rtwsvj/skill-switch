// Step2 套餐建议:将共现报告(CooccurrenceReport)转化为建议套餐(PackSuggestion[])。
//
// 聚类方案:连通分量(connected components)
//   - 在 pairs 中,满足 strength >= minStrength AND sessionsTogether >= minSessionsTogether
//     的两个 skill 之间连一条边。
//   - 对图取连通分量,大小 >= 2 的分量成为候选套餐。
//   - 选择理由:确定性强(同输入必同输出)、可解释(每条边都有阈值依据)、
//     实现简单(Union-Find O(n·α(n)))、对稀疏图效果好(skill 数一般 < 100)。
//
// 命名规则:取组内 usage.count 最高的 skill(topSkill)+ "-工作流"。
//   若 usage 里找不到任何组内成员(极端情况),则退化为 "<skill1>+<skill2>[+…]"。
//
// id 生成:将组内 skill 名排序后用 "/" 连接,做简单 djb2 哈希转 hex 字符串。
//   不引入任何外部哈希库,纯字符串运算;输出格式 "pack-<8位hex>"。
//
// rationale 示例:
//   "过去30天,这3个 skill 在 12 次对话里一起出现(平均共现强度 0.82)"
//   (若无 windowDays 则省略"过去N天,"部分)
//
// 纯函数:无 IO、无网络、无外部依赖;给定相同输入输出完全相同。

import type { CooccurrenceReport, PackSuggestion } from './types.ts';

export interface SuggestPacksOptions {
  /** 边成立的最低强度,默认 0.5 */
  minStrength?: number;
  /** 边成立的最低共现 session 数,默认 3 */
  minSessionsTogether?: number;
  /** 最多返回几个建议,默认 5 */
  maxPacks?: number;
}

// ── djb2 哈希(仅内部用) ──────────────────────────────────────────────────────

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    // h = h * 33 ^ charCode
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    // 保持 32 位有符号整数范围(避免浮点溢出)
    h = h | 0;
  }
  return h >>> 0; // 转为无符号 32 位
}

function stableId(sortedSkills: string[]): string {
  const key = sortedSkills.join('/');
  const hash = djb2(key).toString(16).padStart(8, '0');
  return `pack-${hash}`;
}

// ── Union-Find ────────────────────────────────────────────────────────────────

function makeUnionFind(nodes: string[]): {
  find: (x: string) => string;
  union: (x: string, y: string) => void;
} {
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();
  for (const n of nodes) {
    parent.set(n, n);
    rank.set(n, 0);
  }

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // 路径压缩
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  function union(x: string, y: string): void {
    const rx = find(x);
    const ry = find(y);
    if (rx === ry) return;
    const rankX = rank.get(rx) ?? 0;
    const rankY = rank.get(ry) ?? 0;
    if (rankX < rankY) {
      parent.set(rx, ry);
    } else if (rankX > rankY) {
      parent.set(ry, rx);
    } else {
      parent.set(ry, rx);
      rank.set(rx, rankX + 1);
    }
  }

  return { find, union };
}

// ── 工具:取组内平均强度 ───────────────────────────────────────────────────────

function avgStrength(
  skills: string[],
  pairs: CooccurrenceReport['pairs'],
): number {
  const skillSet = new Set(skills);
  let total = 0;
  let count = 0;
  for (const p of pairs) {
    if (skillSet.has(p.a) && skillSet.has(p.b)) {
      total += p.strength;
      count++;
    }
  }
  return count === 0 ? 0 : total / count;
}

// ── 工具:组内总共现 session 数(所有有效对的 sessionsTogether 之和) ────────────

function totalSessionsTogether(
  skills: string[],
  pairs: CooccurrenceReport['pairs'],
): number {
  const skillSet = new Set(skills);
  let total = 0;
  for (const p of pairs) {
    if (skillSet.has(p.a) && skillSet.has(p.b)) {
      total += p.sessionsTogether;
    }
  }
  return total;
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * 将共现报告转化为建议套餐列表。
 *
 * 聚类方式:连通分量 —— 满足阈值的 skill 对连边,取连通分量作为候选套餐。
 * 输出按组内平均强度降序,最多返回 maxPacks 个。
 * 纯函数,无副作用,给定相同输入输出完全相同。
 */
export function suggestPacks(
  report: CooccurrenceReport,
  opts: SuggestPacksOptions = {},
): PackSuggestion[] {
  const minStrength = opts.minStrength ?? 0.5;
  const minSessionsTogether = opts.minSessionsTogether ?? 3;
  const maxPacks = opts.maxPacks ?? 5;

  // 收集所有出现在有效边里的节点
  const validPairs = report.pairs.filter(
    (p) => p.strength >= minStrength && p.sessionsTogether >= minSessionsTogether,
  );

  if (validPairs.length === 0) return [];

  const nodeSet = new Set<string>();
  for (const p of validPairs) {
    nodeSet.add(p.a);
    nodeSet.add(p.b);
  }
  const nodes = [...nodeSet];

  // Union-Find 聚类
  const uf = makeUnionFind(nodes);
  for (const p of validPairs) {
    uf.union(p.a, p.b);
  }

  // 按根节点分组(保证 key 唯一)
  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const root = uf.find(n);
    const list = groups.get(root) ?? [];
    list.push(n);
    groups.set(root, list);
  }

  // usage 查找表(skill→count),用于命名
  const usageMap = new Map<string, number>();
  for (const u of report.usage) {
    usageMap.set(u.skill, u.count);
  }

  // 为每个分量生成 PackSuggestion
  const suggestions: PackSuggestion[] = [];

  for (const [, members] of groups) {
    if (members.length < 2) continue;

    // 排序:先按 id 稳定,再用于所有后续计算
    const skills = [...members].sort();

    // 命名:取 usage.count 最大的那个 skill
    let topSkill = skills[0]!;
    let topCount = usageMap.get(topSkill) ?? 0;
    for (const sk of skills) {
      const c = usageMap.get(sk) ?? 0;
      if (c > topCount || (c === topCount && sk < topSkill)) {
        topCount = c;
        topSkill = sk;
      }
    }
    const suggestedName = `${topSkill}-工作流`;

    const id = stableId(skills);
    const strength = Number(avgStrength(skills, report.pairs).toFixed(4));

    // rationale 里的数字:组内有效对的 sessionsTogether 之和(反映"一起出现"规模)
    const sessionsNum = totalSessionsTogether(skills, report.pairs);
    const strengthDisplay = strength.toFixed(2);
    const windowPart =
      report.windowDays !== undefined ? `过去${report.windowDays}天,` : '';
    const rationale =
      `${windowPart}这${skills.length}个 skill 在 ${sessionsNum} 次对话里一起出现` +
      `(平均共现强度 ${strengthDisplay})`;

    suggestions.push({ id, suggestedName, skills, strength, rationale });
  }

  // 按强度降序;同强度按 id 字典序(保持稳定)
  suggestions.sort((a, b) =>
    b.strength !== a.strength ? b.strength - a.strength : a.id.localeCompare(b.id),
  );

  return suggestions.slice(0, maxPacks);
}
