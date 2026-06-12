// F9 remove 子命令:一致性拆除磁盘产物 + lock + declaration。
import type { Command } from 'commander';
import type { AgentType } from '../../vendor/vercel-skills/types.ts';
import { removeSkill } from '../../core/remove.ts';
import { resolveHomeRoot } from '../../core/paths.ts';

interface RemoveCliOptions {
  agent: string;
  home?: string;
  json?: boolean;
}

export function registerRemoveCommand(program: Command): void {
  program
    .command('remove')
    .description('一致性拆除 skill:删除磁盘产物、锁条目与声明 agent')
    .argument('<skill>', 'skill 名')
    .requiredOption('--agent <agent>', '目标 agent(如 claude-code、gemini-cli)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--json', '机器可读 JSON 输出')
    .action(async (skill: string, options: RemoveCliOptions, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
      const result = await removeSkill(home, skill, options.agent as AgentType);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`✓ removed ${result.agent}/${result.name}`);
      console.log(`  target: ${result.targetPath}`);
      console.log(`  锁: ${result.lockPath}`);
      console.log(`  声明: ${result.declarationPath}`);
      for (const snapshot of result.snapshots) console.log(`  快照: ${snapshot.path}`);
    });
}
