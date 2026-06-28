// 线 E:把 skill-switch 做成 MCP server —— 让 Cursor / Claude Code 等 agent 实时调用它的只读审计能力。
//
// 设计要点:
//   - 零依赖手写 MCP stdio(JSON-RPC 2.0),不引 @modelcontextprotocol/sdk(契合项目 zero-dep)。
//   - stdout 是协议通道(只写 JSON-RPC),任何诊断/日志一律走 stderr,否则会污染协议。
//   - 只暴露**只读**工具(scan / status / audit):agent 能看、能审,但 MCP 这条路绝不写用户磁盘。
//   - handleMcpRequest 与 stdio 传输分离,便于单测(直接喂 request 对象断言 response)。
import { readdir } from 'node:fs/promises';
import { resolveHomeRoot } from '../core/paths.ts';
import { scanHome } from '../core/scan.ts';
import { buildStatus } from '../core/status.ts';
import { auditHome, auditSkillDir } from '../cli/commands/audit.ts';
import { analyzeCooccurrence } from '../core/packs/cooccurrence.ts';
import { suggestPacks } from '../core/packs/suggest.ts';
import { buildStats } from '../core/stats.ts';

// 我们实现/对话的 MCP 协议版本。
// 2025-06-18:加入 annotations、resources、prompts、outputSchema 等扩展能力。
// 向后兼容:tools/call、tools/list、ping、notifications/* 等旧方法完全不变。
export const MCP_PROTOCOL_VERSION = '2025-06-18';
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
/** 工具注解:所有工具均只读,客户端可自动批准、免确认弹窗。 */
interface McpToolAnnotations {
  /** 只读提示:true 表示不会修改外部状态,客户端可自动批准。 */
  readOnlyHint: boolean;
  /** 破坏性提示:false 表示无删除/覆盖等不可逆操作。 */
  destructiveHint: boolean;
  /** 幂等提示:true 表示多次调用结果一致,客户端可安全重试。 */
  idempotentHint: boolean;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 工具注解,帮助客户端决定是否自动批准。 */
  annotations: McpToolAnnotations;
  /** outputSchema:声明工具返回结构(可选),让 agent 更好地解析结果。 */
  outputSchema?: Record<string, unknown>;
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

/** slimFinding 的 JSON Schema 声明,供 outputSchema 复用。 */
const SLIM_FINDING_SCHEMA = {
  type: 'object',
  properties: {
    ruleId:   { type: 'string' },
    severity: { type: 'string', enum: ['high', 'medium', 'low', 'info'] },
    file:     { type: 'string' },
    line:     { type: 'number' },
    message:  { type: 'string' },
  },
  required: ['ruleId', 'severity', 'line', 'message'],
} as const;

/** 所有工具共享的只读注解。 */
const READ_ONLY_ANNOTATIONS: McpToolAnnotations = {
  readOnlyHint:    true,
  destructiveHint: false,
  idempotentHint:  true,
};

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
    annotations: READ_ONLY_ANNOTATIONS,
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
    annotations: READ_ONLY_ANNOTATIONS,
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
    annotations: READ_ONLY_ANNOTATIONS,
    // outputSchema:声明 audit 工具的返回结构(path 模式),让 agent 能结构化解析 findings。
    outputSchema: {
      type: 'object',
      oneOf: [
        {
          description: 'path 模式:审计单个 skill 目录',
          properties: {
            mode:         { type: 'string', enum: ['path'] },
            path:         { type: 'string' },
            score:        { type: 'number' },
            verdict:      { type: 'string' },
            findingCount: { type: 'number' },
            findings:     { type: 'array', items: SLIM_FINDING_SCHEMA },
          },
          required: ['mode', 'path', 'score', 'verdict', 'findingCount', 'findings'],
        },
        {
          description: 'home 模式:审计整个 home',
          properties: {
            mode:       { type: 'string', enum: ['home'] },
            home:       { type: 'string' },
            total:      { type: 'number' },
            anyBlocked: { type: 'boolean' },
            skills: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name:        { type: 'string' },
                  dirName:     { type: 'string' },
                  score:       { type: 'number' },
                  verdict:     { type: 'string' },
                  blocked:     { type: 'boolean' },
                  findings:    { type: 'array', items: SLIM_FINDING_SCHEMA },
                },
              },
            },
          },
          required: ['mode', 'home', 'total', 'anyBlocked', 'skills'],
        },
      ],
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
  {
    name: 'skill_switch_packs_suggest',
    description:
      '分析最近对话里 skill 的共现情况,建议把哪些"总是一起用"的 skill 打成套餐(pack)。' +
      '只读:只看 skill 名 + 出现次数,绝不读对话正文,绝不出本机。' +
      '返回套餐建议列表(id、建议名、skill 列表、理由、共现强度)。',
    inputSchema: {
      type: 'object',
      properties: {
        home: { type: 'string', description: '可选:覆盖 home 根目录(默认系统 home)。' },
        windowDays: {
          type: 'number',
          description: '可选:只统计最近 N 天内的使用记录(不填 = 全量历史)。',
        },
      },
    },
    annotations: READ_ONLY_ANNOTATIONS,
    async run(args) {
      const home = resolveHomeArg(args);
      const windowDays =
        typeof args.windowDays === 'number' && Number.isFinite(args.windowDays)
          ? args.windowDays
          : undefined;
      const report = await analyzeCooccurrence(home, windowDays !== undefined ? { windowDays } : {});
      const suggestions = suggestPacks(report);
      return JSON.stringify(
        {
          home,
          sessionCount: report.sessionCount,
          ...(windowDays !== undefined ? { windowDays } : {}),
          suggestionCount: suggestions.length,
          suggestions: suggestions.map((s) => ({
            id: s.id,
            suggestedName: s.suggestedName,
            skills: s.skills,
            rationale: s.rationale,
            strength: s.strength,
          })),
        },
        null,
        2,
      );
    },
  },
  {
    name: 'skill_switch_stats',
    description:
      '统计各 skill 的使用频率,并找出"僵尸 skill"(已安装但近期零触发、白占 token 配额的 skill)。' +
      '只读:只扫 transcript 文件里的 skill 调用记录,不读对话正文,不写任何文件。',
    inputSchema: {
      type: 'object',
      properties: {
        home: { type: 'string', description: '可选:覆盖 home 根目录(默认系统 home)。' },
        days: {
          type: 'number',
          description: '可选:只统计最近 N 天内的使用记录(不填 = 全量历史)。',
        },
      },
    },
    annotations: READ_ONLY_ANNOTATIONS,
    async run(args) {
      const home = resolveHomeArg(args);
      const days =
        typeof args.days === 'number' && Number.isFinite(args.days) ? args.days : undefined;
      const report = await buildStats(home, days);
      return JSON.stringify(
        {
          home,
          ...(report.since ? { since: report.since } : {}),
          invocations: report.invocations,
          scannedFiles: report.scannedFiles,
          truncated: report.truncated,
          usage: report.usage.map((u) => ({
            skill: u.skill,
            count: u.count,
            ...(u.lastUsed ? { lastUsed: u.lastUsed } : {}),
          })),
          zombieCount: report.zombies.length,
          zombies: report.zombies.map((z) => ({
            name: z.name,
            agents: z.agents,
          })),
        },
        null,
        2,
      );
    },
  },
];

