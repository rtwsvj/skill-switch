// M0-5.12:transcript 解析缓存。键为文件路径,值含 mtimeMs+size+已解析的触发 ——
// 下次运行时文件未变(mtime+size 一致)即命中缓存,跳过重新读+解析大 JSONL。
// 缓存是可丢弃的派生数据:损坏/读不出一律当空重建(不像 skills.json 那样 fail-loud)。
import { join } from 'node:path';
import { readJsonState, writeJsonState } from './state-io.ts';
import type { SkillInvocation } from './transcripts.ts';

export interface StatsCacheEntry {
  mtimeMs: number;
  size: number;
  invocations: SkillInvocation[];
  parseErrors: number;
}

export interface StatsCacheFile {
  version: 1;
  entries: Record<string, StatsCacheEntry>;
}

const EMPTY: StatsCacheFile = { version: 1, entries: {} };

export function getStatsCachePath(home: string): string {
  return join(home, '.skill-switch', 'stats-cache.json');
}

export async function readStatsCache(home: string): Promise<StatsCacheFile> {
  try {
    const data = await readJsonState<StatsCacheFile>(getStatsCachePath(home), EMPTY);
    if (data && typeof data === 'object' && data.entries && typeof data.entries === 'object') {
      return data;
    }
  } catch {
    // 缓存损坏 → 重建,不致命(派生数据)。
  }
  return { version: 1, entries: {} };
}

export async function writeStatsCache(home: string, cache: StatsCacheFile): Promise<void> {
  await writeJsonState(getStatsCachePath(home), cache);
}
