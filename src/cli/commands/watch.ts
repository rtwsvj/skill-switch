// W7-a watch 子命令:检出绕过治理层(磁盘在位但不在声明中)的 skill。纯读。
// --once    单次扫盘后退出 exit 0(供测试/CI 使用;默认行为是扫一次后继续 watch 文件系统)
// --json    机器可读 JSON 输出
// --home    覆盖 home 根目录
//
// 架构:live-watch 是一层极薄的 fs.watch 封装,核心逻辑全在 runWatchScan() 里;
// --once 直接调 runWatchScan() + 退出,保证测试的确定性。
import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { Command } from 'commander';
import { getAgentSkillsLocations, resolveGlobalSkillsDir, resolveHomeRoot } from '../../core/paths.ts';
import { runWatchScan, type WatchReport } from '../../core/watch.ts';

function formatReport(report: WatchReport): string {
  const lines: string[] = [
    `home: ${report.home}`,
    `共 ${report.total} 个 skill,其中 ${report.unmanaged} 个未受治理层管控。`,
  ];

  if (report.entries.length === 0) {
    lines.push('  (未发现任何 skill)');
    return lines.join('\n');
  }

  for (const entry of report.entries) {
    const label = entry.status === 'unmanaged' ? '[未托管]' : '[已托管]';
    const display = entry.skillName ? `${entry.name} (${entry.skillName})` : entry.name;
    lines.push(`  ${label} ${entry.relSkillsDir}/${display}`);
  }

  return lines.join('\n');
}

async function ensureWatchDirs(home: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const location of getAgentSkillsLocations()) {
    const dir = resolveGlobalSkillsDir(home, location);
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      // 创建失败时仍尝试 watch(目录可能已存在或无权创建)
    }
    dirs.push(dir);
  }
  // 去重(多个 agent 可能共享同一个 skills 目录)
  return [...new Set(dirs)];
}

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('检出磁盘上绕过治理层的 skill(不在声明中但在磁盘上);默认持续监视')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--once', '单次扫盘后退出(exit 0;供测试/CI 使用)')
    .option('--json', '机器可读 JSON 输出')
    .action(async (options: { home?: string; once?: boolean; json?: boolean }, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);

      // 单次扫盘 + 输出
      async function doScan(label?: string): Promise<WatchReport> {
        const report = await runWatchScan(home);
        const prefix = label ? `[${label}] ` : '';
        if (options.json) {
          console.log(JSON.stringify({ ...report, timestamp: new Date().toISOString() }, null, 2));
        } else {
          if (label) {
            console.log(`\n${prefix}检测到变更,重新扫盘:`);
          }
          console.log(formatReport(report));
        }
        return report;
      }

      // 初始扫盘
      await doScan();

      // --once:直接退出
      if (options.once) return;

      // 持续 watch:监视各 agent 的 skills 目录,变化时重新扫盘
      if (!options.json) {
        console.log('\n正在监视 skill 目录变化(Ctrl+C 退出)...');
      }

      const dirs = await ensureWatchDirs(home);

      // 防抖:短时间内多次触发只扫一次
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      for (const dir of dirs) {
        try {
          watch(dir, { recursive: true }, (_event, filename) => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              debounceTimer = null;
              doScan(filename ?? dir).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`错误: 重新扫盘失败: ${msg}\n`);
              });
            }, 200);
          });
        } catch {
          // watch 失败(目录不存在)不致命,初始扫盘已完成
        }
      }

      // 保持进程存活直到 SIGINT
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          if (!options.json) console.log('\n已停止监视。');
          resolve();
        });
      });
    });
}
