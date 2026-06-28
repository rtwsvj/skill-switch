// 套餐特性 Step1:共现分析(只读纯函数)。
// 以「同一个 session 文件 = 同一次对话」为共现单位,统计 skill 两两在同一 session 内出现的频率。
// 严格只读:只消费 transcripts.ts 已提取的 skill 名 + sessionFile + timestamp;
// 不读对话正文,不出本机,不写任何文件。
import { readFile, stat } from 'node:fs/promises';
import {
  discoverClaudeTranscriptRoots,
  listTranscriptFiles,
  parseSkillInvocationsWithCounts,
} from '../transcripts.ts';
import type { CooccurrenceReport, SkillCooccurrence, SkillUsageStat } from './types.ts';

// 与 stats.ts 保持一致的资源上限
const MAX_FILES = 5000;
const MAX_BYTES_PER_FILE = 32 * 1024 * 1024; // 32 MB
const MAX_TOTAL_BYTES = 512 * 1024 * 1024; // 512 MB
const MAX_DEPTH = 12;

export interface AnalyzeCooccurrenceOptions {
  /** 仅统计最近 N 天内的触发;不设 = 全量。
   * 语义与 stats.ts 一致:有窗口时无 timestamp 的触发被排除。 */
  windowDays?: number;
}

/**
 * 分析 skill 共现情况。
 *
 * @param home  用户 home 目录(用于发现 transcript 根)
 * @param opts  可选:windowDays 限制时间窗
 * @returns     CooccurrenceReport — 纯只读产物,无副作用
 */
export async function analyzeCooccurrence(
  home: string,
  opts: AnalyzeCooccurrenceOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<CooccurrenceReport> {
  const { windowDays } = opts;
  const since =
    windowDays !== undefined ? new Date(Date.now() - windowDays * 86_400_000) : undefined;

  // ── 1. 发现 + 读取 transcript 文件 ─────────────────────────────────────────
  const roots = discoverClaudeTranscriptRoots(home, env);
  const allFiles = await listTranscriptFiles(roots, MAX_DEPTH);

  // sessionFile → Set<skill>(窗口内去重触发,用于共现计数)
  // sessionFile → Map<skill, count>(窗口内计数,用于 usage 聚合)
  const sessionSkills = new Map<string, Set<string>>();
  const sessionSkillCounts = new Map<string, Map<string, number>>();

  let totalBytes = 0;
  let filesSeen = 0;

  for (const file of allFiles) {
    if (filesSeen >= MAX_FILES) break;

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    const { size, mtimeMs } = info;

    // mtime 粗过滤:最后修改早于窗口起点的文件 → 必然全排除,直接跳过
    if (since !== undefined && mtimeMs < since.getTime()) continue;
    if (size > MAX_BYTES_PER_FILE) continue;
    if (totalBytes + size > MAX_TOTAL_BYTES) break;

    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }

    const { invocations } = parseSkillInvocationsWithCounts(content, file);
    totalBytes += size;
    filesSeen += 1;

    for (const inv of invocations) {
      // 时间窗过滤:有窗口时无 timestamp 的触发被排除(与 stats.ts 对齐)
      if (since !== undefined) {
        if (inv.timestamp === undefined) continue;
        if (new Date(inv.timestamp) < since) continue;
      }

      const sf = inv.sessionFile;

      // 共现用 Set(去重:同一 session 里同一 skill 出现多次仍算 1 个 session)
      let skills = sessionSkills.get(sf);
      if (!skills) {
        skills = new Set();
        sessionSkills.set(sf, skills);
      }
      skills.add(inv.skill);

      // 使用计数用 Map(用于 SkillUsageStat.count)
      let counts = sessionSkillCounts.get(sf);
      if (!counts) {
        counts = new Map();
        sessionSkillCounts.set(sf, counts);
      }
      counts.set(inv.skill, (counts.get(inv.skill) ?? 0) + 1);
    }
  }

  // ── 2. 汇总 SkillUsageStat ─────────────────────────────────────────────────
  // count = 跨所有 session 的总触发次数;sessions = 出现过的不同 session 数
  const usageMap = new Map<string, { count: number; sessions: number }>();

  for (const [, counts] of sessionSkillCounts) {
    for (const [skill, cnt] of counts) {
      const entry = usageMap.get(skill) ?? { count: 0, sessions: 0 };
      entry.count += cnt;
      entry.sessions += 1;
      usageMap.set(skill, entry);
    }
  }

  const usage: SkillUsageStat[] = [...usageMap.entries()]
    .map(([skill, { count, sessions }]) => ({ skill, count, sessions }))
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));

  // ── 3. 汇总 SkillCooccurrence ──────────────────────────────────────────────
  // pair key = "skillA\0skillB"(a < b 字典序,确保稳定无重)
  const pairSessions = new Map<string, number>(); // key → sessionsTogether

  for (const [, skills] of sessionSkills) {
    if (skills.size < 2) continue;
    const sorted = [...skills].sort();
    for (let i = 0; i < sorted.length - 1; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}\0${sorted[j]}`;
        pairSessions.set(key, (pairSessions.get(key) ?? 0) + 1);
      }
    }
  }

  // sessions(skill) 查找表
  const skillSessions = new Map<string, number>(
    [...usageMap.entries()].map(([skill, { sessions }]) => [skill, sessions]),
  );

  // 总 session 数(分母),用于 lift 计算
  const totalSessions = sessionSkills.size;

  const pairs: SkillCooccurrence[] = [...pairSessions.entries()]
    .map(([key, sessionsTogether]) => {
      const [a, b] = key.split('\0') as [string, string];
      const sessA = skillSessions.get(a) ?? 0;
      const sessB = skillSessions.get(b) ?? 0;
      const minSessions = Math.min(sessA === 0 ? 1 : sessA, sessB === 0 ? 1 : sessB);
      // strength ∈ [0,1]:越接近 1 代表两者越「绑定」
      const strength = minSessions > 0 ? sessionsTogether / minSessions : 0;

      // ── 关联规则指标 ─────────────────────────────────────────────────────────
      // 置信度:confidence(A→B) = sessionsTogether / sessions(a)
      const confidenceAB = sessA > 0 ? sessionsTogether / sessA : 0;
      // 置信度:confidence(B→A) = sessionsTogether / sessions(b)
      const confidenceBA = sessB > 0 ? sessionsTogether / sessB : 0;
      // 提升度 lift = P(A∩B) / (P(A)·P(B))
      //   = (sessionsTogether/N) / ((sessA/N)·(sessB/N))
      //   = (sessionsTogether·N) / (sessA·sessB)
      // 小 sessionCount 时 lift 容易虚高;要求 sessionsTogether >= 2 才计算,否则置 0。
      const lift =
        totalSessions > 0 && sessA > 0 && sessB > 0 && sessionsTogether >= 2
          ? (sessionsTogether * totalSessions) / (sessA * sessB)
          : 0;

      return { a, b, sessionsTogether, strength, lift, confidenceAB, confidenceBA };
    })
    .sort(
      (x, y) =>
        y.strength - x.strength ||
        y.sessionsTogether - x.sessionsTogether ||
        x.a.localeCompare(y.a) ||
        x.b.localeCompare(y.b),
    );

  return {
    ...(windowDays !== undefined ? { windowDays } : {}),
    sessionCount: sessionSkills.size,
    usage,
    pairs,
  };
}
