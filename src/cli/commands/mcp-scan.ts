// S8 (roadmap 阶段 3 旗舰) `skill-switch mcp-scan`:运行时 MCP 审计 + rug-pull 基线。
//
// 安全姿态(规格铁律,任何一条违反即失败):
//   1. 绝不自动连接;无 flag 只列 server。
//   2. 逐 server 显式同意:--server <name> 单一;--all 需搭配 --yes;TTY 逐个 y/N。
//   3. stdio = 执行配置里的命令,确认提示明说"这会启动一个本地进程"。
//   4. 绝不调用 tools/call:client.ts 协议交互固定为 initialize → initialized → tools/list → 断开。
//   5. 默认 10s 超时;stdio SIGTERM→SIGKILL;http AbortController。
//   6. http:// 仅限 localhost/127.0.0.1/::1;其它必须 https。headers/env VALUE 绝不入输出/日志/基线。
//   7. 默认 report-only(exit 0);--ci 才按 critical/high finding 阻断。
//
// 退出码契约:
//   - 默认 / --json:exit 0(findings 仅打印,连接错误单独列出)
//   - --ci + 存在 critical/high finding:exit 1
//   - opt-in 门拒绝(非 TTY 无 --yes 等):exit 1 + stderr "错误: ..."
//   - 基线文件损坏:exit 1 + stderr "错误: ..."

import * as readline from 'node:readline';
import { resolveHomeRoot } from '../../core/paths.ts';
import {
  baselineKey,
  discoverMcpServers,
  type McpServerSpec,
} from '../../core/mcp-scan/discover.ts';
import {
  DEFAULT_TIMEOUT_MS,
  describeServer,
  describeStdioCommand,
} from '../../core/mcp-scan/client.ts';
import {
  reportToBaselineMap,
  scanServers,
  shouldBlockForCi,
  describeServerForList,
  type ScanReport,
  type ScanServerResult,
} from '../../core/mcp-scan/scan.ts';
import {
  McpScanBaselineError,
  mcpScanBaselinePath,
  writeMcpScanBaseline,
} from '../../core/mcp-scan/baseline.ts';

// ── opt-in 门 ────────────────────────────────────────────────────────────────

/**
 * 把"已批准扫描"的 server 列表解析出来。
 * 规则:
 *   - 既无 --server 又无 --all → 返回空数组(CLI 走 list 模式,绝不连)
 *   - --server <name> 可重复,只命中 serverKey(source::name)
 *   - --all 必须配 --yes;否则拒绝
 *   - 非 TTY 且未给 --yes:拒绝(除非明确 --server,因为 --server 已是单点同意)
 */
function resolveApproval(
  flags: { serverNames: string[]; all: boolean; yes: boolean; isTTY: boolean },
  available: McpServerSpec[],
): { approved: McpServerSpec[]; refusedReason?: string } {
  // 既无 --server 又无 --all → 不连(list 模式)
  if (flags.serverNames.length === 0 && !flags.all) {
    return { approved: [] };
  }

  // --all 但无 --yes:拒绝
  if (flags.all && !flags.yes) {
    return {
      approved: [],
      refusedReason: '--all 必须搭配 --yes(避免在非交互/CI 场景误连一批 server)',
    };
  }

  // 单点同意:--server 指名意图明确,但非 TTY(脚本/CI)下仍须 --yes 显式放行——
  // 连接 = 启动配置里的命令 / 发起网络请求,不允许在无人确认的环境里默默发生。
  // TTY 下无 --yes 会走后面的逐 server y/N 确认。
  if (flags.serverNames.length > 0) {
    if (!flags.yes && !flags.isTTY) {
      return {
        approved: [],
        refusedReason: '非交互环境(非 TTY)连接 MCP server 需要显式 --yes(连接会执行配置里的命令或发起网络请求)',
      };
    }
    const approved: McpServerSpec[] = [];
    const requested = new Set(flags.serverNames);
    const availableKeys = new Set(available.map(baselineKey));
    for (const key of flags.serverNames) {
      if (!availableKeys.has(key)) {
        return {
          approved: [],
          refusedReason: `--server "${key}" 在已发现的 server 中不存在(可省略 source 前缀试试,或先无 flag 运行查看 source::name 全名)`,
        };
      }
    }
    // 用 Set 去重:--server 重复传同一个 key 只连一次
    for (const spec of available) {
      if (requested.has(baselineKey(spec))) approved.push(spec);
    }
    return { approved };
  }

  // --all + --yes + 非 TTY:全部直接放行(--yes 已代表显式同意)
  if (flags.all && flags.yes) {
    return { approved: available };
  }

  // 兜底:不应到达
  return { approved: [], refusedReason: '未知 opt-in 状态' };
}

