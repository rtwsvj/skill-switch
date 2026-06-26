// v0.8-1:MCP 配置漂移检测——把当前 MCP server 定义快照为「基线」,
// 后续 audit 时与基线对比:command/args/url 改变 → high(可能被篡改);
// 新出现的 server → medium。纯静态,无 spawn/网络/新依赖。
//
// ── 指纹方案(为什么这样设计)──────────────────────────────────────────────────
// 指纹 = sha256( 规范化后的 { command, args, url, envKeys(排序), headerKeys(排序) } )
//
// - command/args:决定 MCP server 的实际可执行内容,是 rug-pull 的核心载体。
// - url / serverUrl:远程传输 URL 变化同样是高风险信号。
// - envKeys(排序,仅 KEY 名,不含 VALUE):添加新的含密钥的 env 项本身是一个变化信号。
//   仅存 KEY 名确保真实 secret 值永远不进入基线文件。
// - headerKeys(排序,仅 KEY 名,不含 VALUE):同上——添加鉴权 header 是变化信号。
// - 刻意排除:description、autoApprove、alwaysAllow、type 等非身份字段——
//   这些是使用策略/元数据,不是 server 的可执行身份。只改这些字段不应触发高严重度报警。
//
// 基线文件格式:
// { "version": 1, "servers": { "<relPath>::<serverName>": "<sha256 hex>" } }

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { AuditFinding } from './types.ts';

// ── 指纹计算 ──────────────────────────────────────────────────────────────────

/**
 * 从 MCP server 定义中提取用于指纹的身份字段。
 * 仅对 string/string[] 字段操作;未知类型安全回退。
 */
interface McpServerIdentity {
  command: string;
  args: string[];
  /** url 或 serverUrl 统一到此字段 */
  url: string;
  /** env 对象的 KEY 名列表(排序)——不含 VALUE,确保 secret 不进入基线 */
  envKeys: string[];
  /** headers 对象的 KEY 名列表(排序)——不含 VALUE */
  headerKeys: string[];
}

function extractIdentity(server: Record<string, unknown>): McpServerIdentity {
  const command = typeof server.command === 'string' ? server.command : '';
  const args = Array.isArray(server.args)
    ? (server.args as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];
  const url =
    typeof server.url === 'string'
      ? server.url
      : typeof server.serverUrl === 'string'
        ? server.serverUrl
        : '';

  const rawEnv = server.env;
  const envKeys =
    rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
      ? Object.keys(rawEnv as Record<string, unknown>).sort()
      : [];

  const rawHeaders = server.headers;
  const headerKeys =
    rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)
      ? Object.keys(rawHeaders as Record<string, unknown>).sort()
      : [];

  return { command, args, url, envKeys, headerKeys };
}

/**
 * 计算单个 MCP server 的稳定指纹。
 * 输出:64 位十六进制 sha256 字符串。
 * 相同输入必然产生相同输出(无时间戳/随机元素)。
 */
export function fingerprintMcpServer(server: Record<string, unknown>): string {
  const id = extractIdentity(server);
  // 稳定 JSON:字段顺序固定,确保序列化结果与 JSON.stringify key 排序无关
  const payload = JSON.stringify({
    command: id.command,
    args: id.args,
    url: id.url,
    envKeys: id.envKeys,
    headerKeys: id.headerKeys,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * 从 raw MCP 配置内容映射计算全量指纹映射。
 * 参数:Map<relPath, rawJsonContent>
 * 返回:Map<"relPath::serverName", sha256hex>
 *
 * 这是主要实现路径;fingerprintMcpServers 是备用/简化接口。
 * 解析失败的文件(非 JSON / 无 mcpServers)静默跳过。
 */
export function fingerprintMcpServersFromRaw(rawContents: Map<string, string>): Map<string, string> {
  const fp = new Map<string, string>();

  for (const [relPath, raw] of rawContents) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 非合法 JSON,跳过(mcp-audit.ts 会单独报 mcp/invalid-json)
      continue;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

    const config = parsed as Record<string, unknown>;
    const servers = config.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;

    for (const [serverName, serverEntry] of Object.entries(servers as Record<string, unknown>)) {
      if (!serverEntry || typeof serverEntry !== 'object' || Array.isArray(serverEntry)) continue;
      const key = `${relPath}::${serverName}`;
      fp.set(key, fingerprintMcpServer(serverEntry as Record<string, unknown>));
    }
  }

  return fp;
}

// ── 基线文件 I/O ──────────────────────────────────────────────────────────────

export const MCP_BASELINE_VERSION = 1;

export interface McpBaselineFile {
  version: number;
  /** key = "<relPath>::<serverName>",value = sha256 hex 指纹 */
  servers: Record<string, string>;
}

// ── 错误类 ────────────────────────────────────────────────────────────────────

export class McpBaselineError extends Error {
  readonly path: string;
  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'McpBaselineError';
    this.path = path;
  }
}

/**
 * 将 MCP server 指纹映射写入磁盘(JSON,2 空格缩进,末尾换行)。
 * keys 排序后写入,便于 git diff 和人工复核。
 */
export async function writeMcpBaseline(filePath: string, fp: Map<string, string>): Promise<void> {
  // 排序 key 确保写出顺序稳定
  const servers: Record<string, string> = {};
  for (const key of [...fp.keys()].sort()) {
    servers[key] = fp.get(key)!;
  }
  const baseline: McpBaselineFile = { version: MCP_BASELINE_VERSION, servers };
  await writeFile(filePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
}

/**
 * 从磁盘加载 MCP 基线文件并返回服务器指纹映射。
 * - ENOENT → 抛 McpBaselineError
 * - JSON 损坏或结构非法 → 抛 McpBaselineError
 */
export async function loadMcpBaseline(filePath: string): Promise<Map<string, string>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new McpBaselineError(`MCP 基线文件不存在: ${filePath}`, filePath, { cause: error });
    }
    throw new McpBaselineError(
      `无法读取 MCP 基线文件 ${filePath}: ${(error as Error).message}`,
      filePath,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new McpBaselineError(
      `MCP 基线文件 JSON 解析失败: ${(error as Error).message}`,
      filePath,
      { cause: error },
    );
  }

  return validateMcpBaseline(parsed, filePath);
}

