// v0.8-1 (MCP 配置漂移) + v0.8-3 (统一配置漂移检测,扩展至 settings 文件)。
// 将当前发现的 MCP server 定义及 settings 文件安全结构快照为「基线」,
// 后续 audit 时与基线对比:
//   MCP:   command/args/url 改变 → mcp/server-config-changed (high)
//          新出现 server         → mcp/server-added (medium)
//   设置:  hooks/权限/自动批准变化 → settings/config-changed (high)
//          新出现 settings 文件   → settings/config-added (medium)
// 纯静态,无 spawn/网络/新依赖。
//
// ── MCP 指纹方案 ──────────────────────────────────────────────────────────────
// 指纹 = sha256( 规范化后的 { command, args, url, envKeys(排序), headerKeys(排序) } )
//
// - command/args:决定 MCP server 的实际可执行内容,是 rug-pull 的核心载体。
// - url / serverUrl:远程传输 URL 变化同样是高风险信号。
// - envKeys(排序,仅 KEY 名,不含 VALUE):添加新的含密钥的 env 项本身是一个变化信号。
//   仅存 KEY 名确保真实 secret 值永远不进入基线文件。
// - headerKeys(排序,仅 KEY 名,不含 VALUE):同上——添加鉴权 header 是变化信号。
// - 刻意排除:description、autoApprove、alwaysAllow、type 等非身份字段。
//
// ── Settings 指纹方案 ─────────────────────────────────────────────────────────
// 指纹 = sha256( 规范化后的 { hookEvents, permAllow, permDeny, autoApproveKeys } )
//
// - hookEvents:{ event → command[] } 映射(事件名 → 命令字符串列表,排序后)。
//   Hook 在 agent 事件上自动执行命令,是 settings 文件里最高危的 rug-pull 载体。
//   命令字符串本身作为结构签名纳入指纹(命令是"身份",不是"secret")。
// - permAllow / permDeny:permissions.allow / permissions.deny 数组(排序)。
//   权限列表改变可能悄悄扩权或收窄。
// - autoApproveKeys:出现了 dangerouslySkipPermissions/autoApprove/skipPermissions 等 true
//   或 confirmations/confirmationPolicy 等"never"值的 key 名列表(排序)。
//   只记 key 名,不含 value——value 是 true/"never" 不算 secret,但 key 集合就是结构签名。
// - 刻意排除:纯展示/元数据字段(theme、model、language 等)——不影响安全边界。
// - Secret 安全:hooks 的 env 环境变量 VALUE、permissions 里出现的 token literal 等均
//   不纳入指纹。指纹仅覆盖「命令字符串」与「权限条目字符串」,这些本就是配置结构
//   (不是密钥),故纳入是安全的。若需要完全 hash-only 可换成 sha256(command),
//   但保留明文命令字符串有利于可读性复核——此处保守选择:命令字符串直接纳入。
//
// 基线文件统一格式:
// {
//   "version": 1,
//   "servers": {
//     "<relPath>::server::<serverName>": "<sha256 hex>",   ← MCP server
//     "<relPath>::settings":             "<sha256 hex>"    ← settings 文件
//   }
// }
// MCP key 带 "::server::" 中缀以与 settings key 区分。

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { AuditFinding } from './types.ts';

// ── MCP Server 指纹 ───────────────────────────────────────────────────────────

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

function extractMcpIdentity(server: Record<string, unknown>): McpServerIdentity {
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
  const id = extractMcpIdentity(server);
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
 * 返回:Map<"relPath::server::<serverName>", sha256hex>
 *
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
      // 使用 "::server::" 中缀区分 MCP server key 与 settings key
      const key = `${relPath}::server::${serverName}`;
      fp.set(key, fingerprintMcpServer(serverEntry as Record<string, unknown>));
    }
  }

  return fp;
}

// ── Settings 文件指纹 ─────────────────────────────────────────────────────────

/**
 * settings 文件安全结构身份(用于指纹计算)。
 * 仅包含影响安全边界的字段;纯展示字段排除在外。
 */