/**
 * TTY 下的逐 server 确认。
 * 逐条打印"这会启动一个本地进程:<command>"或"这会连接 <url>",读 y/N。
 * 拒绝的 server 从批准列表里剔除。
 */
async function confirmByReadline(servers: McpServerSpec[]): Promise<McpServerSpec[]> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  const approved: McpServerSpec[] = [];
  for (const s of servers) {
    const where = `${s.name} (${s.source})`;
    let prompt: string;
    if (s.transport === 'stdio') {
      prompt = `将启动本地进程: ${describeStdioCommand(s)}\n  这会执行 server "${where}",继续? [y/N] > `;
    } else {
      prompt = `将连接远程 endpoint: ${s.url}\n  这会联系 server "${where}",继续? [y/N] > `;
    }
    process.stdout.write(prompt);
    // eslint-disable-next-line no-await-in-loop
    const ans = (await ask('')).trim().toLowerCase();
    if (ans === 'y' || ans === 'yes') {
      approved.push(s);
    } else {
      process.stdout.write(`  → 跳过 ${where}\n`);
    }
  }
  rl.close();
  return approved;
}

// ── 输出格式化 ───────────────────────────────────────────────────────────────

/** 人类输出:每 server 一段,后跟汇总。 */
function renderHuman(report: ScanReport, wasBaselineEstablished: boolean): string {
  const lines: string[] = [];
  lines.push('mcp-scan 报告');
  lines.push(`  home:      ${report.home}`);
  lines.push(`  baseline:  ${report.baselinePath}${wasBaselineEstablished ? '  (本次扫描已建立基线)' : ''}`);
  lines.push('');

  for (const r of report.servers) {
    const serverKey = baselineKey(r.spec);
    if (!r.connected) {
      lines.push(`[${serverKey}] 连接失败: ${r.error?.code ?? 'unknown'} — ${r.error?.message ?? ''}`);
      lines.push('');
      continue;
    }
    lines.push(`[${serverKey}] protocol=${r.protocolVersion ?? 'unknown'} tools=${r.tools.length}`);
    if (r.removedTools.length > 0) {
      lines.push(`  移除的工具(基线中存在,本次未发现;不产 finding): ${r.removedTools.join(', ')}`);
    }
    if (r.findings.length === 0 && r.rugPullFindings.length === 0) {
      lines.push('  findings: 无');
    } else {
      const all = [...r.findings, ...r.rugPullFindings];
      for (const f of all) {
        lines.push(`  - [${f.severity}] ${f.ruleId}: ${f.message}`);
      }
    }
    lines.push('');
  }

  // 汇总
  lines.push('汇总');
  lines.push(`  servers:        ${report.servers.length}`);
  lines.push(`  connected:      ${report.servers.filter((s) => s.connected).length}`);
  lines.push(`  findings:       ${report.findings.length}`);
  const bySev = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of report.findings) bySev[f.severity]++;
  lines.push(`    critical:     ${bySev.critical}`);
  lines.push(`    high:         ${bySev.high}`);
  lines.push(`    medium:       ${bySev.medium}`);
  lines.push(`    low:          ${bySev.low}`);
  return lines.join('\n');
}

/** JSON 输出:稳定结构(servers[]、findings[]、baselineStatus)。 */
interface JsonOutput {
  home: string;
  baselinePath: string;
  baselineStatus: 'established' | 'compared' | 'reset' | 'missing';
  servers: Array<{
    source: string;
    name: string;
    key: string;
    transport: 'stdio' | 'http';
    connected: boolean;
    error?: { code: string; message: string };
    protocolVersion?: string;
    tools: Array<{ name: string; description: string }>;
    findings: ScanServerResult['findings'];
    rugPullFindings: ScanServerResult['rugPullFindings'];
    removedTools: string[];
  }>;
  findings: ScanReport['findings'];
}

