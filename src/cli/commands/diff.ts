// D2:`diff <name>` —— 显示内容漂移的技能「改了哪些文件」(磁盘 vs store 耐久副本)。
// 纯只读。--agent 限定单个 agent;省略则对所有该技能在磁盘上的 agent 各对比一次。
// --format text (默认) 显示每文件摘要;--format unified 输出标准 unified diff。
// DF-diff-narrative:在文字输出顶部追加一行叙述摘要;--json 中追加 narrative 字段(纯加字段,不改现有结构)。
import type { Command } from 'commander';
import {
  buildUnifiedDiffText,
  diffSkillWithContents,
  type SkillDiff,
} from '../../core/skill-diff.ts';
import {
  bufferMapToStringMap,
  computeLineCounts,
  summarizeDiff,
  type DiffNarrative,
} from '../../core/diff-narrative.ts';
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
          throw new Error(`--format 只接受 "text" 或 "unified",收到: "${format}"`);
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

        // ── 叙述摘要:汇总所有 comparable agent 的改动行数 + 安全信号 ──────────────
        // 只在至少一个 agent 可对比时才计算;若全不可对比则跳过(无内容可分析)。
        const comparableResults = results.filter((r) => r.diff.comparable);
        let narrative: DiffNarrative | null = null;
        if (comparableResults.length > 0) {
          // 合并所有 agent 的 disk/store 文件 Map
          const mergedDisk = new Map<string, Buffer>();
          const mergedStore = new Map<string, Buffer>();
          let totalFilesChanged = 0;
          for (const r of comparableResults) {
            totalFilesChanged += r.diff.files.length;
            for (const [p, buf] of r.diskFiles) mergedDisk.set(p, buf);
            for (const [p, buf] of r.storeFiles) mergedStore.set(p, buf);
          }
          const { linesAdded, linesRemoved } = computeLineCounts(mergedDisk, mergedStore);
          narrative = summarizeDiff({
            filesChanged: totalFilesChanged,
            linesAdded,
            linesRemoved,
            afterContents: bufferMapToStringMap(mergedDisk),
            beforeContents: bufferMapToStringMap(mergedStore),
          });
        }

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
            // narrative 作为附加字段;不改变 diffs 数组结构
            console.log(JSON.stringify({ name, format: 'unified', diffs: withUnified, ...(narrative ? { narrative } : {}) }, null, 2));
          } else {
            // narrative 作为附加字段;name/diffs 键顺序不变
            console.log(JSON.stringify({ name, diffs, ...(narrative ? { narrative } : {}) }, null, 2));
          }
          return;
        }

        if (diffs.length === 0) {
          console.log(`未在任何 agent 的磁盘上找到技能「${name}」。`);
          return;
        }

        // 叙述摘要行:在所有具体文件改动条目之前打印
        if (narrative) {
          console.log(narrative.summary);
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
