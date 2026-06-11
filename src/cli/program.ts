import { Command } from 'commander';
import { registerAuditCommand } from './commands/audit.ts';
import { registerScanCommand } from './commands/scan.ts';

interface SubcommandSpec {
  name: string;
  description: string;
}

// 未实现的子命令占位,与 docs/ROADMAP.md 切片一一对应,实现随切片落地后移出此表。
const SUBCOMMANDS: SubcommandSpec[] = [
  { name: 'install', description: '安装 skill 并写入 skills.lock(S3)' },
  { name: 'lock', description: '查看/重建项目级 skills.lock(S3)' },
  { name: 'toggle', description: '按声明开关 skill 与 preset 同步(S4)' },
  { name: 'lint', description: '规范校验与跨 agent 移植告警(S5)' },
  { name: 'doctor', description: '声明/锁/磁盘三方一致性校验,支持 --ci(S6)' },
  { name: 'drift', description: '上游/锁/本地三方漂移 diff(S7)' },
  { name: 'stats', description: 'transcript 使用统计与僵尸 skill 报告(S8)' },
];

export function buildProgram(): Command {
  const program = new Command('skill-switch');
  program
    .description('跨 Agent skill 治理工具(治理层,与各家 CRUD 工具共存分工)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home;测试与演练请指向假目录)');

  registerScanCommand(program);
  registerAuditCommand(program);

  for (const spec of SUBCOMMANDS) {
    program
      .command(spec.name)
      .description(spec.description)
      .action(() => {
        console.log(`skill-switch ${spec.name}: 尚未实现,进度见 docs/ROADMAP.md`);
        process.exitCode = 1;
      });
  }

  return program;
}