// ── MCP Resources(规则知识库,供 agent 当上下文)──────────────────────────────

/** 内置资源:rules 目录元数据 + 各规则类目描述。 */
interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

const SKILL_SWITCH_RESOURCES: McpResource[] = [
  {
    uri:         'skill-switch://rules',
    name:        'Skill-Switch 审计规则目录',
    description: '列出 skill-switch 内置的所有安全审计规则类目(如反向 shell、凭据钓鱼、数据外渗等),供 agent 了解审计覆盖范围。',
    mimeType:    'application/json',
  },
  {
    uri:         'skill-switch://report/last',
    name:        '上次审计摘要(说明)',
    description: 'MCP 这条路无状态,不持久化审计结果。调用 skill_switch_audit 工具可获取实时报告。',
    mimeType:    'text/plain',
  },
];

/** 规则类目描述表。 */
const RULE_CATEGORIES = [
  { id: 'reverse-shell',    label: '反向 Shell',       description: 'netcat / bash /dev/tcp 等命令将 shell 反弹到远端' },
  { id: 'exfiltration',     label: '数据外渗',          description: '把本地文件/凭据用 curl/fetch 发往外部地址' },
  { id: 'destructive',      label: '破坏性命令',        description: 'rm -rf / dd / truncate 等不可逆破坏命令' },
  { id: 'clickfix',         label: 'ClickFix 社工',    description: '诱导用户粘贴执行恶意命令的 UI 欺骗模板' },
  { id: 'staged',           label: '分阶段投毒',        description: '分步下载并执行 payload 以规避单次扫描' },
  { id: 'persistence',      label: '持久化注入',        description: '写 cron / launchd / rc 文件实现开机后门' },
  { id: 'global-tamper',    label: '全局文件篡改',      description: '改写 ~/.bashrc、PATH、全局 npm 包等影响所有会话' },
  { id: 'credential-theft', label: '凭据钓鱼',          description: '读取 .env、SSH 私钥、token 文件并外送' },
  { id: 'supply-chain',     label: '供应链污染',        description: '依赖混淆、恶意 postinstall、包名抢占' },
  { id: 'prompt-injection', label: 'Prompt 注入',      description: '隐藏指令/不可见字符覆盖 agent 行为' },
  { id: 'staged-exfil',     label: '分阶段外渗(文件)', description: '先本地暂存再批量传出的两段式外渗' },
  { id: 'base64-payload',   label: 'Base64 编码 Payload', description: 'base64 解码后执行的隐藏 shell 命令' },
  { id: 'invisible-chars',  label: '不可见字符注入',    description: 'Trojan-Source bidi / 控制字符(CVE-2021-42574)' },
  { id: 'ansi-injection',   label: 'ANSI 终端注入',    description: 'ANSI 转义序列覆盖终端显示,隐藏真实执行内容' },
];

