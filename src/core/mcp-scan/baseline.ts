// mcp-scan 工具定义 rug-pull 基线(运行时维度,与 config-baseline.ts 的"配置维度"互补)。
//
// 用途:
//   - server 首次扫描时建立基线,后续扫描对比工具定义哈希,发现 rug-pull(描述/参数被偷偷改)。
//   - 与 config-baseline.ts 的区别:
//       config-baseline 关注 command/args/url 等"身份"字段(server 的运行方式)
//       mcp-scan-baseline 关注 name/description/inputSchema(server 暴露给 agent 的工具语义)
//     两者独立运行,各自管各自的基线文件,不互相覆盖。
//
// 基线文件位置: <home>/.skill-switch/mcp-scan-baseline.json
//
// 基线文件格式(对应规格):
//   {
//     "version": 1,
//     "servers": {
//       "<relPath>::<serverName>": {
//         "<toolName>": "<sha256-hex>",
//         ...
//       },
//       ...
//     }
//   }
//
// 哈希算法:
//   sha256( tool.name + '|' + tool.description + '|' + canonicalJson(tool.inputSchema) )
//   - description 用于检测"工具描述被注入恶意指令"(prompt-injection 类)
//   - inputSchema 用于检测"参数 schema 被改成外渗路径/必填 secret"(tool-poisoning 类)
//   - canonicalJson 用稳定 key 排序的 JSON.stringify,确保 schema 顺序不影响哈希
//   - name 自身也纳入,确保改名也被检测
//
// 安全姿态:
//   - 工具 description/inputSchema 是 server 主动声明的元数据,公开性质,
//     写入基线文件不构成 secret 泄露。
//   - env VALUE 与 headers VALUE 不进入基线(由 client.ts 控制不进 server 指纹;此处也根本不接收)。

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 基线文件版本号(用于未来格式升级的兼容判断)。 */
export const MCP_SCAN_BASELINE_VERSION = 1;

/** 基线文件名(放在 <home>/.skill-switch/ 下)。 */
export const MCP_SCAN_BASELINE_FILENAME = 'mcp-scan-baseline.json';

/** 计算 <home>/.skill-switch/mcp-scan-baseline.json 的绝对路径。 */
export function mcpScanBaselinePath(home: string): string {
  return join(home, '.skill-switch', MCP_SCAN_BASELINE_FILENAME);
}

// ── 工具指纹 ─────────────────────────────────────────────────────────────────

/**
 * 工具定义:严格只接收 name/description/inputSchema 三个字段,绝不解码其他东西。
 * inputSchema 用 unknown 收敛,所有访问都做 typeof 校验。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** MCP 工具的 JSON Schema(inputSchema),未知结构。 */
  inputSchema: unknown;
}

/**
 * 把 inputSchema 序列化为稳定 JSON。
 * 实现:对对象递归按 key 排序后 stringify;数组按原顺序(数组语义对顺序敏感);
 * 原始类型直返。
 *
 * 这样不同运行间即便 JSON 字段顺序不一致也能产生相同哈希。
 */
export function canonicalJson(value: unknown): string {
  // undefined 显式降级为 'null':JSON.stringify(undefined) 返回的不是字符串,
  // 会违反本函数的 string 契约(tool 缺 inputSchema 时就会传进 undefined)。
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalJson(v));
    return `[${items.join(',')}]`;
  }
  // 对象:按 key 排序
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * 计算单个工具定义的稳定指纹。
 * 输出:64 位十六进制 sha256 字符串。
 *
 * 哈希域:name + '|' + description + '|' + canonicalJson(inputSchema)
 *   - '|' 作为分隔符,任何字段里出现 '|' 也只是进入哈希值,不破坏唯一性。
 *   - 描述/参数 schema 任何变化都会改变指纹 → rug-pull 检测成立。
 */
