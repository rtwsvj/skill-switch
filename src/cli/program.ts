import { Command } from 'commander';
import { registerAuditCommand } from './commands/audit.ts';
import { registerDoctorCommand } from './commands/doctor.ts';
import { registerDriftCommand } from './commands/drift.ts';
import { registerInstallCommand } from './commands/install.ts';
import { registerLintCommand } from './commands/lint.ts';
import { registerLockCommand } from './commands/lock.ts';
import { registerRemoveCommand } from './commands/remove.ts';
import { registerScanCommand } from './commands/scan.ts';
import { registerStatsCommand } from './commands/stats.ts';
import { registerSyncCommand } from './commands/sync.ts';
import { registerToggleCommand } from './commands/toggle.ts';

export function buildProgram(): Command {
  const program = new Command('skill-switch');
  program
    .description('跨 Agent skill 治理工具(治理层,与各家 CRUD 工具共存分工)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home;测试与演练请指向假目录)');

  registerScanCommand(program);
  registerAuditCommand(program);
  registerInstallCommand(program);
  registerToggleCommand(program);
  registerSyncCommand(program);
  registerRemoveCommand(program);
  registerLintCommand(program);
  registerDoctorCommand(program);
  registerDriftCommand(program);
  registerStatsCommand(program);
  registerLockCommand(program);

  return program;
}
