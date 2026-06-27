// 线 E:把 skill-switch 做成 MCP server —— 让 Cursor / Claude Code 等 agent 实时调用它的只读审计能力。
//
// 设计要点:
//   - 零依赖手写 MCP stdio(JSON-RPC 2.0),不引 @modelcontextprotocol/sdk(契合项目 zero-dep)。
//   - stdout 是协议通道(只写 JSON-RPC),任何诊断/日志一律走 stderr,否则会污染协议。
//   - 只暴露**只读**工具(scan / status / audit):agent 能看、能审,但 MCP 这条路绝不写用户磁盘。
//   - handleMcpRequest 与 stdio 传输分离,便于单测(直接喂 request 对象断言 response)。
import { resolveHomeRoot } from '../core/paths.ts';
import { scanHome } from '../core/scan.ts';
import { buildStatus } from '../core/status.ts';
import { auditHome, auditSkillDir } from '../cli/commands/audit.ts';

// 我们实现/对话的 MCP 协议版本(广泛被 Claude/Cursor 支持的稳定版)。
export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_NAME = 'skill-switch';

// ── JSON-RPC 2.0 类型 ─────────────────────────────────────────────────────────
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── 工具定义 ──────────────────────────────────────────────────────────────────
interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 执行工具,返回要回给 agent 的文本(通常是 JSON 字符串)。抛错由上层转成 isError 结果。 */
  run(args: Record<string, unknown>): Promise<string>;
}

/** 把 home 入参解析成真实根目录(缺省取系统 home,与各 CLI 命令一致)。 */
function resolveHomeArg(args: Record<string, unknown>): string {
  const raw = typeof args.home === 'string' && args.home.trim() ? args.home : undefined;
  return resolveHomeRoot(raw);
}

/** 把一条 finding 收敛成稳定、可序列化、不含内部 Map 的形状。 */
function slimFinding(f: { ruleId: string; severity: string; file?: string; line: number; message: string }) {
  return { ruleId: f.ruleId, severity: f.severity, file: f.file, line: f.line, message: f.message };
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'skill_switch_scan',
    description:
      '盘点本机各 agent(Claude Code / Codex / Gemini CLI / Cursor …)已安装的 skill。只读,不改任何文件。',
    inputSchema: {
      type: 'object',
      properties: {
        home: { type: 'string', description: '可选:覆盖 home 根目录(默认系统 home)。' },
      },
    },
    async run(args) {
      const home = resolveHomeArg(args);
      const records = await scanHome(home);
      const skills = records.map((r) => ({
        dirName: r.dirName,
        name: r.name ?? null,
        description: r.description ?? null,
        agents: r.agents,
        error: r.error ?? null,
      }));
      return JSON.stringify({ home, total: skills.length, skills }, null, 2);
    },
  },
  {
    name: 'skill_switch_status',
    description:
      '一眼看清现状:磁盘/声明/启用/锁定 skill 数、检测到的 agent、声明↔锁↔磁盘的健康状态。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        home: { type: 'string', description: '可选:覆盖 home 根目录。' },
      },
    },
    async run(args) {
      const home = resolveHomeArg(args);
      const status = await buildStatus(home);
      return JSON.stringify(status, null, 2);
    },
  },
  {
    name: 'skill_switch_audit',
    description:
      'AI agent skill 安全审计:检测反向 shell、数据外泄、凭据钓鱼、危险 MCP server、明文远端传输、硬编码密钥等(80+ 规则)。' +
      '给 path 审单个 skill 目录;不给 path 则审整个 home 已装 skill(可选 includeConfigs 连配置文件一起审)。只读,绝不修改磁盘。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '可选:要审计的 skill 目录路径。给了就只审这个目录。' },
        home: { type: 'string', description: '可选:覆盖 home 根目录(审整个 home 时用)。' },
        includeConfigs: {
          type: 'boolean',
          description: '可选:审整个 home 时,连 settings/MCP 配置文件一起审。',
        },
      },
    },
    async run(args) {
      // 模式一:给了 path → 审单个 skill 目录
      if (typeof args.path === 'string' && args.path.trim()) {
        const report = await auditSkillDir(args.path);
        return JSON.stringify(
          {
            mode: 'path',
            path: args.path,
            score: report.score,
            verdict: report.verdict,
            findingCount: report.findings.length,
            findings: report.findings.map(slimFinding),
          },
          null,
          2,
        );
      }
      // 模式二:审整个 home
      const home = resolveHomeArg(args);
      const includeConfigs = args.includeConfigs === true;
      const report = await auditHome(home, { includeConfigs });
      const skills = report.skills.map((s) => ({
        name: s.name,
        dirName: s.dirName,
        score: s.score,
        verdict: s.verdict,
        blocked: s.blocked,
        findings: s.findings.map(slimFinding),
      }));
      const anyBlocked = report.skills.some((s) => s.blocked) || report.configsBlocked === true;
      return JSON.stringify(
        { mode: 'home', home, total: report.total, anyBlocked, skills },
        null,
        2,
      );
    },
  },
];

// ── JSON-RPC 请求处理(与传输解耦,便于单测)─────────────────────────────────
/**
 * 处理一条 MCP 请求。
 * @returns 要写回的响应;若是通知(无 id 的 method,如 notifications/initialized)则返回 null。
 */
export async function handleMcpRequest(
  req: JsonRpcRequest,
  serverVersion: string,
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const isNotification = req.id === undefined;

  switch (req.method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: serverVersion },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // 通知:无响应

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, {
        tools: MCP_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      const tool = MCP_TOOLS.find((t) => t.name === params.name);
      if (!tool) {
        return err(id, -32602, `未知工具: ${String(params.name)}`);
      }
      const callArgs =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const text = await tool.run(callArgs);
        return ok(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        // 工具执行错误:按 MCP 约定走 isError 结果(而非 JSON-RPC error),让 agent 能看到原因。
        const message = e instanceof Error ? e.message : String(e);
        return ok(id, { content: [{ type: 'text', text: `工具执行失败: ${message}` }], isError: true });
      }
    }

    default:
      if (isNotification) return null; // 未知通知:静默忽略
      return err(id, -32601, `不支持的方法: ${req.method}`);
  }
}

function ok(id: JsonRpcResponse['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}
function err(id: JsonRpcResponse['id'], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ── stdio 传输 ────────────────────────────────────────────────────────────────
/**
 * 在 stdin/stdout 上跑 MCP server(行分隔 JSON-RPC)。
 * stdout 只写协议帧;诊断走 stderr。读到 EOF 即解析返回的 Promise。
 */
export function runMcpStdioServer(serverVersion: string): Promise<void> {
  return new Promise((resolve) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');

    const writeResponse = (res: JsonRpcResponse): void => {
      process.stdout.write(`${JSON.stringify(res)}\n`);
    };

    const handleLine = async (line: string): Promise<void> => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        writeResponse(err(null, -32700, 'JSON 解析失败'));
        return;
      }
      const res = await handleMcpRequest(req, serverVersion);
      if (res) writeResponse(res);
    };

    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      // 逐行切分;每行单独处理(串行,保持 id 顺序)。
      for (;;) {
        const idx = buffer.indexOf('\n');
        if (idx === -1) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        void handleLine(line);
      }
    });

    process.stdin.on('end', () => {
      const rest = buffer;
      buffer = '';
      void handleLine(rest).finally(() => resolve());
    });
  });
}
