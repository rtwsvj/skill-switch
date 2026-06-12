// S7.1 drift 子命令:以 skills.lock 为基线的三方漂移报告。纯读,不改退出码语义
//(报告型命令;要在 CI 拦截用 doctor --ci,要修复用 install/sync)。
import type { Command } from 'commander';
import { checkDrift } from '../../core/drift.ts';
import { resolveHomeRoot } from '../../core/paths.ts';

export function registerDriftCommand(program: Command): void {
  program
    .command('drift')
    .description('上游 HEAD / 锁定 commit / 本地内容 三方漂移 diff(纯读报告)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--json', '机器可读 JSON 输出')
    .action(async (options: { home?: string; json?: boolean }, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
      const entries = await checkDrift(home);

      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log('锁为空,无可比对的 skill。');
        return;
      }
      for (const e of entries) {
        console.log(`[${e.state}] ${e.agent}/${e.name}  ${e.detail}`);
      }
    });
}
