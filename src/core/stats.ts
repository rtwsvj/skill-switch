// S8.2 stats 聚合层(纯只读):transcript 触发计数 × scan 已装清单 → 僵尸 skill。
// 僵尸 = 已安装(占每 skill ≈100 tokens 常驻 metadata)但窗口内零触发。
// 窗口语义:--days N 时,无 timestamp 的触发被排除(无法证明在窗口内);
// 全窗口时无 timestamp 也计数。
import { readFile, stat } from 'node:fs/promises';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { scanHome } from './scan.ts';
import { readStatsCache, writeStatsCache, type StatsCacheEntry } from './stats-cache.ts';
import {
  discoverClaudeTranscriptRoots,
  listTranscriptFiles,
  parseSkillInvocationsWithCounts,
  type SkillInvocation,
} from './transcripts.ts';

const STATS_MAX_FILES = 5000;
const STATS_MAX_BYTES_PER_FILE = 32 * 1024 * 1024; // 32MB
const STATS_MAX_TOTAL_BYTES = 512 * 1024 * 1024; // 512MB
const STATS_MAX_DEPTH = 12;

export interface SkillUsage {
  skill: string;
  count: number;
  lastUsed?: string;
}

export interface ZombieSkill {
  name: string;
  agents: AgentType[];
  relSkillsDir: string;
}

export interface StatsReport {
  since?: string;
  scannedFiles: number;
  skippedFiles: number;
  parseErrors: number;
  cacheHits: number;
  cacheMisses: number;
  truncated: boolean;
  invocations: number;
  usage: SkillUsage[];
  zombies: ZombieSkill[];
}

export async function buildStats(
  home: string,
  days?: number,
  env: Record<string, string | undefined> = process.env,
): Promise<StatsReport> {
  const roots = discoverClaudeTranscriptRoots(home, env);
  const allFiles = await listTranscriptFiles(roots, STATS_MAX_DEPTH);

  const since = days !== undefined ? new Date(Date.now() - days * 86_400_000) : undefined;
  const sinceMs = since?.getTime();

  const cache = await readStatsCache(home);
  const nextEntries: Record<string, StatsCacheEntry> = {};
  let scannedFiles = 0;
  let skippedFiles = 0;
  let parseErrors = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let totalBytes = 0;
  let truncated = false;
  const all: SkillInvocation[] = [];

  for (const file of allFiles) {
    if (scannedFiles >= STATS_MAX_FILES) {
      truncated = true;
      break;
    }
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(file);
    } catch {
      skippedFiles += 1;
      continue;
    }
    const { size, mtimeMs } = info;
    // mtime 粗过滤:最后修改早于窗口起点的文件不可能含窗口内触发 → 跳过(省读+省解析)。
    if (sinceMs !== undefined && mtimeMs < sinceMs) {
      skippedFiles += 1;
      continue;
    }
    if (size > STATS_MAX_BYTES_PER_FILE) {
      skippedFiles += 1;
      continue;
    }
    if (totalBytes + size > STATS_MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }

    const cached = cache.entries[file];
    let entry: StatsCacheEntry;
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      entry = cached;
      cacheHits += 1;
    } else {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        skippedFiles += 1;
        continue;
      }
      const parsed = parseSkillInvocationsWithCounts(content, file);
      entry = { mtimeMs, size, invocations: parsed.invocations, parseErrors: parsed.parseErrors };
      cacheMisses += 1;
    }
    nextEntries[file] = entry;
    all.push(...entry.invocations);
    parseErrors += entry.parseErrors;
    totalBytes += size;
    scannedFiles += 1;
  }

  // best-effort 写回缓存(只保留本次见到的文件 → 自动淘汰已删除的)。写失败不致命。
  try {
    await writeStatsCache(home, { version: 1, entries: nextEntries });
  } catch {
    // 忽略
  }

  const windowed = since
    ? all.filter((i) => i.timestamp !== undefined && new Date(i.timestamp) >= since)
    : all;

  const byskill = new Map<string, SkillUsage>();
  for (const invocation of windowed) {
    const usage = bySkillGet(byskill, invocation.skill);
    usage.count += 1;
    if (invocation.timestamp && (!usage.lastUsed || invocation.timestamp > usage.lastUsed)) {
      usage.lastUsed = invocation.timestamp;
    }
  }
  const usage = [...byskill.values()].sort((a, b) => b.count - a.count);

  // 僵尸:scan 出的已装 skill,其 name 与 dirName 都没出现在窗口内触发里
  const triggered = new Set(usage.map((u) => u.skill));
  const records = await scanHome(home);
  const zombies: ZombieSkill[] = records
    .filter((r) => !triggered.has(r.dirName) && !(r.name !== undefined && triggered.has(r.name)))
    .map((r) => ({ name: r.name ?? r.dirName, agents: r.agents, relSkillsDir: r.relSkillsDir }));

  return {
    ...(since ? { since: since.toISOString() } : {}),
    scannedFiles,
    skippedFiles,
    parseErrors,
    cacheHits,
    cacheMisses,
    truncated,
    invocations: windowed.length,
    usage,
    zombies,
  };
}

function bySkillGet(map: Map<string, SkillUsage>, skill: string): SkillUsage {
  let usage = map.get(skill);
  if (!usage) {
    usage = { skill, count: 0 };
    map.set(skill, usage);
  }
  return usage;
}
