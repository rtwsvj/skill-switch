// S8.2 stats 聚合层(纯只读):transcript 触发计数 × scan 已装清单 → 僵尸 skill。
// 僵尸 = 已安装(占每 skill ≈100 tokens 常驻 metadata)但窗口内零触发。
// 窗口语义:--days N 时,无 timestamp 的触发被排除(无法证明在窗口内);
// 全窗口时无 timestamp 也计数。
import { readFile, stat } from 'node:fs/promises';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { scanHome } from './scan.ts';
import {
  readStatsCache,
  writeStatsCache,
  type LegacyStatsCacheEntry,
  type StatsCacheAggregate,
  type StatsCacheEntry,
} from './stats-cache.ts';
import {
  discoverAdapterTranscriptFiles,
  parseAdapterTranscriptContent,
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

export type StatsCacheMode = 'read-write' | 'read-only' | 'disabled';

export interface BuildStatsOptions {
  /**
   * read-write(默认):读取并更新派生缓存;
   * read-only:可命中现有缓存但绝不写盘;
   * disabled:不读也不写(供声明 readOnlyHint 的 MCP 工具使用)。
   */
  cacheMode?: StatsCacheMode;
}

export async function buildStats(
  home: string,
  days?: number,
  env: Record<string, string | undefined> = process.env,
  options: BuildStatsOptions = {},
): Promise<StatsReport> {
  const transcriptFiles = await discoverAdapterTranscriptFiles(home, env, STATS_MAX_DEPTH);

  const since = days !== undefined ? new Date(Date.now() - days * 86_400_000) : undefined;
  const sinceMs = since?.getTime();

  const cacheMode = options.cacheMode ?? 'read-write';
  const cache = cacheMode === 'disabled' ? undefined : await readStatsCache(home);
  const nextEntries: Record<string, StatsCacheEntry> = {};
  let scannedFiles = 0;
  let skippedFiles = 0;
  let parseErrors = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let totalBytes = 0;
  let truncated = false;
  const byskill = new Map<string, SkillUsage>();
  let invocationCount = 0;

  for (const source of transcriptFiles) {
    const file = source.sessionFile;
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

    const cached = cache?.entries[file];
    let entry: StatsCacheEntry;
    if (
      cache?.version === 2 &&
      cached &&
      cached.mtimeMs === mtimeMs &&
      cached.size === size &&
      isStatsCacheEntry(cached)
    ) {
      entry = cached;
      cacheHits += 1;
    } else if (
      cache?.version === 1 &&
      cached &&
      cached.mtimeMs === mtimeMs &&
      cached.size === size &&
      isLegacyStatsCacheEntry(cached)
    ) {
      entry = aggregateLegacyEntry(cached);
      cacheHits += 1;
    } else {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        skippedFiles += 1;
        continue;
      }
      const parsed = parseAdapterTranscriptContent(source, content);
      entry = {
        mtimeMs,
        size,
        aggregates: aggregateInvocations(parsed.invocations),
        parseErrors: parsed.parseErrors,
      };
      cacheMisses += 1;
    }
    nextEntries[file] = entry;
    invocationCount += mergeAggregates(entry.aggregates, since, byskill);
    parseErrors += entry.parseErrors;
    totalBytes += size;
    scannedFiles += 1;
  }

  // best-effort 写回 v2 聚合缓存(只保留本次见到的文件)。
  // read-only/disabled 模式绝不进入写路径,MCP 因此可以如实标注 readOnlyHint。
  if (cacheMode === 'read-write') {
    try {
      await writeStatsCache(home, { version: 2, entries: nextEntries });
    } catch {
      // 忽略
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
    invocations: invocationCount,
    usage,
    zombies,
  };
}

function aggregateInvocations(invocations: SkillInvocation[]): StatsCacheAggregate[] {
  const bySkill = new Map<string, StatsCacheAggregate>();
  for (const invocation of invocations) {
    let aggregate = bySkill.get(invocation.skill);
    if (!aggregate) {
      aggregate = { skill: invocation.skill, count: 0, timestamps: [] };
      bySkill.set(invocation.skill, aggregate);
    }
    aggregate.count += 1;
    if (invocation.timestamp !== undefined) aggregate.timestamps.push(invocation.timestamp);
  }
  return [...bySkill.values()];
}

function aggregateLegacyEntry(entry: LegacyStatsCacheEntry): StatsCacheEntry {
  return {
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    aggregates: aggregateInvocations(entry.invocations),
    parseErrors: entry.parseErrors,
  };
}

function isStatsCacheEntry(value: unknown): value is StatsCacheEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<StatsCacheEntry>;
  return (
    typeof entry.mtimeMs === 'number' &&
    Number.isFinite(entry.mtimeMs) &&
    typeof entry.size === 'number' &&
    Number.isFinite(entry.size) &&
    typeof entry.parseErrors === 'number' &&
    Number.isFinite(entry.parseErrors) &&
    Array.isArray(entry.aggregates) &&
    entry.aggregates.every(
      (aggregate) =>
        aggregate !== null &&
        typeof aggregate === 'object' &&
        typeof aggregate.skill === 'string' &&
        typeof aggregate.count === 'number' &&
        Number.isSafeInteger(aggregate.count) &&
        aggregate.count >= 0 &&
        Array.isArray(aggregate.timestamps) &&
        aggregate.timestamps.every((timestamp) => typeof timestamp === 'string'),
    )
  );
}

function isLegacyStatsCacheEntry(value: unknown): value is LegacyStatsCacheEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<LegacyStatsCacheEntry>;
  return (
    typeof entry.mtimeMs === 'number' &&
    Number.isFinite(entry.mtimeMs) &&
    typeof entry.size === 'number' &&
    Number.isFinite(entry.size) &&
    typeof entry.parseErrors === 'number' &&
    Number.isFinite(entry.parseErrors) &&
    Array.isArray(entry.invocations) &&
    entry.invocations.every(
      (invocation) =>
        invocation !== null &&
        typeof invocation === 'object' &&
        typeof invocation.skill === 'string',
    )
  );
}

/** 把单文件聚合合并进报告;窗口模式下无 timestamp 的触发与旧行为一致地被排除。 */
function mergeAggregates(
  aggregates: StatsCacheAggregate[],
  since: Date | undefined,
  target: Map<string, SkillUsage>,
): number {
  let total = 0;
  for (const aggregate of aggregates) {
    const timestamps = since
      ? aggregate.timestamps.filter((timestamp) => new Date(timestamp) >= since)
      : aggregate.timestamps;
    const count = since ? timestamps.length : aggregate.count;
    if (count === 0) continue;

    const usage = bySkillGet(target, aggregate.skill);
    usage.count += count;
    total += count;
    for (const timestamp of timestamps) {
      if (!usage.lastUsed || timestamp > usage.lastUsed) usage.lastUsed = timestamp;
    }
  }
  return total;
}

function bySkillGet(map: Map<string, SkillUsage>, skill: string): SkillUsage {
  let usage = map.get(skill);
  if (!usage) {
    usage = { skill, count: 0 };
    map.set(skill, usage);
  }
  return usage;
}
