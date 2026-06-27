// S9.0 status 子命令:一眼看现状。纯只读,适合首次上手或快速确认环境。
// 输出:技能总数、启用/停用、agent 列表、声明+锁健康度一行。
// --json 输出完整 StatusSummary 对象,形状稳定(只追加,不改字段)。
import type { Command } from 'commander';
import { resolveHomeRoot } from '../../core/paths.ts';
import { buildStatus } from '../../core/status.ts';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('一眼看现状:技能总数、agent、声明/锁健康(只读,首次上手先跑这个)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--json', '机器可读 JSON 输出')
    .action(async (options: { home?: string; json?: boolean }, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
      const summary = await buildStatus(home);

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      // 人类可读输出
      const agentsStr = summary.agents.length > 0 ? summary.agents.join('、') : '(无)';
      const healthIcon = summary.health === 'ok' ? '✓' : '✗';

      console.log(`技能  磁盘 ${summary.onDisk} 个  /  声明 ${summary.declared} 项(启用 ${summary.enabled},停用 ${summary.disabled})`);
      console.log(`锁    ${summary.hasLock ? `${summary.locked} 条` : '无 skills.lock'}`);
      console.log(`Agent ${agentsStr}`);
      console.log(`健康  ${healthIcon} ${summary.healthDetail}`);

      // 空状态提示
      if (summary.onDisk === 0 && !summary.hasDeclaration) {
        console.log('');
        console.log('提示:还没安装任何 skill —— 试试 `skill-switch install <source>` 或 `skill-switch packs suggest`');
      }
    });
}