interface SettingsIdentity {
  /** event → 排序后的 command 字符串列表 */
  hookEvents: Record<string, string[]>;
  /** permissions.allow 数组,排序 */
  permAllow: string[];
  /** permissions.deny 数组,排序 */
  permDeny: string[];
  /**
   * 出现了自动批准/跳过确认语义的 key 名列表(排序)。
   * 只记 key 名——这是结构标记,不是 secret 值。
   */
  autoApproveKeys: string[];
}

/** 具有"自动批准"布尔语义的 key 名集合(与 settings-audit.ts 保持一致) */
const AUTO_APPROVE_BOOL_KEYS: ReadonlySet<string> = new Set([
  'dangerouslySkipPermissions',
  'autoApprove',
  'skipPermissions',
]);

/** 具有"永不确认"字符串语义的确认策略 key 名集合(与 settings-audit.ts 保持一致) */
const CONFIRMATION_POLICY_KEYS: ReadonlySet<string> = new Set([
  'confirmations',
  'confirmationPolicy',
  'approval',
  'approvalMode',
]);

/** 表示"永不确认"的字符串值 */
const CONFIRMATION_NEVER_VALUES: ReadonlySet<string> = new Set([
  'never', 'none', 'off', 'disable', 'disabled', 'skip',
]);

/**
 * 递归收集对象中出现了自动批准/跳过确认语义的 key 名。
 * 与 settings-audit.ts 的检测逻辑镜像,但只收集 key 名,不产生 finding。
 */
function collectAutoApproveKeys(obj: unknown, out: Set<string>): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (AUTO_APPROVE_BOOL_KEYS.has(key) && value === true) {
      out.add(key);
    }
    if (CONFIRMATION_POLICY_KEYS.has(key)) {
      const isNeverBool = value === false;
      const isNeverStr = typeof value === 'string' && CONFIRMATION_NEVER_VALUES.has(value.toLowerCase());
      if (isNeverBool || isNeverStr) {
        out.add(key);
      }
    }
    if (value && typeof value === 'object') {
      collectAutoApproveKeys(value, out);
    }
  }
}

/**
 * 从 settings 对象中提取安全相关结构身份。
 * secret 安全:命令字符串本身纳入(命令不是 secret,它是"身份");
 *             env VALUE / token literal 不纳入(这些是 secret)。
 */
function extractSettingsIdentity(settings: Record<string, unknown>): SettingsIdentity {
  // ── 1. hooks ─────────────────────────────────────────────────────────────────
  // hooks 形如 { PreToolUse: [{ command: "..." }], ... }
  // 或 { PreToolUse: [{ commands: ["...", "..."] }], ... }
  const hookEvents: Record<string, string[]> = {};
  if (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)) {
    for (const [event, hookList] of Object.entries(settings.hooks as Record<string, unknown>)) {
      const items = Array.isArray(hookList) ? hookList : [hookList];
      const cmds: string[] = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        if (typeof record.command === 'string') cmds.push(record.command);
        if (Array.isArray(record.commands)) {
          for (const c of record.commands) {
            if (typeof c === 'string') cmds.push(c);
          }
        }
      }
      if (cmds.length > 0) {
        hookEvents[event] = cmds.sort();
      }
    }
  }

  // ── 2. permissions allow / deny ───────────────────────────────────────────────
  const permAllow: string[] = [];
  const permDeny: string[] = [];
  if (settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions)) {
    const perms = settings.permissions as Record<string, unknown>;
    if (Array.isArray(perms.allow)) {
      for (const e of perms.allow) {
        if (typeof e === 'string') permAllow.push(e);
      }
    }
    if (Array.isArray(perms.deny)) {
      for (const e of perms.deny) {
        if (typeof e === 'string') permDeny.push(e);
      }
    }
  }

  // ── 3. auto-approve / skip-confirmation keys ─────────────────────────────────
  const autoApproveKeySet = new Set<string>();
  collectAutoApproveKeys(settings, autoApproveKeySet);

  return {
    hookEvents,
    permAllow: permAllow.sort(),
    permDeny: permDeny.sort(),
    autoApproveKeys: [...autoApproveKeySet].sort(),
  };
}

