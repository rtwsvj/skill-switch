// M0-5.12:transcript 解析缓存。键为文件路径,值含 mtimeMs+size+触发聚合 ——
// 下次运行时文件未变(mtime+size 一致)即命中缓存,跳过重新读+解析大 JSONL。
// 缓存是可丢弃的派生数据:损坏/读不出一律当空重建(不像 skills.json 那样 fail-loud)。
// v2 只持久化 skill 计数+时间戳,不再复制 transcript 里的 args/命令和 sessionFile。
import { join } from 'node:path';
import { readJsonState, writeJsonState } from './state-io.ts';
import type { SkillInvocation } from './transcripts.ts';

export interface StatsCacheAggregate {
  skill: string;
  /** 该文件中的总触发数(包含没有 timestamp 的触发)。 */
  count: number;
  /** 仅保存用于 --days/lastUsed 计算的时间戳,不保存原始参数。 */
  timestamps: string[];
}

export interface StatsCacheEntry {
  mtimeMs: number;
  size: number;
  aggregates: StatsCacheAggregate[];
  parseErrors: number;
}

export interface StatsCacheFile {
  version: 2;
  entries: Record<string, StatsCacheEntry>;
}

/** v1 只用于就地读取/升级旧缓存;任何新写入都是不含原始 args 的 v2。 */
export interface LegacyStatsCacheEntry {
  mtimeMs: number;
  size: number;
  invocations: SkillInvocation[];
  parseErrors: number;
}

export interface LegacyStatsCacheFile {
  version: 1;
  entries: Record<string, LegacyStatsCacheEntry>;
}

export type ReadableStatsCacheFile = StatsCacheFile | LegacyStatsCacheFile;

// 保持旧 readStatsCache API 对缺失/损坏文件的返回形状;下次可写调用会升级为 v2。
const EMPTY: LegacyStatsCacheFile = { version: 1, entries: {} };

export function getStatsCachePath(home: string): string {
  return join(home, '.skill-switch', 'stats-cache.json');
}

export async function readStatsCache(home: string): Promise<ReadableStatsCacheFile> {
  try {
    const data = await readJsonState<unknown>(getStatsCachePath(home), EMPTY);
    if (
      data &&
      typeof data === 'object' &&
      'version' in data &&
      (data.version === 1 || data.version === 2) &&
      'entries' in data &&
      data.entries &&
      typeof data.entries === 'object' &&
      !Array.isArray(data.entries)
    ) {
      return data as ReadableStatsCacheFile;
    }
  } catch {
    // 缓存损坏 → 重建,不致命(派生数据)。
  }
  return { version: 1, entries: {} };
}

export async function writeStatsCache(home: string, cache: StatsCacheFile): Promise<void> {
  await writeJsonState(getStatsCachePath(home), cache);
}
