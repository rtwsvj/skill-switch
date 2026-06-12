// S8.2 stats 子命令:transcript 使用统计与僵尸 skill 报告。纯只读
//(真实 ~/.claude/projects 只被读取,绝无写动作)。
import type { Command } from 'commander';
import { resolveHomeRoot } from '../../core/paths.ts';
import { buildStats } from '../../core/stats.ts';

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('skill 触发统计 + 僵尸清单(已装零触发,白占常驻 metadata)')
    .option('--days <n>', '只统计最近 N 天(无时间戳的触发将被排除)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--json', '机器可读 JSON 输出')
    .action(async (options: { days?: string; home?: string; json?: boolean }, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
      const days = options.days !== undefined ? Number(options.days) : undefined;
      if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
        throw new Error(`--days 需要正数,收到: ${options.days}`);
      }
      const report = await buildStats(home, days);

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(
        `扫描 ${report.scannedFiles} 个 transcript,${report.invocations} 次 skill 触发` +
          (report.since ? `(自 ${report.since.slice(0, 10)})` : ''),
      );
      for (const u of report.usage) {
        console.log(`  ${String(u.count).padStart(4)}×  ${u.skill}${u.lastUsed ? `  最近 ${u.lastUsed.slice(0, 10)}` : ''}`);
      }
      if (report.zombies.length > 0) {
        console.log(`僵尸 skill(已装零触发,各占 ≈100 tokens 常驻):`);
        for (const z of report.zombies) console.log(`  ✗ ${z.name}  (${z.relSkillsDir})`);
      } else {
        console.log('无僵尸 skill。');
      }
    });
}