/**
 * 计算单个 settings 文件内容的稳定指纹。
 * 只对安全相关结构(hooks/permissions/auto-approve)签名;secret 值不进入指纹。
 * 非 JSON / 无安全相关字段的文件返回空内容的 sha256(固定值)。
 */
export function fingerprintSettingsFile(rawContent: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    // 无法解析:对空结构签名,保证稳定
    parsed = {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    parsed = {};
  }

  const id = extractSettingsIdentity(parsed as Record<string, unknown>);
  const payload = JSON.stringify({
    hookEvents: id.hookEvents,
    permAllow: id.permAllow,
    permDeny: id.permDeny,
    autoApproveKeys: id.autoApproveKeys,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * 从 raw settings 文件内容映射计算全量指纹映射。
 * 参数:Map<relPath, rawJsonContent>
 * 返回:Map<"relPath::settings", sha256hex>
 *
 * 解析失败的文件静默处理(对空结构签名)。
 */
export function fingerprintSettingsFilesFromRaw(rawContents: Map<string, string>): Map<string, string> {
  const fp = new Map<string, string>();
  for (const [relPath, raw] of rawContents) {
    const key = `${relPath}::settings`;
    fp.set(key, fingerprintSettingsFile(raw));
  }
  return fp;
}

// ── 基线文件 I/O ──────────────────────────────────────────────────────────────

export const CONFIG_BASELINE_VERSION = 1;

export interface ConfigBaselineFile {
  version: number;
  /**
   * 统一指纹存储:
   *   MCP server key:    "<relPath>::server::<serverName>"
   *   settings file key: "<relPath>::settings"
   */
  servers: Record<string, string>;
}

// ── 错误类 ────────────────────────────────────────────────────────────────────

export class ConfigBaselineError extends Error {
  readonly path: string;
  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigBaselineError';
    this.path = path;
  }
}

/**
 * 将统一指纹映射写入磁盘(JSON,2 空格缩进,末尾换行)。
 * keys 排序后写入,便于 git diff 和人工复核。
 */
export async function writeConfigBaseline(filePath: string, fp: Map<string, string>): Promise<void> {
  const servers: Record<string, string> = {};
  for (const key of [...fp.keys()].sort()) {
    servers[key] = fp.get(key)!;
  }
  const baseline: ConfigBaselineFile = { version: CONFIG_BASELINE_VERSION, servers };
  await writeFile(filePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
}

/**
 * 从磁盘加载配置基线文件并返回统一指纹映射。
 * - ENOENT → 抛 ConfigBaselineError
 * - JSON 损坏或结构非法 → 抛 ConfigBaselineError
 */
export async function loadConfigBaseline(filePath: string): Promise<Map<string, string>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigBaselineError(`配置基线文件不存在: ${filePath}`, filePath, { cause: error });
    }
    throw new ConfigBaselineError(
      `无法读取配置基线文件 ${filePath}: ${(error as Error).message}`,
      filePath,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigBaselineError(
      `配置基线文件 JSON 解析失败: ${(error as Error).message}`,
      filePath,
      { cause: error },
    );
  }

  return validateConfigBaseline(parsed, filePath);
}

/**
 * 校验配置基线文件结构并提取指纹映射。
 * 结构非法时抛 ConfigBaselineError。
 */
export function validateConfigBaseline(raw: unknown, filePath: string): Map<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigBaselineError('配置基线文件根节点必须是 JSON 对象', filePath);
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.version !== 'number') {
    throw new ConfigBaselineError('配置基线文件缺少 version 字段(必须是数字)', filePath);
  }
  if (!obj.servers || typeof obj.servers !== 'object' || Array.isArray(obj.servers)) {
    throw new ConfigBaselineError('配置基线文件 servers 字段必须是对象', filePath);
  }

  const serversObj = obj.servers as Record<string, unknown>;
  const result = new Map<string, string>();

  for (const [k, v] of Object.entries(serversObj)) {
    if (typeof v !== 'string') {
      throw new ConfigBaselineError(`配置基线文件 servers["${k}"] 的值必须是字符串`, filePath);
    }
    result.set(k, v);
  }

  return result;
}

