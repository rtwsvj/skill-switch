// S9.0 status 核心:一眼看现状——技能数、agent、声明/锁健康度。纯只读。
// 复用 scanHome(磁盘事实)+ readDeclaration(声明)+ readSkillsLock(锁)三路读取,
// 不重复任何写逻辑,不调 doctor 全量(避免哈希计算)——只做字段聚合。
import { existsSync } from 'node:fs';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { scanHome } from './scan.ts';
import { getSkillsJsonPath, readDeclaration } from './sync.ts';
import { getSkillsLockPath, readSkillsLock } from './lock.ts';

export interface StatusSummary {
  /** skills.json 是否存在 */
  hasDeclaration: boolean;
  /** skills.lock.json 是否存在 */
  hasLock: boolean;
  /** 磁盘上发现的 skill 数(含跨 agent 去重) */
  onDisk: number;
  /** 声明中的 skill 总条数 */
  declared: number;
  /** 声明中 enabled=true 的条数 */
  enabled: number;
  /** 声明中 enabled=false 的条数 */
  disabled: number;
  /** 锁内条目数 */
  locked: number;
  /** 磁盘上发现的 agent 列表(去重、排序) */
  agents: AgentType[];
  /** 简单健康一行:ok / no-declaration / drifted */
  health: 'ok' | 'no-declaration' | 'drifted';
  /** 人类可读健康说明(单行) */
  healthDetail: string;
}

export async function buildStatus(home: string, _env?: Record<string, string>): Promise<StatusSummary> {
  // 磁盘盘点(按 agent 去重——dirName 相同、跨 agent 共享的只计一次)
  const records = await scanHome(home);
  const uniqueDirNames = new Set(records.map((r) => r.dirName));
  const onDisk = uniqueDirNames.size;

  // 收集 agent 列表
  const agentSet = new Set<AgentType>();
  for (const r of records) {
    for (const a of r.agents) agentSet.add(a);
  }
  const agents = [...agentSet].sort();

  // 声明
  const skillsJsonPath = getSkillsJsonPath(home);
  const hasDeclaration = existsSync(skillsJsonPath);

  let declared = 0;
  let enabled = 0;
  let disabled = 0;
  if (hasDeclaration) {
    const decl = await readDeclaration(skillsJsonPath);
    declared = decl.skills.length;
    enabled = decl.skills.filter((s) => s.enabled).length;
    disabled = decl.skills.filter((s) => !s.enabled).length;
  }

  // 锁
  const lockPath = getSkillsLockPath(home);
  const hasLock = existsSync(lockPath);
  let locked = 0;
  if (hasLock) {
    const lockData = await readSkillsLock(lockPath);
    locked = lockData.skills.length;
  }

  // 健康判断:简单三态(不跑完整 doctor 哈希)
  let health: StatusSummary['health'];
  let healthDetail: string;

  if (!hasDeclaration && onDisk === 0) {
    health = 'no-declaration';
    healthDetail = '尚未初始化 —— 跑 `skill-switch init` 生成声明';
  } else if (!hasDeclaration) {
    health = 'no-declaration';
    healthDetail = `磁盘发现 ${onDisk} 个 skill,但无 skills.json —— 跑 \`skill-switch init\` 生成声明`;
  } else if (hasDeclaration && hasLock && enabled > locked) {
    health = 'drifted';
    healthDetail = `声明 enabled=${enabled} 项但锁只有 ${locked} 条 —— 跑 \`skill-switch doctor\` 核查`;
  } else {
    health = 'ok';
    healthDetail = `声明 ${declared} 项(启用 ${enabled})、锁 ${locked} 条、磁盘 ${onDisk} 个 —— 状态正常`;
  }

  return { hasDeclaration, hasLock, onDisk, declared, enabled, disabled, locked, agents, health, healthDetail };
}
