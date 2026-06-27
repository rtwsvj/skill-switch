// diff-narrative.ts — 为 `skill-switch diff` 生成一句话叙述摘要 + 安全信号。
//
// 设计原则:
//   1. 纯函数 — 无 IO,无副作用,易于测试。
//   2. 复用已有审计引擎 (auditContents / allRules / allFileRules) — 不造新探测器,不引入新依赖。
//   3. Diff 信号而非绝对信号 — 只报告「after 有、before 没有」的 findings,
//      即「在此次改动中新引入」的风险;删掉恶意行不算新引入。
//   4. 内容安全 — riskySignals 只暴露 ruleId/category/数量,绝不输出匹配到的原文片段。

import { auditContents } from './audit/engine.ts';
import type { AuditFinding } from './audit/types.ts';
import { allFileRules, allRules } from '../../rules/index.ts';

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

export interface DiffNarrativeInput {
  /** 改动的文件数 (comparable diff 已计算好) */
  filesChanged: number;
  /** 所有文件 +行 之和 */
  linesAdded: number;
  /** 所有文件 −行 之和 */
  linesRemoved: number;
  /**
   * 磁盘(after)文件内容:文件名 → 文本。
   * 已删除的文件在 diskFiles 中缺席(或 Buffer);此处用 string 方便引擎直接使用。
   */
  afterContents: Map<string, string>;
  /**
   * store(before)文件内容:文件名 → 文本。
   * 新增的文件在 storeFiles 中缺席。
   */
  beforeContents: Map<string, string>;
}

export interface DiffNarrative {
  /** 一句话中文摘要,直接可以打印给用户 */
  summary: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  /**
   * 在此次改动中新引入的风险信号列表。
   * 每个元素是 "<ruleId>(<severity>)" 形式,不含任何匹配原文。
   * 为空列表表示无新风险。
   */
  riskySignals: string[];
}

// ---------------------------------------------------------------------------
// 行计数辅助
// ---------------------------------------------------------------------------

/**
 * 对两段文本做极简行差分,统计新增行数与删除行数。
 * 不依赖任何外部库,仅用于摘要中的 +n/−m 数字。
 *
 * 算法:「以每行内容的多集合差」近似计算。
 * 精度足够摘要使用;unified diff 中的实际行号由 skill-diff.ts 的 LCS 确保精确。
 */
export function countLineDelta(
  before: string,
  after: string,
): { added: number; removed: number } {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // 多集合计数(Map<行内容, 出现次数>)
  const beforeCount = new Map<string, number>();
  for (const l of beforeLines) beforeCount.set(l, (beforeCount.get(l) ?? 0) + 1);

  const afterCount = new Map<string, number>();
  for (const l of afterLines) afterCount.set(l, (afterCount.get(l) ?? 0) + 1);

  // 删除 = before 中多出来的;新增 = after 中多出来的
  let removed = 0;
  for (const [l, cnt] of beforeCount) {
    const afterCnt = afterCount.get(l) ?? 0;
    if (cnt > afterCnt) removed += cnt - afterCnt;
  }
  let added = 0;
  for (const [l, cnt] of afterCount) {
    const beforeCnt = beforeCount.get(l) ?? 0;
    if (cnt > beforeCnt) added += cnt - beforeCnt;
  }
  return { added, removed };
}

// ---------------------------------------------------------------------------
// 审计引擎调用 + 信号 diff
// ---------------------------------------------------------------------------

/**
 * 对一组文件内容跑 auditContents,返回 ruleId Set(去重后)。
 * 只关心「哪些规则命中」,不关心行号/摘要,因此结果是 Set<ruleId>。
 */
function auditRuleIds(contents: Map<string, string>): Set<string> {
  if (contents.size === 0) return new Set();

  const targets = Array.from(contents.entries()).map(([file, content]) => ({ file, content }));
  const report = auditContents(allRules, targets, allFileRules);
  return new Set(report.findings.map((f: AuditFinding) => f.ruleId));
}