/**
 * 校验 MCP 基线文件结构并提取指纹映射。
 * 结构非法时抛 McpBaselineError。
 */
export function validateMcpBaseline(raw: unknown, filePath: string): Map<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new McpBaselineError('MCP 基线文件根节点必须是 JSON 对象', filePath);
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.version !== 'number') {
    throw new McpBaselineError('MCP 基线文件缺少 version 字段(必须是数字)', filePath);
  }
  if (!obj.servers || typeof obj.servers !== 'object' || Array.isArray(obj.servers)) {
    throw new McpBaselineError('MCP 基线文件 servers 字段必须是对象', filePath);
  }

  const serversObj = obj.servers as Record<string, unknown>;
  const result = new Map<string, string>();

  for (const [k, v] of Object.entries(serversObj)) {
    if (typeof v !== 'string') {
      throw new McpBaselineError(`MCP 基线文件 servers["${k}"] 的值必须是字符串`, filePath);
    }
    result.set(k, v);
  }

  return result;
}

// ── Diff ──────────────────────────────────────────────────────────────────────

export interface McpBaselineDiff {
  /** 当前存在但基线中指纹不同的 key(command/args/url 变化 → 可能被篡改) */
  changed: string[];
  /** 当前存在但基线中完全没有的 key(新出现的 server) */
  added: string[];
  /** 基线中存在但当前不存在的 key(已移除的 server) */
  removed: string[];
}

/**
 * 对比当前指纹映射与基线。
 * currentFp:本次 audit 计算的指纹 Map。
 * baseline:从文件加载的基线 Map。
 */
export function diffMcpBaseline(
  currentFp: Map<string, string>,
  baseline: Map<string, string>,
): McpBaselineDiff {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [key, hash] of currentFp) {
    if (!baseline.has(key)) {
      added.push(key);
    } else if (baseline.get(key) !== hash) {
      changed.push(key);
    }
  }

  for (const key of baseline.keys()) {
    if (!currentFp.has(key)) {
      removed.push(key);
    }
  }

  return {
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
  };
}

// ── 将 diff 转换为 AuditFinding ───────────────────────────────────────────────

/**
 * 将 McpBaselineDiff 转换为 AuditFinding 列表。
 *
 * changed → mcp/server-config-changed (high):
 *   server 的 command/args/url 与基线不符——可能是 rug-pull 或被篡改,需人工复核。
 *   如果是预期变更,重新运行 --write-mcp-baseline 更新基线即可。
 *
 * added → mcp/server-added (medium):
 *   发现基线中未记录的新 MCP server——请确认来源后更新基线。
 *
 * removed → 不产生 finding:
 *   移除 server 不是安全威胁,无需阻断。
 */
export function mcpDiffToFindings(diff: McpBaselineDiff): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const key of diff.changed) {
    // key 格式: "<relPath>::<serverName>"
    const sep = key.lastIndexOf('::');
    const relPath = sep >= 0 ? key.slice(0, sep) : key;
    const serverName = sep >= 0 ? key.slice(sep + 2) : key;
    findings.push({
      ruleId: 'mcp/server-config-changed',
      severity: 'high',
      file: relPath,
      line: 1,
      excerpt: `[${serverName}] command/args/url 自基线起已变更`,
      message: `MCP server "${serverName}" 的 command/args/url 自基线起已变更——可能是 rug-pull 或被篡改,请复核后重新运行 --write-mcp-baseline`,
    });
  }

  for (const key of diff.added) {
    const sep = key.lastIndexOf('::');
    const relPath = sep >= 0 ? key.slice(0, sep) : key;
    const serverName = sep >= 0 ? key.slice(sep + 2) : key;
    findings.push({
      ruleId: 'mcp/server-added',
      severity: 'medium',
      file: relPath,
      line: 1,
      excerpt: `[${serverName}] 新增 MCP server(基线中未记录)`,
      message: `MCP server "${serverName}" 在基线中不存在——请确认来源可信后重新运行 --write-mcp-baseline`,
    });
  }

  // removed: 不产生 finding(移除 server 不是安全威胁)

  return findings;
}
