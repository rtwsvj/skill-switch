// D2:`diff <name>` —— 显示内容漂移的技能「改了哪些文件」(磁盘 vs store 耐久副本)。
// 纯只读。--agent 限定单个 agent;省略则对所有该技能在磁盘上的 agent 各对比一次。
import type { Command } from 'commander';
import { diffSkill, type SkillDiff } from '../../core/skill-diff.ts';
import { getAgentSkillsLocations, resolveHomeRoot } from '../../core/paths.ts';
import type { AgentType } from '../../vendor/vercel-skills/types.ts';

function statusLabel(status: string): string {
  return status === 'added' ? '新增' : status === 'removed' ? '删除' : '改动';
}

function formatDiff(diff: SkillDiff): string {
  const head = `${diff.agent}/${diff.name}`;
  if (!diff.comparable) return `  ${head}: 无法对比(${diff.reason ?? '未知'})`;
  if (diff.files.length === 0) return `  ${head}: 与安装时一致,无改动`;
  const lines = [`  ${head}: ${diff.files.length} 处改动`];
  for (const file of diff.files) lines.push(`    [${statusLabel(file.status)}] ${file.path}`);
  return lines.join('\n');
}

export function registerDiffCommand(program: Command): void {
  program
    .command('diff <name>')
    .description('显示某技能相对安装时(store 副本)改了哪些文件 —— 内容漂移的「改了什么」')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--agent <agent>', '只看某个 agent(省略则看全部)')
    .option('--json', '机器可读 JSON 输出')
    .action(async (name: string, options: { home?: string; agent?: string; json?: boolean }, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
      const agents: AgentType[] = options.agent
        ? [options.agent as AgentType]
        : getAgentSkillsLocations().map((l) => l.agent);

      const diffs: SkillDiff[] = [];
      for (const agent of agents) {
        const diff = await diffSkill(home, agent, name);
        // 省略 --agent 时,只保留磁盘上确实存在该技能的 agent(diskDir 已解析或有可比文件)。
        if (options.agent || diff.comparable || diff.reason !== '磁盘上找不到该技能目录') {
          diffs.push(diff);
        }
      }

      if (options.json) {
        console.log(JSON.stringify({ name, diffs }, null, 2));
        return;
      }

      if (diffs.length === 0) {
        console.log(`未在任何 agent 的磁盘上找到技能「${name}」。`);
        return;
      }
      console.log(`技能「${name}」改动:`);
      for (const diff of diffs) console.log(formatDiff(diff));
    });
}
