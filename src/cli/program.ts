import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerAuditCommand } from './commands/audit.ts';
import { registerCiCommand } from './commands/ci.ts';
import { registerDiffCommand } from './commands/diff.ts';
import { registerDoctorCommand } from './commands/doctor.ts';
import { registerDriftCommand } from './commands/drift.ts';
import { registerExportCommand } from './commands/export.ts';
import { registerImportCommand } from './commands/import.ts';
import { registerInitCommand } from './commands/init.ts';
import { registerInstallCommand } from './commands/install.ts';
import { registerLintCommand } from './commands/lint.ts';
import { registerLockCommand } from './commands/lock.ts';
import { registerPacksCommand } from './commands/packs.ts';
import { registerRemoveCommand } from './commands/remove.ts';
import { registerRestoreCommand } from './commands/restore.ts';
import { registerScanCommand } from './commands/scan.ts';
import { registerStatsCommand } from './commands/stats.ts';
import { registerStatusCommand } from './commands/status.ts';
import { registerSyncCommand } from './commands/sync.ts';
import { registerToggleCommand } from './commands/toggle.ts';
import { registerUninstallCommand } from './commands/uninstall.ts';
import { registerWatchCommand } from './commands/watch.ts';

// 同步读取本包版本号供 commander `.version()` 用(commander 需同步字符串)。
// SEA 打包后 package.json 可能不可达——失败回退 'unknown',绝不抛。
function readCliVersion(): string {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// 快速上手示例块:拼在帮助末尾,帮用户跳过"看了半天不知从哪开始"困境。
// 注意缩进用 4 空格:cli-help.test 的 cliCommands() 正则 /^\s{2}([a-z][a-z-]*)/ 匹配
// 恰好 2 空格开头的行作为子命令名;4 空格开头的示例行不会被误识别为命令。
const QUICK_START = `
QUICK START (快速上手):
    skill-switch status                    # 先看现状:装了什么、健不健康
    skill-switch scan                      # 盘点磁盘上各工具已装的 skill
    skill-switch audit --configs           # 安全体检(含 ~/.claude 等配置文件)
    skill-switch packs suggest             # 根据对话用法推荐套餐
    skill-switch --home /tmp/sandbox <cmd> # 用假目录演练,不碰真实配置

COMMAND GROUPS (命令分组):
  盘点       status  scan  stats  watch
  安全       audit  lint  ci
  治理       init  sync  toggle  install  remove  restore  diff  drift  doctor
  锁与声明   lock  export  import
  套餐       packs
  其他       uninstall
`;

export function buildProgram(): Command {
  const program = new Command('skill-switch');
  program
    .description('跨 Agent skill 治理工具(治理层,与各家 CRUD 工具共存分工)')
    .version(readCliVersion(), '-V, --version', '输出版本号')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home;测试与演练请指向假目录)')
    .addHelpText('after', QUICK_START);

  registerStatusCommand(program);
  registerScanCommand(program);
  registerInitCommand(program);
  registerAuditCommand(program);
  registerCiCommand(program);
  registerInstallCommand(program);
  registerToggleCommand(program);
  registerSyncCommand(program);
  registerRemoveCommand(program);
  registerRestoreCommand(program);
  registerLintCommand(program);
  registerDoctorCommand(program);
  registerDiffCommand(program);
  registerDriftCommand(program);
  registerStatsCommand(program);
  registerPacksCommand(program);
  registerLockCommand(program);
  registerExportCommand(program);
  registerImportCommand(program);
  registerUninstallCommand(program);
  registerWatchCommand(program);

  return program;
}