/**
 * 读取 resources/list:列出所有内置资源。
 */
function handleResourcesList(): unknown {
  return { resources: SKILL_SWITCH_RESOURCES };
}

/**
 * 读取 resources/read:按 URI 返回资源内容。
 */
async function handleResourcesRead(params: Record<string, unknown>): Promise<unknown> {
  const uri = typeof params.uri === 'string' ? params.uri : '';

  if (uri === 'skill-switch://rules') {
    // 读取 rules 目录:列出所有规则文件 + 类目描述
    const rulesDir = new URL('../../rules', import.meta.url);
    let fileList: string[] = [];
    try {
      const entries = await readdir(rulesDir);
      fileList = entries.filter((e) => e.endsWith('.ts') && e !== 'index.ts');
    } catch {
      // rules 目录读不到时降级返回静态类目表
    }
    const content = JSON.stringify(
      {
        description: 'skill-switch 内置安全审计规则类目',
        ruleFileCount: fileList.length || RULE_CATEGORIES.length,
        categories: RULE_CATEGORIES,
        files: fileList,
        note: '调用 skill_switch_audit 工具可对具体 skill 目录运行这些规则。',
      },
      null,
      2,
    );
    return {
      contents: [{ uri, mimeType: 'application/json', text: content }],
    };
  }

  if (uri === 'skill-switch://report/last') {
    return {
      contents: [
        {
          uri,
          mimeType: 'text/plain',
          text: 'MCP server 无状态,不持久化上次审计结果。请调用 skill_switch_audit 工具获取实时报告。',
        },
      ],
    };
  }

  return { error: { code: -32602, message: `未知资源 URI: ${uri}` } };
}

