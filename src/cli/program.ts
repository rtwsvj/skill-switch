import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerAddCommand } from './commands/add.ts';
import { registerAuditCommand } from './commands/audit.ts';
import { registerCiCommand } from './commands/ci.ts';
import { registerExplainCommand } from './commands/explain.ts';
import { registerDiffCommand } from './commands/diff.ts';
import { registerDoctorCommand } from './commands/doctor.ts';
import { registerDriftCommand } from './commands/drift.ts';
import { registerExportCommand } from './commands/export.ts';
import { registerImportCommand } from './commands/import.ts';
import { registerInitCommand } from './commands/init.ts';
import { registerInstallCommand } from './commands/install.ts';
import { registerLintCommand } from './commands/lint.ts';
import { registerLockCommand } from './commands/lock.ts';
import { registerMcpCommand } from './commands/mcp.ts';
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
import { registerCompletionCommand } from './commands/completion.ts';
import { registerApmImportCommand } from './commands/apm-import.ts';

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
// Commander 15 已用 .helpGroup() 原生分组取代手写"COMMAND GROUPS"段落;
// 这里只保留 QUICK START 示例块。
const QUICK_START = `
QUICK START (快速上手):
    skill-switch status                    # 先看现状:装了什么、健不健康
    skill-switch scan                      # 盘点磁盘上各工具已装的 skill
    skill-switch audit --configs           # 安全体检(含 ~/.claude 等配置文件)
    skill-switch packs suggest             # 根据对话用法推荐套餐
    skill-switch add <github链接|安装指令>  # 粘链接/指令 → 自动审计后安装
    skill-switch --home /tmp/sandbox <cmd> # 用假目录演练,不碰真实配置
`;

export function buildProgram(): Command {
  const program = new Command('skill-switch');
  program
    .description('跨 Agent skill 治理工具(治理层,与各家 CRUD 工具共存分工)')
    .version(readCliVersion(), '-V, --version', '输出版本号')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home;测试与演练请指向假目录)')
    .addHelpText('after', QUICK_START);

  // ── 盘点 ──────────────────────────────────────────────────────────────────
  // 只读命令:看现状、盘清单、跑统计、持续监视。
  registerStatusCommand(program);
  program.commands.at(-1)?.helpGroup('盘点');
  registerScanCommand(program);
  program.commands.at(-1)?.helpGroup('盘点');
  registerStatsCommand(program);
  program.commands.at(-1)?.helpGroup('盘点');
  registerWatchCommand(program);
  program.commands.at(-1)?.helpGroup('盘点');

  // ── 安全 ──────────────────────────────────────────────────────────────────
  // 审计、校验、解释、CI 门控。
  registerAuditCommand(program);
  program.commands.at(-1)?.helpGroup('安全');
  registerLintCommand(program);
  program.commands.at(-1)?.helpGroup('安全');
  registerCiCommand(program);
  program.commands.at(-1)?.helpGroup('安全');
  registerExplainCommand(program);
  program.commands.at(-1)?.helpGroup('安全');

  // ── 治理 ──────────────────────────────────────────────────────────────────
  // 写操作:先快照再动手,全部可回滚。
  registerAddCommand(program);
  program.commands.at(-1)?.helpGroup('治理');
  registerInitCommand(program);
  program.commands.at(-1)?.helpGroup('治理');
  registerSyncCommand(program);
  program.commands.at(-1)?.helpGroup('治理');
  registerToggleCommand(program);
  program.commands.at(-1)?.helpGroup('治理');
  registerInstallCommand(program);
  program.commands.at(-1)?.helpGroup('治理');
  registerRemoveCommand(program);
  program.commands.at(-1)?.helpGroup('治理');
  registerRestoreCommand(program);
  program.commands.at(-1)?.helpGroup('治理');
  registerDiffCommand(program);
  program.commands.at(-1)?.helpGroup('治理');
  registerDriftCommand(program);
  program.commands.at(-1)?.helpGroup('治理');
  registerDoctorCommand(program);
  program.commands.at(-1)?.helpGroup('治理');

  // ── 锁与声明 ──────────────────────────────────────────────────────────────
  // 查锁、打包声明、恢复声明。
  registerLockCommand(program);
  program.commands.at(-1)?.helpGroup('锁与声明');
  registerExportCommand(program);
  program.commands.at(-1)?.helpGroup('锁与声明');
  registerImportCommand(program);
  program.commands.at(-1)?.helpGroup('锁与声明');

  // ── 套餐 ──────────────────────────────────────────────────────────────────
  registerPacksCommand(program);
  program.commands.at(-1)?.helpGroup('套餐');

  // ── 集成 / 其他 ───────────────────────────────────────────────────────────
  registerMcpCommand(program);
  program.commands.at(-1)?.helpGroup('集成');
  registerApmImportCommand(program);
  program.commands.at(-1)?.helpGroup('集成');
  registerCompletionCommand(program);
  program.commands.at(-1)?.helpGroup('集成');
  registerUninstallCommand(program);
  program.commands.at(-1)?.helpGroup('集成');

  return program;
}
