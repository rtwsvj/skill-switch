// MCP server 发现与归一化(纯静态,不联网、不 spawn)。
//
// 复用 src/core/audit/config-discovery.ts 的 readMcpConfigsRaw(home) 拿全部 MCP 配置
// 原文,JSON.parse 提取 mcpServers,每个 server 归一化为统一形状:
//
//   {
//     name:        string                       // server key 名
//     source:      string                       // 配置文件 home-相对路径(用作基线 namespace)
//     transport:   'stdio' | 'http'             // 怎么连这个 server
//     command?:    string                       // stdio: 主可执行
//     args?:       string[]                     // stdio: 参数
//     env?:        Record<string, string>       // stdio: 子进程环境变量(只显式声明的,绝不继承父环境)
//     url?:        string                       // http: 远程 URL
//     headers?:    Record<string, string>       // http: 自定义请求头(只发,绝不落日志/基线)
//   }
//
// 容错策略:
//   - 配置文件 JSON.parse 失败:静默跳过(对应文件已被 mcp-audit.ts 报 mcp/invalid-json)
//   - mcpServers 不是对象:跳过
//   - server 项不是对象:跳过
//   - 同名 server 多处出现:全部列出,靠 source 字段区分(基线 key 用 source::name 形式,确保无歧义)
//
// 安全姿态:
//   - 此模块只读配置文件,绝不接触 env VALUE 或 headers VALUE 的具体内容;
//     这些字段在归一化结果里以引用形式(对象)返回,供 client.ts 在连接时使用,
//     绝不进入基线文件、日志、stdout。

import { readMcpConfigsRaw } from '../audit/config-discovery.ts';

/** 归一化后的 MCP server 定义。 */
export interface McpServerSpec {
  /** server 名(配置文件中 mcpServers 下的 key) */
  name: string;
  /** 配置文件 home-相对路径,例 ".claude/mcp.json" / ".cursor/mcp.json" */
  source: string;
  /** stdio = 本地子进程;http = 远程 JSON-RPC over HTTP */
  transport: 'stdio' | 'http';
  /** stdio 模式:主可执行(必填) */
  command?: string;
  /** stdio 模式:命令行参数 */
  args?: string[];
  /** stdio 模式:显式声明的子进程环境变量。绝不含父进程继承的字段。 */
  env?: Record<string, string>;
  /** http 模式:远程 URL(http:// 仅 localhost,https:// 任意;具体校验在 client.ts) */
  url?: string;
  /** http 模式:每个请求附带的头部。值绝不落基线/日志。 */
  headers?: Record<string, string>;
}

/**
 * 从单条 MCP server 原始定义抽取归一化字段。
 * 对类型错误的字段做安全降级(取空值/过滤非字符串),绝不抛。
 */
function normalizeServerEntry(
  name: string,
  source: string,
  raw: unknown,
): McpServerSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;

  const command = typeof entry.command === 'string' && entry.command.trim() ? entry.command : '';
  const url =
    typeof entry.url === 'string' && entry.url.trim()
      ? entry.url
      : typeof entry.serverUrl === 'string' && entry.serverUrl.trim()
        ? entry.serverUrl
        : '';

  // 优先 stdio:有 command 就走 stdio。
  // 即便同时有 url,stdio 是直接执行,风险更高、优先识别。
  if (command) {
    const argsRaw = Array.isArray(entry.args)
      ? (entry.args as unknown[]).filter((a): a is string => typeof a === 'string')
      : [];
    const envRaw =
      entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
        ? (entry.env as Record<string, unknown>)
        : undefined;
    const env: Record<string, string> = {};
    if (envRaw) {
      for (const [k, v] of Object.entries(envRaw)) {
        if (typeof v === 'string') env[k] = v;
      }
    }
    return {
      name,
      source,
      transport: 'stdio',
      command,
      args: argsRaw,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  if (url) {
    const headersRaw =
      entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers)
        ? (entry.headers as Record<string, unknown>)
        : undefined;
    const headers: Record<string, string> = {};
    if (headersRaw) {
      for (const [k, v] of Object.entries(headersRaw)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }
    return {
      name,
      source,
      transport: 'http',
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }

  // 既无 command 也无 url:无效 server 条目(无法决定怎么连),静默跳过。
  return null;
}

/**
 * 从 home 目录发现所有 MCP server 归一化定义。
 * 同名 server 多处出现 → 都返回(由 source 区分),调用方可按需筛选。
 *
 * 配置文件读取/解析错误静默处理(对应文件已被 mcp-audit.ts 单独报 mcp/invalid-json)。
 */
export async function discoverMcpServers(home: string): Promise<McpServerSpec[]> {
  const rawContents = await readMcpConfigsRaw(home);
  const out: McpServerSpec[] = [];

  for (const [relPath, rawContent] of rawContents) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      // 坏 JSON:mcp-audit.ts 已在 audit --configs 路径中单独报 mcp/invalid-json。
      // 此处不重复告警,保持单一真相源。
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

    const cfg = parsed as { mcpServers?: unknown };
    if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object' || Array.isArray(cfg.mcpServers)) {
      continue;
    }

    const servers = cfg.mcpServers as Record<string, unknown>;
    for (const [serverName, serverEntry] of Object.entries(servers)) {
      const norm = normalizeServerEntry(serverName, relPath, serverEntry);
      if (norm) out.push(norm);
    }
  }

  // 稳定排序:先按 source(配置来源),再按 name。便于跨 run 比对、便于用户在终端阅读。
  out.sort((a, b) => {
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return out;
}

/**
 * 生成基线 key:把 server 的"来源"和"名字"拼接成一个稳定的命名空间字符串。
 * 同名 server 出现在不同文件时,key 自然不同(不会碰撞)。
 *
 * 例: ".claude/mcp.json::filesystem"
 */
export function baselineKey(spec: McpServerSpec): string {
  return `${spec.source}::${spec.name}`;
}

/**
 * 生成工具 fingerprint key:在某 server 的命名空间下,按工具名展开。
 * 例: ".claude/mcp.json::filesystem::read_file"
 */
export function baselineToolKey(spec: McpServerSpec, toolName: string): string {
  return `${baselineKey(spec)}::${toolName}`;
}