/**
 * 计算「新引入」的风险信号:after 有、before 没有的 ruleId。
 * 被删掉的恶意行(before 有、after 没有)不计入。
 * 返回列表中每项格式为 "<ruleId>(<severity>)",内容安全(无原文)。
 */
function computeNewRiskySignals(
  beforeContents: Map<string, string>,
  afterContents: Map<string, string>,
): string[] {
  const beforeIds = auditRuleIds(beforeContents);
  const afterIds = auditRuleIds(afterContents);

  // 只保留 after 有 before 没有的
  const newIds = [...afterIds].filter((id) => !beforeIds.has(id));
  if (newIds.length === 0) return [];

  // 为每个新引入的 ruleId 附上 severity(从 allRules 查表)
  const severityMap = new Map<string, string>();
  for (const r of allRules) severityMap.set(r.id, r.severity);
  for (const r of allFileRules) severityMap.set(r.id, r.severity);

  return newIds.sort().map((id) => {
    const sev = severityMap.get(id) ?? 'unknown';
    return `${id}(${sev})`;
  });
}

// ---------------------------------------------------------------------------
// 公共入口
// ---------------------------------------------------------------------------

/**
 * 生成改动摘要与安全信号。
 * 完全确定性:相同输入返回相同输出;无 IO。
 */
export function summarizeDiff(input: DiffNarrativeInput): DiffNarrative {
  const { filesChanged, linesAdded, linesRemoved, beforeContents, afterContents } = input;

  const riskySignals = computeNewRiskySignals(beforeContents, afterContents);

  // 构建一句话摘要
  let summary: string;
  if (filesChanged === 0) {
    summary = '摘要:与安装时一致,无改动';
  } else {
    const filesPart =
      filesChanged === 1 ? `动了 1 个文件` : `动了 ${filesChanged} 个文件`;
    const linePart = `+${linesAdded}/−${linesRemoved} 行`;
    if (riskySignals.length === 0) {
      summary = `摘要:${filesPart},${linePart}`;
    } else {
      // 按 category(ruleId 斜线前半部分)分组展示,数量 + 代表性 category
      const categories = [...new Set(riskySignals.map((s) => s.split('/')[0] ?? s))];
      const warnPart =
        riskySignals.length === 1
          ? `⚠ 新引入 1 处风险(${categories.join('/')})`
          : `⚠ 新引入 ${riskySignals.length} 处风险(${categories.join('/')})`;
      summary = `摘要:${filesPart},${linePart};${warnPart}`;
    }
  }

  return { summary, filesChanged, linesAdded, linesRemoved, riskySignals };
}

// ---------------------------------------------------------------------------
// 辅助:从 Buffer Map 计算总 +/- 行数
// ---------------------------------------------------------------------------

/**
 * 给定 diskFiles(after)和 storeFiles(before)的 Buffer Map,
 * 计算整体的新增行数和删除行数。
 * 供 diff.ts 调用(已有 Buffer,转换为 string)。
 */
export function computeLineCounts(
  diskFiles: Map<string, Buffer>,
  storeFiles: Map<string, Buffer>,
): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;

  // 所有出现过的文件路径
  const allPaths = new Set([...diskFiles.keys(), ...storeFiles.keys()]);

  for (const path of allPaths) {
    const before = storeFiles.get(path)?.toString('utf8') ?? '';
    const after = diskFiles.get(path)?.toString('utf8') ?? '';
    const { added, removed } = countLineDelta(before, after);
    linesAdded += added;
    linesRemoved += removed;
  }

  return { linesAdded, linesRemoved };
}

/**
 * 将 Buffer Map 转为 string Map 供 summarizeDiff 使用。
 */
export function bufferMapToStringMap(m: Map<string, Buffer>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of m) out.set(k, v.toString('utf8'));
  return out;
}
