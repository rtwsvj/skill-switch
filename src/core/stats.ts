// S8.2 stats 聚合层(纯只读):transcript 触发计数 × scan 已装清单 → 僵尸 skill。
// 僵尸 = 已安装(占每 skill ≈100 tokens 常驻 metadata)但窗口内零触发。
// 窗口语义:--days N 时,无 timestamp 的触发被排除(无法证明在窗口内);
// 全窗口时无 timestamp 也计数。
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { scanHome } from './scan.ts';
import {
  discoverClaudeTranscriptRoots,
  listTranscriptFiles,
  parseSkillInvocationsFromFiles,
} from './transcripts.ts';

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
  const files = await listTranscriptFiles(roots);
  const all = await parseSkillInvocationsFromFiles(files);

  const since = days !== undefined ? new Date(Date.now() - days * 86_400_000) : undefined;
  const invocations = since
    ? all.filter((i) => i.timestamp !== undefined && new Date(i.timestamp) >= since)
    : all;

  const byskill = new Map<string, SkillUsage>();
  for (const invocation of invocations) {
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
    scannedFiles: files.length,
    invocations: invocations.length,
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
