// 路径解析唯一入口:真实 agent 配置目录只读纪律的代码层保障。
// 自有代码一律经本模块解析目录;src/ 下其余文件直接调用 homedir() 会被
// tests/paths.test.ts 的静态断言拒绝(vendor 快照除外)。
//
// vendor 的 agents.ts 在模块加载时用 homedir() 预计算了各 agent 的
// globalSkillsDir 绝对路径。这里捕获同一时刻的 home,把这些绝对路径还原成
// "相对 home 的目录约定",从而支持把任意根(--home、fixtures)注入解析。
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { agents } from '../vendor/vercel-skills/agents.ts';
import type { AgentType } from '../vendor/vercel-skills/types.ts';

const loadTimeHome = homedir();

export interface AgentSkillsLocation {
  agent: AgentType;
  /** 相对 home 根的全局 skills 目录约定,如 `.claude/skills` */
  relGlobalSkillsDir: string;
}

/** home 根解析:CLI 的全局 `--home <dir>` 覆盖,缺省取 os.homedir()。 */
export function resolveHomeRoot(homeOverride?: string): string {
  return homeOverride ?? loadTimeHome;
}

let cachedLocations: AgentSkillsLocation[] | undefined;

/**
 * 从 vendor 映射推导全部 agent 的 home 相对全局 skills 目录。
 * 不在 home 之下的目录被跳过(如 CODEX_HOME/CLAUDE_CONFIG_DIR 指向外部路径,
 * 或 Windows 专属 APPDATA 路径)——已知局限,记录于 S1.2 改动记录。
 */
export function getAgentSkillsLocations(): AgentSkillsLocation[] {
  if (!cachedLocations) {
    const locations: AgentSkillsLocation[] = [];
    for (const [agent, config] of Object.entries(agents)) {
      if (!config.globalSkillsDir) continue;
      const rel = relative(loadTimeHome, config.globalSkillsDir);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
      locations.push({ agent: agent as AgentType, relGlobalSkillsDir: rel });
    }
    cachedLocations = locations;
  }
  return cachedLocations;
}

/** 把某个 agent 的目录约定落到给定 home 根上。 */
export function resolveGlobalSkillsDir(home: string, location: AgentSkillsLocation): string {
  return join(home, location.relGlobalSkillsDir);
}