export function fingerprintTool(tool: ToolDefinition): string {
  const payload = `${tool.name}|${tool.description}|${canonicalJson(tool.inputSchema)}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ── 基线文件结构 ──────────────────────────────────────────────────────────────

/** 基线文件:serverKey → toolName → sha256。 */
export interface McpScanBaselineFile {
  version: number;
  servers: Record<string, Record<string, string>>;
}

/** 内存中的基线表示(直接用嵌套 Map,与文件格式一一对应)。 */
export type McpScanBaselineMap = Map<string, Map<string, string>>;

// ── I/O ──────────────────────────────────────────────────────────────────────

/**
 * 把嵌套 Map 写入基线文件(JSON,2 空格缩进,末尾换行;key 全排序便于 git diff)。
 */
export async function writeMcpScanBaseline(
  filePath: string,
  baseline: McpScanBaselineMap,
): Promise<void> {
  const servers: Record<string, Record<string, string>> = {};
  const sortedServerKeys = [...baseline.keys()].sort();
  for (const serverKey of sortedServerKeys) {
    const toolMap = baseline.get(serverKey)!;
    const toolsObj: Record<string, string> = {};
    const sortedToolKeys = [...toolMap.keys()].sort();
    for (const toolName of sortedToolKeys) {
      toolsObj[toolName] = toolMap.get(toolName)!;
    }
    servers[serverKey] = toolsObj;
  }
  const file: McpScanBaselineFile = { version: MCP_SCAN_BASELINE_VERSION, servers };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/**
 * 从磁盘加载基线文件,返回嵌套 Map。
 * - ENOENT → 抛 McpScanBaselineError
 * - JSON 损坏 / 结构非法 → 抛 McpScanBaselineError
 */
export async function loadMcpScanBaseline(filePath: string): Promise<McpScanBaselineMap> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new McpScanBaselineError(`mcp-scan 基线文件不存在: ${filePath}`, filePath, { cause: e });
    }
    throw new McpScanBaselineError(
      `无法读取 mcp-scan 基线文件 ${filePath}: ${(e as Error).message}`,
      filePath,
      { cause: e },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new McpScanBaselineError(
      `mcp-scan 基线文件 JSON 解析失败: ${(e as Error).message}`,
      filePath,
      { cause: e },
    );
  }

  return validateMcpScanBaseline(parsed, filePath);
}

/**
 * 校验内存中的基线结构并转成嵌套 Map。
 * 结构非法 → 抛 McpScanBaselineError。
 */
export function validateMcpScanBaseline(
  raw: unknown,
  filePath: string,
): McpScanBaselineMap {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new McpScanBaselineError('mcp-scan 基线文件根节点必须是 JSON 对象', filePath);
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.version !== 'number') {
    throw new McpScanBaselineError(
      'mcp-scan 基线文件缺少 version 字段(必须是数字)',
      filePath,
    );
  }
  if (!obj.servers || typeof obj.servers !== 'object' || Array.isArray(obj.servers)) {
    throw new McpScanBaselineError('mcp-scan 基线文件 servers 字段必须是对象', filePath);
  }

  const result: McpScanBaselineMap = new Map();
  const serversObj = obj.servers as Record<string, unknown>;

  for (const [serverKey, toolsEntry] of Object.entries(serversObj)) {
    if (!toolsEntry || typeof toolsEntry !== 'object' || Array.isArray(toolsEntry)) {
      throw new McpScanBaselineError(
        `mcp-scan 基线文件 servers["${serverKey}"] 必须是对象`,
        filePath,
      );
    }
    const toolsObj = toolsEntry as Record<string, unknown>;
    const inner = new Map<string, string>();
    for (const [toolName, hash] of Object.entries(toolsObj)) {
      if (typeof hash !== 'string') {
        throw new McpScanBaselineError(
          `mcp-scan 基线文件 servers["${serverKey}"]["${toolName}"] 必须是字符串`,
          filePath,
        );
      }
      inner.set(toolName, hash);
    }
    result.set(serverKey, inner);
  }

  return result;
}

/** mcp-scan 基线专用错误类型;消息稳定便于上层映射到 exit 1 + stderr 友好提示。 */
export class McpScanBaselineError extends Error {
  readonly path: string;
  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'McpScanBaselineError';
    this.path = path;
  }
}

// ── 工具列表 → 当前基线指纹 ───────────────────────────────────────────────────

/**
 * 把"本次扫描到的工具列表"折算成当前基线指纹映射。
 * 输入:serverKey → 工具列表
 * 输出:serverKey → (toolName → sha256),缺失字段(描述/schema)自动降级为空串。
 */
export function buildCurrentBaseline(
  servers: Map<string, ToolDefinition[]>,
): McpScanBaselineMap {
  const out: McpScanBaselineMap = new Map();
  for (const [serverKey, tools] of servers) {
    const inner = new Map<string, string>();
    for (const t of tools) {
      inner.set(t.name, fingerprintTool(t));
    }
    out.set(serverKey, inner);
  }
  return out;
}

// ── 差异与 finding ───────────────────────────────────────────────────────────

/** 单条 tool 变化的详情(供 scan.ts 转 finding)。 */
export interface ToolDiff {
  serverKey: string;
  toolName: string;
  /** changed / added / removed */
  kind: 'changed' | 'added' | 'removed';
}

/**
 * 对比当前工具指纹与基线:
 * - 当前存在 + 基线存在 + 哈希不同 → changed(rug-pull 嫌疑)
 * - 当前存在 + 基线不存在 → added(新工具)
 * - 基线存在 + 当前不存在 → removed(已消失;不产 finding,只在人类输出里提示)
 */
export function diffToolBaseline(
  current: McpScanBaselineMap,
  baseline: McpScanBaselineMap,
): ToolDiff[] {
  const diffs: ToolDiff[] = [];
  for (const [serverKey, currentTools] of current) {
    const baselineTools = baseline.get(serverKey);
    if (!baselineTools) {
      // 整 server 首次出现 → 全部工具视为 added
      for (const toolName of currentTools.keys()) {
        diffs.push({ serverKey, toolName, kind: 'added' });
      }
      continue;
    }
    for (const [toolName, hash] of currentTools) {
      const baselineHash = baselineTools.get(toolName);
      if (baselineHash === undefined) {
        diffs.push({ serverKey, toolName, kind: 'added' });
      } else if (baselineHash !== hash) {
        diffs.push({ serverKey, toolName, kind: 'changed' });
      }
    }
    for (const toolName of baselineTools.keys()) {
      if (!currentTools.has(toolName)) {
        diffs.push({ serverKey, toolName, kind: 'removed' });
      }
    }
  }
  // 稳定排序:先 serverKey 再 toolName,便于跨 run 比对
  diffs.sort((a, b) => {
    if (a.serverKey !== b.serverKey) return a.serverKey < b.serverKey ? -1 : 1;
    if (a.toolName !== b.toolName) return a.toolName < b.toolName ? -1 : 1;
    const order = { changed: 0, added: 1, removed: 2 };
    return order[a.kind] - order[b.kind];
  });
  return diffs;
}

/**
 * 判断基线是否"为空"(尚未建立或没有覆盖任何 server)。
 * 用于 CLI 决定输出"已建立基线"还是"对比基线"。
 */
export function isBaselineEmpty(baseline: McpScanBaselineMap): boolean {
  if (baseline.size === 0) return true;
  for (const inner of baseline.values()) {
    if (inner.size > 0) return false;
  }
  return true;
}