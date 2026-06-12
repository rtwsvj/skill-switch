// S6.2 doctor 子命令:三方校验(S6.1 核心)的 CLI 包装。
// --ci:漂移即 exit 1(skills.lock 进流水线的价值兑现点);默认模式只报告不改退出码。
import type { Command } from 'commander';
import { runDoctor } from '../../core/doctor.ts';
import { resolveHomeRoot } from '../../core/paths.ts';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('声明/锁/磁盘三方一致性校验(--ci 模式漂移即 exit 1)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--ci', '漂移时以非零退出(供 CI 使用)')
    .option('--json', '机器可读 JSON 输出')
    .action(async (options: { home?: string; ci?: boolean; json?: boolean }, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
      const report = await runDoctor(home);

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else if (report.clean) {
        console.log(`✓ 三方一致(声明 ${report.checked.declared} 项,锁 ${report.checked.locked} 条)`);
      } else {
        console.log(`✗ 检出 ${report.findings.length} 处漂移:`);
        for (const f of report.findings) {
          console.log(`  [${f.kind}] ${f.agent}/${f.name}${f.target ? `  ${f.target}` : ''}`);
          console.log(`    ${f.detail}`);
        }
      }

      if (options.ci && !report.clean) process.exitCode = 1;
    });
}
