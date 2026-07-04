// mcp-scan 编排层:对每个获准的 server,连 → 取工具清单 → 静态审计 → rug-pull 比对。
//
// 设计:
//   - scanOneServer(spec, ...) 是单 server 的完整流程,产出 ScanResult
//   - 每个 tool 组装为 AuditTarget(path = `mcp-scan://<server>/<tool>`,
//     content = name + '\n' + description + '\n' + JSON.stringify(inputSchema)),
//     用 auditContents(rules, targets) 跑全部既有规则
//   - 与基线比对:hash 变化 → mcp/tool-definition-changed(high);
//     新增 → mcp/tool-added(medium);移除 → 仅在人类输出里提示,不计 finding
//
// 调用方(CLI)负责:发现 → opt-in 门 → 选 server → 调 scanServers → 渲染。

import { allRules } from '../../../rules/index.ts';
import { auditContents, type AuditTarget } from '../audit/engine.ts';
import type { AuditFinding } from '../audit/types.ts';
import { baselineKey, type McpServerSpec } from './discover.ts';
import {
  diffToolBaseline,
  fingerprintTool,
  loadMcpScanBaseline,
  McpScanBaselineError,
  type McpScanBaselineMap,
  mcpScanBaselinePath,
  type ToolDefinition,
} from './baseline.ts';
import { discoverMcpServers } from './discover.ts';
import {
  connectAndListTools,
  DEFAULT_TIMEOUT_MS,
  describeServer,
  McpScanClientError,
  type ConnectResult,
} from './client.ts';

// ── 结果数据形状 ─────────────────────────────────────────────────────────────

/** 单 server 的扫描结果。 */
export interface ScanServerResult {
  spec: McpServerSpec;
  /** 是否成功连上 + 拿到工具清单;false 时 error 字段必有。 */
  connected: boolean;
  /** 连接失败/工具解析失败的结构化错误(仅 connected=false 时有值) */
  error?: { code: string; message: string };
  /** server 声明的协议版本(connected=true 时) */
  protocolVersion?: string;
  /** 连接到的工具清单 */
  tools: ToolDefinition[];
  /** 静态审计命中(用既有 auditContents) */
  findings: AuditFinding[];
  /** rug-pull 差异产生的 finding(只来自 mcp/tool-definition-changed / mcp/tool-added) */
  rugPullFindings: AuditFinding[];
  /** 工具被移除(只用于人类输出提示,不产 finding) */
  removedTools: string[];
  /** 当前基线指纹(用于必要时回写) */
  currentFingerprint: Record<string, string>;
}

/** 整次扫描的聚合结果(供 CLI 渲染 + 退出码决策)。 */
export interface ScanReport {
  home: string;
  baselinePath: string;
  /** baseline 已成功加载(true)/ 不存在(false) */
  baselineExisted: boolean;
  /** 本次扫描覆盖的 server 结果(按 source/name 排序) */
  servers: ScanServerResult[];
  /** 全部 finding(静态 + rug-pull)。空则阻断决策只看 critical/high。 */
  findings: AuditFinding[];
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

export interface ScanOptions {
  /** home 根目录 */
  home: string;
  /** 只扫描这些 server(若空数组则全跑);按 source::name 匹配 */
  filterServers?: string[];
  /** 每 server 超时(毫秒);默认 10000 */
  timeoutMs?: number;
  /** fetch 注入(测试);默认全局 fetch */
  fetchImpl?: typeof fetch;
}

/**
 * 跑一次完整扫描:遍历获准的 server,各自连 → 审计 → rug-pull 比对。
 * 不做 opt-in 门(由 CLI 层负责);不在此写基线(由 CLI 根据 report 决定是否回写)。
 */
export async function scanServers(opts: ScanOptions): Promise<ScanReport> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 拉取基线(缺失不报错)
  const baselinePath = mcpScanBaselinePath(opts.home);
  let baseline: McpScanBaselineMap = new Map();
  let baselineExisted = true;
  try {
    baseline = await loadMcpScanBaseline(baselinePath);
  } catch (e) {
    if (e instanceof McpScanBaselineError && /不存在/.test(e.message)) {
      baselineExisted = false;
    } else {
      // 文件存在但 JSON 损坏 → 上抛,交 CLI 映射到 "错误: ..." + exit 1
      throw e;
    }
  }

  // 发现 server(CLI 已经在 opt-in 门前发现过,这里再发现一次是允许的——CLI 可把已发现列表传过来)
  // 为简化与可测性,scanServers 内部自行发现 + 按 filterServers 过滤。
  const all = await discoverMcpServers(opts.home);

  const filterSet = opts.filterServers && opts.filterServers.length > 0
    ? new Set(opts.filterServers)
    : null;

  const targets = filterSet
    ? all.filter((s) => filterSet.has(baselineKey(s)))
    : all;

  // 跑每个 server
  const servers: ScanServerResult[] = [];
  for (const spec of targets) {
    // eslint-disable-next-line no-await-in-loop
    const r = await scanOneServer(spec, baseline, timeoutMs, opts.fetchImpl);
    servers.push(r);
  }

