// W7-a watch 核心:单次扫盘 vs 声明对比,检出"磁盘在位但不在声明中"的 skill。
// 纯读,只 scan + readDeclaration,绝无写操作。
// "被绕过治理层"定义:skill 目录存在于磁盘(scanHome 能发现),但其 dirName 不在
// skills.json 的声明列表中(无论 enabled/disabled)。
import { getSkillsJsonPath, readDeclaration } from './sync.ts';
import { scanHome } from './scan.ts';

export type WatchStatus = 'managed' | 'unmanaged';

export interface WatchEntry {
  /** skill 目录名(即 skill 的标识) */
  name: string;
  /** 磁盘上所属的 skills 目录约定,如 `.claude/skills` */
  relSkillsDir: string;
  /** skill 目录绝对路径 */
  dir: string;
  /** 哪些 agent 能看到这个 skill */
  agents: string[];
  /** managed = 在声明中;unmanaged = 绕过治理层直接写盘 */
  status: WatchStatus;
  /** 来自 SKILL.md frontmatter 的 name,解析失败时为 undefined */
  skillName?: string;
}

export interface WatchReport {
  home: string;
  total: number;
  unmanaged: number;
  entries: WatchEntry[];
}

/**
 * 单次扫盘对比:scanHome() 结果 vs skills.json 声明。
 * 磁盘存在但不在声明(任意 agent/任意 enabled 状态)的 skill → unmanaged。
 */
export async function runWatchScan(home: string): Promise<WatchReport> {
  const skillsJsonPath = getSkillsJsonPath(home);
  const [records, declaration] = await Promise.all([
    scanHome(home),
    readDeclaration(skillsJsonPath),
  ]);

  // 声明集合:所有 skill 名(无论 enabled/disabled)
  const declaredNames = new Set(declaration.skills.map((s) => s.name));

  const entries: WatchEntry[] = records.map((record): WatchEntry => ({
    name: record.dirName,
    relSkillsDir: record.relSkillsDir,
    dir: record.dir,
    agents: record.agents,
    status: declaredNames.has(record.dirName) ? 'managed' : 'unmanaged',
    ...(record.name !== undefined ? { skillName: record.name } : {}),
  }));

  const unmanaged = entries.filter((e) => e.status === 'unmanaged').length;

  return {
    home,
    total: entries.length,
    unmanaged,
    entries,
  };
}
