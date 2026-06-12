// S4.3 toggle 子命令:--on/--off 二选一,写目标由 --home 决定。
import type { Command } from 'commander';
import { resolveHomeRoot } from '../../core/paths.ts';
import { toggleSkill } from '../../core/toggle.ts';

interface ToggleCliOptions {
  on?: boolean;
  off?: boolean;
  home?: string;
  json?: boolean;
}

export function registerToggleCommand(program: Command): void {
  program
    .command('toggle')
    .description('按声明开关 skill(sync 前自动快照;codex 走 config.toml 原生开关)')
    .argument('<skill>', '声明(skills.json)中的 skill 名')
    .option('--on', '启用')
    .option('--off', '停用')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--json', '机器可读 JSON 输出')
    .action(async (skill: string, options: ToggleCliOptions, command: Command) => {
      if (Boolean(options.on) === Boolean(options.off)) {
        throw new Error('必须且只能指定 --on 或 --off 之一');
      }
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
      const result = await toggleSkill(home, skill, Boolean(options.on));

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`${result.enabled ? '✓ 启用' : '✗ 停用'} ${result.name}`);
      for (const a of result.actions) console.log(`  [${a.kind}] ${a.agent}: ${a.target}`);
      for (const s of result.snapshots) console.log(`  快照: ${s.path}`);
    });
}