// ── Diff ──────────────────────────────────────────────────────────────────────

export interface ConfigBaselineDiff {
  /** 当前存在但基线中指纹不同的 key */
  changed: string[];
  /** 当前存在但基线中完全没有的 key */
  added: string[];
  /** 基线中存在但当前不存在的 key */
  removed: string[];
}

/**
 * 对比当前指纹映射与基线。
 * currentFp:本次 audit 计算的指纹 Map(MCP + settings 合并)。
 * baseline:从文件加载的基线 Map。
 */
export function diffConfigBaseline(
  currentFp: Map<string, string>,
  baseline: Map<string, string>,
): ConfigBaselineDiff {
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
 * 将 ConfigBaselineDiff 转换为 AuditFinding 列表。
 *
 * MCP server key 格式:  "<relPath>::server::<serverName>"
 * Settings file key 格式:"<relPath>::settings"
 *
 * MCP changed → mcp/server-config-changed (high)
 * MCP added   → mcp/server-added (medium)
 * Settings changed → settings/config-changed (high)
 * Settings added   → settings/config-added (medium)
 * removed → 不产生 finding(移除不是安全威胁)
 */
export function configDiffToFindings(diff: ConfigBaselineDiff): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const key of diff.changed) {
    if (key.includes('::server::')) {
      // MCP server 变化
      const serverSep = key.lastIndexOf('::server::');
      const relPath = key.slice(0, serverSep);
      const serverName = key.slice(serverSep + '::server::'.length);
      findings.push({
        ruleId: 'mcp/server-config-changed',
        severity: 'high',
        file: relPath,
        line: 1,
        excerpt: `[${serverName}] command/args/url 自基线起已变更`,
        message: `MCP server "${serverName}" 的 command/args/url 自基线起已变更——可能是 rug-pull 或被篡改,请复核后重新运行 --write-config-baseline`,
      });
    } else if (key.endsWith('::settings')) {
      // Settings 文件变化
      const relPath = key.slice(0, key.length - '::settings'.length);
      findings.push({
        ruleId: 'settings/config-changed',
        severity: 'high',
        file: relPath,
        line: 1,
        excerpt: `[${relPath}] hooks/permissions/auto-approve 自基线起已变更`,
        message: `Settings 文件 "${relPath}" 的 hooks/permissions/auto-approve 自基线起已变更——可能是 rug-pull 或被篡改,请复核后重新运行 --write-config-baseline`,
      });
    }
  }

  for (const key of diff.added) {
    if (key.includes('::server::')) {
      const serverSep = key.lastIndexOf('::server::');
      const relPath = key.slice(0, serverSep);
      const serverName = key.slice(serverSep + '::server::'.length);
      findings.push({
        ruleId: 'mcp/server-added',
        severity: 'medium',
        file: relPath,
        line: 1,
        excerpt: `[${serverName}] 新增 MCP server(基线中未记录)`,
        message: `MCP server "${serverName}" 在基线中不存在——请确认来源可信后重新运行 --write-config-baseline`,
      });
    } else if (key.endsWith('::settings')) {
      const relPath = key.slice(0, key.length - '::settings'.length);
      findings.push({
        ruleId: 'settings/config-added',
        severity: 'medium',
        file: relPath,
        line: 1,
        excerpt: `[${relPath}] 新出现的 settings 文件(基线中未记录)`,
        message: `Settings 文件 "${relPath}" 在基线中不存在——请确认内容可信后重新运行 --write-config-baseline`,
      });
    }
  }

  // removed: 不产生 finding(移除不是安全威胁)

  return findings;
}