function toJson(report: ScanReport, baselineStatus: JsonOutput['baselineStatus']): JsonOutput {
  return {
    home: report.home,
    baselinePath: report.baselinePath,
    baselineStatus,
    servers: report.servers.map((r) => {
      const spec = r.spec;
      const out: JsonOutput['servers'][number] = {
        source: spec.source,
        name: spec.name,
        key: baselineKey(spec),
        transport: spec.transport,
        connected: r.connected,
        tools: r.tools.map((t) => ({ name: t.name, description: t.description })),
        findings: r.findings,
        rugPullFindings: r.rugPullFindings,
        removedTools: r.removedTools,
      };
      if (r.error) out.error = r.error;
      if (r.protocolVersion) out.protocolVersion = r.protocolVersion;
      return out;
    }),
    findings: report.findings,
  };
}

// ── 命令注册 ────────────────────────────────────────────────────────────────

export function registerMcpScanCommand(program: import('commander').Command): void {
  program
    .command('mcp-scan')
    .description(
      '运行时 MCP 审计 + rug-pull 基线(opt-in / 逐 server 同意 / 绝不调用工具)\n' +
      '  无 flag                  只列出已发现的 server,不连接(报告模式)\n' +
      '  --server <key>           只扫描单个 server,key 形如 "<source>::<name>";可重复\n' +
      '  --all                    扫描所有已发现 server(必须搭配 --yes)\n' +
      '  --yes                    非交互模式:跳过 TTY 确认;--all 必需\n' +
      '  --timeout <ms>           每 server 超时(默认 10000;stdio 先 SIGTERM 后 SIGKILL)\n' +
      '  --reset-baseline         把本次结果覆盖写入基线(与 --server/--all 搭配)\n' +
      '  --json                   机器可读 JSON 输出\n' +
      '  --ci                     存在 critical/high finding 时 exit 1(CI 门控)',
    )
    .option('--server <key>', '只扫描指定 server(source::name),可重复', collectMulti)
    .option('--all', '扫描所有已发现 server(必须搭配 --yes)', false)
    .option('--yes', '非交互模式:跳过 TTY 确认,直接连接', false)
    .option('--timeout <ms>', '每 server 超时(毫秒)', (v: string) => {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--timeout 必须是正整数,收到: ${v}`);
      }
      return n;
    })
    .option('--reset-baseline', '把本次结果覆盖写入基线文件', false)
    .option('--json', '机器可读 JSON 输出', false)
    .option('--ci', '存在 critical/high finding 时 exit 1', false)
    .action(
      async (
        options: {
          server?: string[];
          all?: boolean;
          yes?: boolean;
          timeout?: number;
          resetBaseline?: boolean;
          json?: boolean;
          ci?: boolean;
        },
        command: import('commander').Command,
      ) => {
        const home = resolveHomeRoot(command.parent?.opts<{ home?: string }>().home);
        // commander 的 options.server 是 string[] (collector),no 走 default
        const serverNames = options.server ?? [];
        const all = options.all === true;
        const yes = options.yes === true;
        const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
        const json = options.json === true;
        const ci = options.ci === true;
        const resetBaseline = options.resetBaseline === true;

        // 1. 发现所有 server
        let servers: McpServerSpec[];
        try {
          servers = await discoverMcpServers(home);
        } catch (e) {
          process.stderr.write(`错误: ${(e as Error).message}\n`);
          process.exitCode = 1;
          return;
        }
        // 2. 决定 opt-in
        const approval = resolveApproval(
          { serverNames, all, yes, isTTY: Boolean(process.stdin.isTTY) },
          servers,
        );
        if (approval.refusedReason) {
          process.stderr.write(`错误: ${approval.refusedReason}\n`);
          process.exitCode = 1;
          return;
        }

        // 3. list 模式(无 flag):只列,绝不连
        if (approval.approved.length === 0 && serverNames.length === 0 && !all) {
          if (servers.length === 0) {
            if (json) {
              console.log(JSON.stringify({
                home,
                baselinePath: mcpScanBaselinePath(home),
                baselineStatus: 'missing',
                servers: [],
                findings: [],
                note: '未发现任何 MCP server',
              }, null, 2));
            } else {
              console.log('未发现任何 MCP server。');
              console.log('提示:在 ~/.claude/mcp.json / ~/.cursor/mcp.json / ~/.vscode/mcp.json 等位置配置 MCP server 后重试。');
            }
            return;
          }

          if (json) {
            const list = servers.map((s) => ({
              source: s.source,
              name: s.name,
              key: baselineKey(s),
              transport: s.transport,
              describe: describeServer(s),
            }));
            console.log(JSON.stringify({
              home,
              servers: list,
              note: '未连接任何 server;传 --server <key>(可重复)或 --all --yes 显式同意后才会连接',
            }, null, 2));
          } else {
            console.log(`发现 ${servers.length} 个 MCP server(未连接 — 默认安全姿态):`);
            for (const s of servers) console.log(`  ${describeServerForList(s)}`);
            console.log('');
            console.log('要扫描单个: --server "<source>::<name>"(可重复)');
            console.log('要扫描全部: --all --yes');
            console.log('要重建基线: --server ... --reset-baseline / --all --yes --reset-baseline');
          }
          return;
        }

        // 4. --server 命中但用户未给 --yes 且在 TTY 下:逐个 y/N 确认
        //    (规格:逐 server 显式同意)
        let toScan = approval.approved;
        if (
          toScan.length > 0 &&
          !yes &&
          process.stdin.isTTY === true
        ) {
          toScan = await confirmByReadline(toScan);
          if (toScan.length === 0) {
            console.log('全部 server 被跳过。');
            return;
          }
        }

        // 5. 跑扫描
        let report: ScanReport;
        try {
          report = await scanServers({
            home,
            filterServers: toScan.map(baselineKey),
            timeoutMs,
          });
        } catch (e) {
          if (e instanceof McpScanBaselineError) {
            process.stderr.write(`错误: ${e.message}\n`);
            process.exitCode = 1;
            return;
          }
          process.stderr.write(`错误: ${(e as Error).message}\n`);
          process.exitCode = 1;
          return;
        }

        // 6. 基线处理
        const baselineExisted = report.baselineExisted;
        let baselineStatus: JsonOutput['baselineStatus'] = baselineExisted ? 'compared' : 'missing';
        if (resetBaseline) {
          // 覆盖写基线(规格:--reset-baseline 把本次结果覆盖写入基线)
          const newMap = reportToBaselineMap(report);
          await writeMcpScanBaseline(report.baselinePath, newMap);
          baselineStatus = 'reset';
        } else if (!baselineExisted && report.servers.some((s) => s.connected)) {
          // 首次扫描且无 --reset-baseline:写基线(规格:首次扫描:写入基线并在输出注明)
          const newMap = reportToBaselineMap(report);
          await writeMcpScanBaseline(report.baselinePath, newMap);
          baselineStatus = 'established';
        }

        // 7. 输出
        if (json) {
          console.log(JSON.stringify(toJson(report, baselineStatus), null, 2));
        } else {
          console.log(renderHuman(report, baselineStatus === 'established'));
        }

        // 8. 退出码。--reset-baseline = 用户显式重新接受本次清单,rug-pull 差异
        //    不再计入阻断(否则"接受"与"阻断"自相矛盾);静态审计发现仍照常阻断。
        if (ci) {
          const blocking = resetBaseline
            ? report.servers.some((s) =>
                s.findings.some((f) => f.severity === 'critical' || f.severity === 'high'),
              )
            : shouldBlockForCi(report);
          if (blocking) process.exitCode = 1;
        }
      },
    );
}

/** commander 的 multi-value collector(--server 可重复时累加)。 */
function collectMulti(value: string, previous: string[] | undefined): string[] {
  if (previous === undefined) return [value];
  return [...previous, value];
}