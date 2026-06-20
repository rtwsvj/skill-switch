// 写命令共享的 agent 根目录快照逻辑。
// codex 需要保整个 .codex(含 config.toml);其余 agent 保各自 skills 目录。
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { snapshot, type SnapshotInfo } from './backup.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';

export function snapshotRoot(home: string, agent: AgentType): string | undefined {
  if (agent === 'codex') return join(home, '.codex');
  const location = getAgentSkillsLocations().find((l) => l.agent === agent);
  return location ? resolveGlobalSkillsDir(home, location) : undefined;
}

export async function snapshotAgents(
  home: string,
  agents: Iterable<AgentType>,
  label: string,
): Promise<SnapshotInfo[]> {
  const snapshots: SnapshotInfo[] = [];
  const store = join(home, '.skill-switch', 'backups');

  for (const agent of new Set(agents)) {
    const root = snapshotRoot(home, agent);
    if (!root || !existsSync(root)) continue;
    if ((await readdir(root)).length === 0) continue;
    snapshots.push(await snapshot(root, { store, label }));
  }

  return snapshots;
}

/**
 * AUDIT-SEC2:snapshot sidecar 的 `sourceDir` 是可被篡改的 JSON 字段。restore 前
 * 必须断言它落在某个受管快照根(codex 是 `.codex`,其余 agent 是各自 skills 目录),
 * 否则攻击者改 sidecar 指向任意目录(如 `~/.ssh`)即可借 restore 把攻击者控制的
 * tar 内容铺进任意目录。合法根集合与 {@link snapshotRoot} 一致,保持单一事实源。
 *
 * 比较用 `path.resolve` 归一化两边后精确匹配:消除 `.`/`..`/尾随分隔符等写法差异。
 * 不引入 `realpath`(跟随符号链接)——那会让 `~/.claude/skills` 下的恶意 symlink 反而
 * 把 `/etc` 解析成合法根,扩大攻击面。`/tmp`↔`/private/tmp` 这类真实路径别名属已知
 * 功能边界,不影响安全。
 */
function allowedRestoreTargets(home: string): string[] {
  const roots = new Set<string>();
  // codex 的快照根是整个 .codex(snapshotRoot 特例),单独纳入
  const codexRoot = snapshotRoot(home, 'codex');
  if (codexRoot) roots.add(codexRoot);
  for (const location of getAgentSkillsLocations()) {
    const root = snapshotRoot(home, location.agent);
    if (root) roots.add(root);
  }
  return [...roots];
}

export function isAllowedRestoreTarget(home: string, dir: string): boolean {
  const normalized = resolve(dir);
  return allowedRestoreTargets(home).some((root) => resolve(root) === normalized);
}