// ── MCP Prompts(内置审计模板)────────────────────────────────────────────────

interface McpPrompt {
  name: string;
  description: string;
  arguments?: { name: string; description: string; required: boolean }[];
}

const MCP_PROMPTS: McpPrompt[] = [
  {
    name:        'audit-all-skills',
    description: '审计我本机所有已安装的 skill,列出安全风险最高的 skill 并给出处置建议。',
    arguments: [
      { name: 'home', description: '可选:覆盖 home 根目录(默认系统 home)。', required: false },
    ],
  },
  {
    name:        'find-zombie-skills',
    description: '找出近期零触发的"僵尸 skill"——已安装但从未(或很少)被调用,白占 token 配额,建议禁用或删除。',
    arguments: [
      { name: 'days', description: '可选:统计窗口天数(不填 = 全量历史)。', required: false },
    ],
  },
  {
    name:        'audit-single-skill',
    description: '深度审计指定 skill 目录,输出逐条 finding(规则 ID、严重度、行号、原因)并给出是否可以安全使用的结论。',
    arguments: [
      { name: 'path', description: '要审计的 skill 目录绝对路径。', required: true },
    ],
  },
];

/** 把 prompt name + 入参组合成可直接给 agent 执行的消息模板。 */
function buildPromptMessages(
  name: string,
  args: Record<string, string>,
): { role: string; content: { type: string; text: string } }[] {
  switch (name) {
    case 'audit-all-skills': {
      const homeClause = args.home ? `home 根目录为 \`${args.home}\`` : '使用系统默认 home';
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `请用 skill_switch_audit 工具审计我本机所有已安装的 skill(${homeClause})。` +
              '列出评分最低的 5 个 skill,说明每个的主要风险(规则 ID + 描述),并给出"禁用 / 删除 / 安全保留"的建议。',
          },
        },
      ];
    }
    case 'find-zombie-skills': {
      const daysClause = args.days ? `最近 ${args.days} 天` : '全量历史';
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `请用 skill_switch_stats 工具统计 skill 使用情况(${daysClause}),` +
              '找出零触发或极低频的"僵尸 skill",列出 skill 名称 + 最后使用时间(如有),并建议是否禁用或删除以节省 token 配额。',
          },
        },
      ];
    }
    case 'audit-single-skill': {
      const pathClause = args.path ?? '（请提供 path 参数）';
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `请用 skill_switch_audit 工具深度审计 skill 目录 \`${pathClause}\`。` +
              '逐条列出每个 finding(规则 ID、严重度、行号、触发原因),并给出最终结论:该 skill 是否安全可用?如有高危 finding 请说明应立即禁用。',
          },
        },
      ];
    }
    default:
      return [
        {
          role: 'user',
          content: { type: 'text', text: `未知 prompt: ${name}` },
        },
      ];
  }
}

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
        // 2025-06-18 新能力:resources + prompts
        capabilities: { tools: {}, resources: {}, prompts: {} },
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
          name:        t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          // 2025-06-18:annotations 和 outputSchema 附加给每个工具
          annotations:  t.annotations,
          ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
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

    case 'resources/list':
      return ok(id, handleResourcesList());

    case 'resources/read': {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const result = await handleResourcesRead(params);
      // 若内部返回了 error 字段,包装成 JSON-RPC error
      if (result && typeof result === 'object' && 'error' in result) {
        const e = (result as { error: { code: number; message: string } }).error;
        return err(id, e.code, e.message);
      }
      return ok(id, result);
    }

    case 'prompts/list':
      return ok(id, { prompts: MCP_PROMPTS });

    case 'prompts/get': {
      const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      const promptName = typeof params.name === 'string' ? params.name : '';
      const found = MCP_PROMPTS.find((p) => p.name === promptName);
      if (!found) {
        return err(id, -32602, `未知 prompt: ${promptName}`);
      }
      const promptArgs =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, string>)
          : {};
      const messages = buildPromptMessages(promptName, promptArgs);
      return ok(id, { description: found.description, messages });
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