  const findings: AuditFinding[] = [];
  for (const r of servers) {
    for (const f of r.findings) findings.push(f);
    for (const f of r.rugPullFindings) findings.push(f);
  }

  return {
    home: opts.home,
    baselinePath,
    baselineExisted,
    servers,
    findings,
  };
}

/** 单 server 扫描:连 → 静态审计 → rug-pull 比对。 */
async function scanOneServer(
  spec: McpServerSpec,
  baseline: McpScanBaselineMap,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
): Promise<ScanServerResult> {
  let connectResult: ConnectResult;
  try {
    connectResult = await connectAndListTools(spec, timeoutMs, { fetchImpl });
  } catch (e) {
    const code = e instanceof McpScanClientError ? e.code : 'unknown';
    const message = e instanceof Error ? e.message : String(e);
    return {
      spec,
      connected: false,
      error: { code, message },
      tools: [],
      findings: [],
      rugPullFindings: [],
      removedTools: [],
      currentFingerprint: {},
    };
  }

  // 静态审计:每个 tool 组装为 AuditTarget
  const auditTargets: AuditTarget[] = connectResult.tools.map((tool) => ({
    file: `mcp-scan://${baselineKey(spec)}/${tool.name}`,
    content:
      `${tool.name}\n${tool.description}\n${JSON.stringify(tool.inputSchema ?? {})}`,
  }));
  const auditReport = auditContents(allRules, auditTargets);

  // 当前指纹
  const serverKey = baselineKey(spec);
  const currentFp = new Map<string, string>();
  for (const t of connectResult.tools) currentFp.set(t.name, fingerprintTool(t));
  const currentFpMap = new Map<string, Map<string, string>>();
  currentFpMap.set(serverKey, currentFp);

  // 差异——仅当基线里已有该 server。首次见到无从比对:建立基线即可,
  // 把全部工具报成 tool-added 会让首扫 --ci 必挂,违背"首次扫描只建基线并注明"。
  const rugPullFindings: AuditFinding[] = [];
  const removedTools: string[] = [];
  const diffs = baseline.has(serverKey) ? diffToolBaseline(currentFpMap, baseline) : [];
  for (const d of diffs) {
    if (d.kind === 'changed') {
      rugPullFindings.push({
        ruleId: 'mcp/tool-definition-changed',
        severity: 'high',
        file: `mcp-scan://${d.serverKey}/${d.toolName}`,
        line: 1,
        // 安全姿态:不回显新/旧 description 全文,仅给摘要 + tool 名
        excerpt: `[${d.toolName}] 工具描述或参数 schema 已变更(rug-pull 嫌疑)`,
        message:
          `MCP 工具 "${d.toolName}" 的定义自基线起已变更——可能是 rug-pull(server "${spec.name}" 在 ${spec.source})。` +
          `请人工复核工具描述是否被注入恶意指令或参数 schema 是否被改向外渗路径,然后考虑 --reset-baseline 重新接受`,
      });
    } else if (d.kind === 'added') {
      rugPullFindings.push({
        ruleId: 'mcp/tool-added',
        severity: 'medium',
        file: `mcp-scan://${d.serverKey}/${d.toolName}`,
        line: 1,
        excerpt: `[${d.toolName}] 新增工具(基线中未记录)`,
        message:
          `MCP 工具 "${d.toolName}" 在基线中不存在——请确认来源可信后考虑 --reset-baseline 重新接受(server "${spec.name}" 在 ${spec.source})`,
      });
    } else if (d.kind === 'removed') {
      removedTools.push(d.toolName);
    }
  }

  return {
    spec,
    connected: true,
    protocolVersion: connectResult.protocolVersion,
    tools: connectResult.tools,
    findings: auditReport.findings,
    rugPullFindings,
    removedTools,
    currentFingerprint: Object.fromEntries(currentFp),
  };
}

// ── 阻断判据 ────────────────────────────────────────────────────────────────

/** rug-pull 路径下,spec 规定 --ci 阻断判据:critical / high finding 命中即 exit 1。 */
export function shouldBlockForCi(report: ScanReport): boolean {
  return report.findings.some((f) => f.severity === 'critical' || f.severity === 'high');
}

// ── 工具:把 report 转成可写回基线的 Map ───────────────────────────────────────

/** 把 report 里所有已连接的 server 的工具指纹折算成基线 Map(供 CLI 在 --reset-baseline 时用)。 */
export function reportToBaselineMap(report: ScanReport): McpScanBaselineMap {
  const out: McpScanBaselineMap = new Map();
  for (const r of report.servers) {
    if (!r.connected) continue;
    const inner = new Map<string, string>();
    for (const [name, hash] of Object.entries(r.currentFingerprint)) inner.set(name, hash);
    out.set(baselineKey(r.spec), inner);
  }
  return out;
}

// ── 工具:把 server 描述成人类可读行(list 模式用) ───────────────────────────

/** 人类输出里给一行 server 摘要(不连,只列)。 */
export function describeServerForList(spec: McpServerSpec): string {
  const where = `(${spec.source})`;
  if (spec.transport === 'stdio') {
    return `${spec.name}  stdio  ${describeServer(spec)}  ${where}`;
  }
  return `${spec.name}  http   ${spec.url}  ${where}`;
}