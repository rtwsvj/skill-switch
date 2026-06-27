// mcp 子命令:把 skill-switch 跑成 MCP server(stdio),让 Cursor / Claude Code 等 agent
// 实时调用它的只读审计工具(scan / status / audit)。零依赖手写 MCP(JSON-RPC 2.0)。
//
// 注意:stdout 是 MCP 协议通道,本命令的任何人类可读输出一律走 stderr,绝不写 stdout。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { MCP_PROTOCOL_VERSION, MCP_TOOLS, runMcpStdioServer } from '../../mcp/server.ts';

function readVersion(): string {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description(
      '把 skill-switch 跑成 MCP server(stdio):让 Cursor / Claude Code 等 agent 实时调用只读审计工具(scan/status/audit)',
    )
    .option('--list-tools', '只打印暴露的 MCP 工具清单(到 stderr)后退出,不启动服务')
    .action(async (options: { listTools?: boolean }) => {
      const version = readVersion();

      if (options.listTools) {
        process.stderr.write(`skill-switch MCP server v${version} —— 暴露 ${MCP_TOOLS.length} 个只读工具:\n`);
        for (const t of MCP_TOOLS) {
          process.stderr.write(`  • ${t.name}\n      ${t.description}\n`);
        }
        return;
      }

      // 启动横幅走 stderr(stdout 留给协议)。
      process.stderr.write(
        `skill-switch MCP server v${version}(协议 ${MCP_PROTOCOL_VERSION})已就绪,等待 stdio…\n`,
      );
      await runMcpStdioServer(version);
    });
}
