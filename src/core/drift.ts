// S7.1 drift:上游 HEAD vs lock.commit vs 本地内容哈希 的三方 diff。纯读。
// 与 doctor 的分工:doctor 看"声明/锁/磁盘是否自洽",drift 看"锁住的版本
// 相对上游与本地是否漂移"——vercel update.ts 是两方(上游 vs 已装)逻辑,
// 这里以 lock 为基线扩展为三方(调研结论:无人开源先例)。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { computeSkillFolderHash } from '../vendor/vercel-skills/local-lock.ts';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { getSkillsLockPath, readSkillsLock } from './lock.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';

const execFileAsync = promisify(execFile);

export type DriftState =
  | 'in-sync'
  | 'upstream-ahead'
  | 'local-modified'
  | 'diverged'
  | 'unknown';

export interface DriftEntry {
  name: string;
  agent: AgentType;
  state: DriftState;
  upstreamAhead: boolean;
  localModified: boolean;
  lockCommit?: string;
  upstreamCommit?: string;
  detail: string;
}

async function lsRemoteHead(source: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', source, 'HEAD'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.split('\t')[0]?.trim() || undefined;
  } catch {
    return undefined; // 上游不可达:不阻断,状态记 unknown 维度
  }
}

function stateOf(upstreamAhead: boolean, localModified: boolean): DriftState {
  if (upstreamAhead && localModified) return 'diverged';
  if (upstreamAhead) return 'upstream-ahead';
  if (localModified) return 'local-modified';
  return 'in-sync';
}

export async function checkDrift(home: string): Promise<DriftEntry[]> {
  const lock = await readSkillsLock(getSkillsLockPath(home));
  const entries: DriftEntry[] = [];

  for (const entry of lock.skills) {
    const location = getAgentSkillsLocations().find((l) => l.agent === entry.agent);
    const target = location ? join(resolveGlobalSkillsDir(home, location), entry.name) : undefined;

    // 本地维度:安装产物哈希 vs 锁内 sha256
    let localModified = false;
    let localDetail = '';
    if (!target || !existsSync(target)) {
      localModified = true;
      localDetail = '安装产物缺失';
    } else {
      const actual = await computeSkillFolderHash(target);
      if (actual !== entry.sha256) {
        localModified = true;
        localDetail = '本地内容与锁内哈希不符';
      }
    }

    // 上游维度:仅 git 来源;HEAD vs lock.commit
    let upstreamAhead = false;
    let upstreamCommit: string | undefined;
    let upstreamDetail = '';
    if (entry.sourceType === 'git' && entry.commit) {
      upstreamCommit = await lsRemoteHead(entry.source);
      if (upstreamCommit === undefined) {
        upstreamDetail = '上游不可达,跳过上游比对';
      } else if (upstreamCommit !== entry.commit) {
        upstreamAhead = true;
        upstreamDetail = `上游 HEAD ${upstreamCommit.slice(0, 12)} ≠ 锁定 ${entry.commit.slice(0, 12)}`;
      }
    }

    entries.push({
      name: entry.name,
      agent: entry.agent,
      state: stateOf(upstreamAhead, localModified),
      upstreamAhead,
      localModified,
      lockCommit: entry.commit,
      upstreamCommit,
      detail: [upstreamDetail, localDetail].filter(Boolean).join(';') || '与锁定基线一致',
    });
  }

  return entries;
}
