// D2:`diff <name>` —— 显示内容漂移的技能「改了哪些文件」(磁盘 vs store 耐久副本)。
// 纯只读。--agent 限定单个 agent;省略则对所有该技能在磁盘上的 agent 各对比一次。
// --format text (默认) 显示每文件摘要;--format unified 输出标准 unified diff。
import type { Command } from 'commander';
import {
  buildUnifiedDiffText,
  diffSkillWithContents,
  type SkillDiff,
} from '../../core/skill-diff.ts';
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
    .option('--format <format>', '输出格式:text(默认摘要) 或 unified(标准 unified diff)', 'text')
    .action(
      async (
        name: string,
        options: { home?: string; agent?: string; json?: boolean; format?: string },
        command: Command,
      ) => {
        const format = options.format ?? 'text';
        if (format !== 'text' && format !== 'unified') {
          console.error(`错误: --format 只接受 "text" 或 "unified",收到: "${format}"`);
          process.exit(1);
        }

        const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
        const agents: AgentType[] = options.agent
          ? [options.agent as AgentType]
          : getAgentSkillsLocations().map((l) => l.agent);

        const results: Array<{
          diff: SkillDiff;
          diskFiles: Map<string, Buffer>;
          storeFiles: Map<string, Buffer>;
        }> = [];

        for (const agent of agents) {
          const result = await diffSkillWithContents(home, agent, name);
          // 省略 --agent 时,只保留磁盘上确实存在该技能的 agent。
          if (
            options.agent ||
            result.diff.comparable ||
            result.diff.reason !== '磁盘上找不到该技能目录'
          ) {
            results.push(result);
          }
        }

        const diffs = results.map((r) => r.diff);

        if (options.json) {
          if (format === 'unified') {
            // Include unified diff text per agent entry in JSON output
            const withUnified = diffs.map((diff, i) => {
              const r = results[i]!;
              const unifiedText = diff.comparable
                ? buildUnifiedDiffText(diff, r.diskFiles, r.storeFiles)
                : null;
              return { ...diff, unifiedDiff: unifiedText };
            });
            console.log(JSON.stringify({ name, format: 'unified', diffs: withUnified }, null, 2));
          } else {
            console.log(JSON.stringify({ name, diffs }, null, 2));
          }
          return;
        }

        if (diffs.length === 0) {
          console.log(`未在任何 agent 的磁盘上找到技能「${name}」。`);
          return;
        }

        if (format === 'unified') {
          for (const r of results) {
            const { diff } = r;
            const head = `${diff.agent}/${diff.name}`;
            if (!diff.comparable) {
              console.log(`# ${head}: 无法对比(${diff.reason ?? '未知'})`);
              continue;
            }
            if (diff.files.length === 0) {
              console.log(`# ${head}: 与安装时一致,无改动`);
              continue;
            }
            const patch = buildUnifiedDiffText(diff, r.diskFiles, r.storeFiles);
            if (patch) console.log(patch);
          }
        } else {
          // Default text format (unchanged behavior)
          console.log(`技能「${name}」改动:`);
          for (const diff of diffs) console.log(formatDiff(diff));
        }
      },
    );
}
