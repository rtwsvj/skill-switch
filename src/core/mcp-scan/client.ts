// mcp-scan JSON-RPC 2.0 客户端(stdio + http,零依赖,绝不调用 tools/call)。
//
// 设计要点:
//   1. 统一接口 connectAndListTools(spec, timeoutMs) → { tools, protocolVersion }
//      两种传输走同一条协议序列:initialize → notifications/initialized → tools/list → 断开。
//      全程 4 个 JSON-RPC 帧,绝不发送 tools/call(规格铁律)。
//   2. stdio 与 src/mcp/server.ts 分帧对称:
//      server.ts 怎么读(stdin 行切分 + JSON.parse),client.ts 就怎么写(stdout 行写入 + JSON.stringify)。
//      newline-delimited JSON-RPC,UTF-8。
//   3. stdio 子进程超时:先 SIGTERM,宽限期后再 SIGKILL,绝不"扔出去就算了"。
//   4. http:localhost(http://127.0.0.1 / http://localhost / http://[::1])或 https 任意;
//      其它 http:// 直接拒绝,绝不发出请求。
//   5. 响应体大小上限 2MB,流式读到上限立即 abort,绝不把超大响应读进内存。
//   6. headers / env VALUE 绝不落日志、绝不进基线、绝不在错误信息里出现。
//   7. stdio 不继承父进程环境(只透传配置里显式声明的 env 字段 + 一个安全的 PATH),
//      避免把本机变量无意泄给被审计的 server。
//
// 错误一律结构化(McpScanClientError + code 字段),不抛裸异常。

import { spawn, type ChildProcess } from 'node:child_process';
import { basename } from 'node:path';
import {
  formatArgvForDisplay,
  redactUrlUserinfo,
  sanitizeOutputText,
} from '../security/output-safety.ts';
import {
  createPinnedFetch,
  pinnedFetch,
  type PinnedFetchInit,
  type PinnedResponse,
} from '../security/pinned-http.ts';
import {
  hasUrlCredentials,
  HostResolutionPolicyError,
  type HostResolver,
  isLoopbackHost,
  isPrivateNetworkLiteral,
  isRedirectStatus,
  MAX_SAFE_REDIRECTS,
  resolveRedirectUrl,
  stripSensitiveHeadersForRedirect,
} from '../security/url-safety.ts';
import type { ToolDefinition } from './baseline.ts';
import type { McpServerSpec } from './discover.ts';

/**
 * 可注入的 fetch 形状:PinnedResponse 是 Response 的受控子集(无 text()/json())。
 * 测试注入的假 fetch 返回标准 Response(超集)必须继续可用。
 */
export type McpScanFetchImpl = (
  url: string,
  init?: PinnedFetchInit,
) => Promise<PinnedResponse | Response>;

/**
 * MCP 本地 http transport 专用钉扎实例:allowLoopback 仅此文件此用途。
 * 与公网 https 默认实例分离,绝不共享(协议策略不同)。
 */
const loopbackPinnedFetch = createPinnedFetch({ allowLoopback: true });

// ── 公开错误类型 ─────────────────────────────────────────────────────────────

/** 客户端错误类型,带稳定 code 便于上层映射到 exit 1 + 友好提示。 */
export class McpScanClientError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'insecure-url'      // http:// 远端非 loopback
      | 'invalid-url'       // URL 解析失败
      | 'spawn-failed'      // 子进程启动失败
      | 'timeout'           // 超时
      | 'protocol-error'    // 收到的不是合法 JSON-RPC 2.0
      | 'rpc-error'         // server 返回 JSON-RPC error
      | 'too-large'         // 响应体超过 2MB
      | 'network'           // 其它网络层错误
      | 'redirect-error'    // 重定向缺 Location 或超过上限
      | 'unsupported-method', // 协议层未知方法(防止 server 推任意方法)
  ) {
    super(message);
    this.name = 'McpScanClientError';
  }
}

// ── 协议交互结果 ─────────────────────────────────────────────────────────────

export interface ConnectResult {
  tools: ToolDefinition[];
  /** server 声明的 MCP 协议版本(initialize 响应里的 protocolVersion) */
  protocolVersion: string;
}

// ── 客户端常量 ───────────────────────────────────────────────────────────────

/** 响应体大小上限 2MB(规格硬约束:任何传输收到 >2MB 即断开)。 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** 默认每 server 超时 10 秒(规格硬约束)。 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** stdio 子进程 SIGTERM → SIGKILL 之间的宽限期。 */
const STDIO_KILL_GRACE_MS = 1000;

/** 我们对外声明的 MCP 协议版本(2025-06-18,与 src/mcp/server.ts 保持一致)。 */
export const CLIENT_PROTOCOL_VERSION = '2025-06-18';

// ── JSON-RPC 帧构造工具 ─────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function makeRequest(id: number, method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params };
}

/** 检测响应是否是我们期待的 id(数值),过滤掉对方推送的无关通知。 */
function isMatchingResponse(res: unknown, expectedId: number): res is JsonRpcResponse {
  if (!res || typeof res !== 'object') return false;
  const r = res as JsonRpcResponse;
  return r.jsonrpc === '2.0' && r.id === expectedId;
}

// ── URL 安全断言 ─────────────────────────────────────────────────────────────

/**
 * http URL 安全断言:
 *   - https:// → 公网 host(私网/特殊用途 IP literal 拒绝)
 *   - http://  → host 必须是 loopback(localhost / 127.x.x.x / [::1]),否则拒绝
 *   - 其它协议(ws://, file://, ...) → 拒绝
 *
 * 返回规范化后的 URL,失败抛 McpScanClientError。
 */
export function assertScanUrl(rawUrl: string): URL {
  const safeRawUrl = sanitizeOutputText(redactUrlUserinfo(rawUrl));
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new McpScanClientError(`无法解析的 MCP URL: ${safeRawUrl}`, 'invalid-url');
  }
  if (hasUrlCredentials(u)) {
    throw new McpScanClientError(`MCP URL 不允许内嵌凭据: ${safeRawUrl}`, 'invalid-url');
  }
  if (u.protocol === 'https:') {
    if (isPrivateNetworkLiteral(u.hostname)) {
      throw new McpScanClientError(
        `mcp-scan 不允许 HTTPS 连接私网或特殊用途 IP: ${safeRawUrl}`,
        'insecure-url',
      );
    }
    return u;
  }
  if (u.protocol === 'http:') {
    if (!isLoopbackHost(u.hostname)) {
      throw new McpScanClientError(
        `mcp-scan 仅允许 https:// 公网 host,或 http:// loopback;已拒绝 ${u.protocol}//${sanitizeOutputText(u.host)}`,
        'insecure-url',
      );
    }
    return u;
  }
  throw new McpScanClientError(
    `mcp-scan 仅支持 http(s) URL;已拒绝协议 ${u.protocol}`,
    'invalid-url',
  );
}

// ── stdio 传输 ───────────────────────────────────────────────────────────────

/** stdio 客户端句柄:外部可注入 spawn(测试用)。 */
interface StdioSpawner {
  spawn(
    command: string,
    args: readonly string[],
    options: {
      env: Record<string, string>;
      // 测试用允许任何 stdio 配置;运行时永远是 [pipe, pipe, pipe]
      stdio: ['pipe' | 'ignore' | 'inherit', 'pipe' | 'ignore' | 'inherit', 'pipe' | 'ignore' | 'inherit'];
    },
  ): ChildProcess;
}

/** 把 server 子进程的描述拼成"这会启动一个本地进程: <command> <arg1> <arg2>..." 用于确认提示。 */
export function describeStdioCommand(spec: McpServerSpec): string {
  if (spec.transport !== 'stdio' || !spec.command) return '<unknown>';
  return formatArgvForDisplay(spec.command, spec.args ?? []);
}

/**
 * stdio 传输:spawn 子进程,跑 4 帧协议,关闭子进程,返回工具列表。
 *
 * env 安全:
 *   - 显式 env(spec.env)透传给子进程
 *   - 强制 PATH(若 spec.env 未提供 PATH 字段)指向 process.env.PATH 或空串
 *   - 绝不继承父进程其它 env 字段(避免把 NODE_OPTIONS / SSH_AUTH_SOCK / AWS_* 等
 *     偷偷传给被审计的 server)
 */
export async function connectStdio(
  spec: McpServerSpec,
  timeoutMs: number,
  spawner: StdioSpawner = { spawn: (cmd, args, opts) => spawn(cmd, args, opts) },
): Promise<ConnectResult> {
  if (spec.transport !== 'stdio' || !spec.command) {
    throw new McpScanClientError(`connectStdio 仅支持 stdio transport: ${spec.name}`, 'protocol-error');
  }

  // 构造子进程 env:显式声明 + 一个最小的 PATH(避免子进程 PATH 空导致命令解析失败)
  const env: Record<string, string> = {};
  if (spec.env) {
    for (const [k, v] of Object.entries(spec.env)) env[k] = v;
  }
  if (!Object.hasOwn(env, 'PATH')) {
    env.PATH = process.env.PATH ?? '';
  }

  let child: ChildProcess;
  try {
    child = spawner.spawn(spec.command, spec.args ?? [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new McpScanClientError(
      `启动子进程失败: ${describeStdioCommand(spec)} — ${(e as Error).message}`,
      'spawn-failed',
    );
  }

  // 子进程异常退出(stderr close)→ 整体失败
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  let stdoutData = '';
  let bytesRead = 0;
  let truncated = false;

  // "有数据可读" 信号:每次 stdout 累积新内容时 resolve 一次,然后重新挂一个 promise。
  let resolveData: () => void = () => {};
  const waitForData = (): Promise<void> => new Promise<void>((resolve) => {
    resolveData = resolve;
  });

  // 全局超时:不论协议进行到哪一步,到点必杀
  const timer = setTimeout(() => {
    killChild(child).catch(() => {});
  }, timeoutMs);

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (truncated) return;
    bytesRead += Buffer.byteLength(chunk, 'utf8');
    if (bytesRead > MAX_RESPONSE_BYTES) {
      truncated = true;
      stdoutData = '';
      killChild(child).catch(() => {});
      resolveData();
      return;
    }
    stdoutData += chunk;
    resolveData();
  });

  // stderr 全部吞掉不外抛(诊断信息可走 logger,但绝不外泄 env/header 值)
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', () => {
    // 故意吞掉;若调试需要可在此 process.stderr.write,但绝不能写 header/env value
  });

  const writeFrame = (req: JsonRpcRequest): void => {
    child.stdin?.write(`${JSON.stringify(req)}\n`);
  };

  /**
   * 等到 stdoutData 里出现一个完整行,且 id 匹配 expectedId。
   * 任何时候都会先尝试从当前 buffer 切出已有行;若没有则同时等待"新数据"与"子进程退出",
   * 谁先发生就处理谁——子进程退出若 buffer 仍无完整响应,报 protocol-error。
   */
  const readResponse = async (expectedId: number): Promise<JsonRpcResponse> => {
    for (;;) {
      if (truncated) {
        throw new McpScanClientError(
          `响应体超过 ${MAX_RESPONSE_BYTES} 字节上限,已断开: ${describeStdioCommand(spec)}`,
          'too-large',
        );
      }
      // 先试从现有 buffer 切出
      const idx = stdoutData.indexOf('\n');
      if (idx !== -1) {
        const line = stdoutData.slice(0, idx).trim();
        stdoutData = stdoutData.slice(idx + 1);
        if (!line) continue; // 空行跳过
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new McpScanClientError(
            `JSON-RPC 帧解析失败: ${describeStdioCommand(spec)}`,
            'protocol-error',
          );
        }
        if (isMatchingResponse(parsed, expectedId)) return parsed;
        // 不匹配的 id(可能是 server 推送的其它响应 / 通知响应)→ 跳过继续读
        continue;
      }
      // 缓冲里没有完整行:同时等新数据或子进程退出
      const winner = await Promise.race([
        waitForData().then(() => 'data' as const),
        exitPromise.then(() => 'exit' as const),
      ]);
      if (winner === 'data') {
        // 回到 loop 顶,继续从 buffer 切
        continue;
      }
      // 子进程已退出
      const exitInfo = await exitPromise;
      // 再试一次切 buffer(退出事件后可能 flush 了剩余内容)
      const finalIdx = stdoutData.indexOf('\n');
      if (finalIdx === -1) {
        if (exitInfo.code !== 0 && exitInfo.signal === null) {
          throw new McpScanClientError(
            `MCP 子进程异常退出(exit=${exitInfo.code}): ${describeStdioCommand(spec)}`,
            'protocol-error',
          );
        }
        throw new McpScanClientError(
          `子进程退出但未返回完整 JSON-RPC 响应: ${describeStdioCommand(spec)}`,
          'protocol-error',
        );
      }
      const line = stdoutData.slice(0, finalIdx).trim();
      stdoutData = stdoutData.slice(finalIdx + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new McpScanClientError(
          `JSON-RPC 帧解析失败: ${describeStdioCommand(spec)}`,
          'protocol-error',
        );
      }
      if (isMatchingResponse(parsed, expectedId)) return parsed;
      // 退出后还收到不匹配 id 的响应 → 当作协议错误
      throw new McpScanClientError(
        `子进程退出后收到不期望的 JSON-RPC 响应: ${describeStdioCommand(spec)}`,
        'protocol-error',
      );
    }
  };

  try {
    // 帧 1: initialize
    writeFrame(makeRequest(1, 'initialize', {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'skill-switch-mcp-scan', version: '0' },
    }));
    const initResp = await readResponse(1);
    if (initResp.error) {
      throw new McpScanClientError(
        `initialize 失败: ${initResp.error.message}`,
        'rpc-error',
      );
    }
    const initResult = initResp.result as { protocolVersion?: string; serverInfo?: { name?: string } } | undefined;

    // 帧 2: notifications/initialized(无响应,无需 id)
    writeFrame({ jsonrpc: '2.0', method: 'notifications/initialized' } as unknown as JsonRpcRequest);

    // 帧 3: tools/list
    writeFrame(makeRequest(2, 'tools/list', {}));
    const toolsResp = await readResponse(2);
    if (toolsResp.error) {
      throw new McpScanClientError(
        `tools/list 失败: ${toolsResp.error.message}`,
        'rpc-error',
      );
    }
    const toolsResult = toolsResp.result as { tools?: unknown } | undefined;
    const toolsRaw = Array.isArray(toolsResult?.tools) ? toolsResult!.tools : [];

    const tools: ToolDefinition[] = [];
    for (const t of toolsRaw) {
      if (!t || typeof t !== 'object') continue;
      const obj = t as Record<string, unknown>;
      if (typeof obj.name !== 'string') continue;
      const description = typeof obj.description === 'string' ? obj.description : '';
      const inputSchema = obj.inputSchema;
      tools.push({ name: obj.name, description, inputSchema });
    }

    // 帧 4(逻辑):关闭 stdin → 子进程收到 EOF 自然退出;同时清超时器,绝不再 spawn 新进程
    try { child.stdin?.end(); } catch { /* 忽略 */ }
    clearTimeout(timer);
    // 给子进程一个短暂窗口自己退出;超时则强制杀
    const gracefulKill = killChild(child);
    // 不 await,允许同时继续清理:若子进程已自行退出则忽略
    void gracefulKill.catch(() => {});

    return {
      tools,
      protocolVersion: typeof initResult?.protocolVersion === 'string'
        ? initResult.protocolVersion
        : CLIENT_PROTOCOL_VERSION,
    };
  } catch (e) {
    clearTimeout(timer);
    await killChild(child).catch(() => {});
    throw e;
  }
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  try { child.stdin?.end(); } catch { /* 忽略 */ }
  try { child.kill('SIGTERM'); } catch { /* 忽略 */ }
  // 给宽限期
  await new Promise((r) => setTimeout(r, STDIO_KILL_GRACE_MS));
  if (child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
  }
}

// ── http 传输 ────────────────────────────────────────────────────────────────

/**
 * 解析 http 传输使用的 fetch:
 *   - 显式 fetchImpl → 原样用(测试 mock)
 *   - 仅 hostResolver → createPinnedFetch 一次性实例(测试 DNS;http 带 allowLoopback)
 *   - 都无 → 按协议分实例:https 用默认 pinnedFetch;http 用 loopbackPinnedFetch
 *     (两实例不共享:协议策略不同)
 */
function resolveHttpFetchImpl(
  url: URL,
  fetchImpl: McpScanFetchImpl | undefined,
  hostResolver: HostResolver | undefined,
): McpScanFetchImpl {
  if (fetchImpl) return fetchImpl;
  if (hostResolver) {
    return createPinnedFetch({
      resolver: hostResolver,
      allowLoopback: url.protocol === 'http:',
    });
  }
  return url.protocol === 'http:' ? loopbackPinnedFetch : pinnedFetch;
}

/**
 * 经 body 流读响应并强制 2MB 上限。PinnedResponse 无 text()/json(),一律走流。
 */
async function readHttpBodyCapped(
  res: { body: ReadableStream<Uint8Array> | null },
  pathnameForError: string,
): Promise<string> {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    return '';
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new McpScanClientError(
            `响应体超过 ${MAX_RESPONSE_BYTES} 字节上限,已断开: ${pathnameForError}`,
            'too-large',
          );
        }
        text += decoder.decode(value, { stream: true });
      }
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * http 传输:POST JSON-RPC 到 URL。默认走 pinned-http(连接时 DNS 钉扎)。
 * 超时用 AbortController;响应体限制 2MB(流式读超限即 abort)。
 * POST 为非幂等:pinned-http 只试第一个已验证地址(不重放),属有意语义。
 */
export async function connectHttp(
  spec: McpServerSpec,
  timeoutMs: number,
  fetchImpl?: McpScanFetchImpl,
  hostResolver?: HostResolver,
): Promise<ConnectResult> {
  if (spec.transport !== 'http' || !spec.url) {
    throw new McpScanClientError(`connectHttp 仅支持 http transport: ${spec.name}`, 'protocol-error');
  }
  const url = assertScanUrl(spec.url);
  const resolvedFetch = resolveHttpFetchImpl(url, fetchImpl, hostResolver);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  // 构造请求头:显式声明的 headers 原样发送 + 必要的 Accept
  // 关键:header VALUE 绝不进日志/基线/错误信息(下方错误只用 url.pathname,不打印 header)
  const reqHeaders: Record<string, string> = { accept: 'application/json' };
  if (spec.headers) {
    for (const [k, v] of Object.entries(spec.headers)) reqHeaders[k] = v;
  }

  const postJsonRpc = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    let currentUrl = url;
    let currentHeaders = { ...reqHeaders };
    let redirectsFollowed = 0;
    let res: PinnedResponse | Response;

    for (;;) {
      try {
        // 钉扎在 resolvedFetch 内部完成;循环内不再单独做策略预解析
        // (否则每跳双倍解析且外层结果未被钉扎)。
        res = await resolvedFetch(currentUrl.toString(), {
          method: 'POST',
          signal: ctrl.signal,
          headers: currentHeaders,
          body: JSON.stringify(req),
          redirect: 'manual',
          // 拒绝带 cookie 凭据(与 registry/fetch.ts 同样的零遥测原则)
          credentials: 'omit',
        });
      } catch (e) {
        if (e instanceof HostResolutionPolicyError) {
          throw new McpScanClientError(
            e.message,
            e.code === 'non-public-address' ? 'insecure-url' : 'network',
          );
        }
        if (e instanceof Error && e.name === 'AbortError') {
          throw new McpScanClientError(
            `HTTP 请求超时(>${timeoutMs}ms): ${sanitizeOutputText(currentUrl.pathname)}`,
            'timeout',
          );
        }
        throw new McpScanClientError(
          `HTTP 请求失败: ${sanitizeOutputText(e instanceof Error ? e.message : String(e))}`,
          'network',
        );
      }

      if (!isRedirectStatus(res.status)) break;
      const location = res.headers.get('location');
      if (!location) {
        throw new McpScanClientError('MCP endpoint 重定向缺少 Location 响应头', 'redirect-error');
      }
      if (redirectsFollowed >= MAX_SAFE_REDIRECTS) {
        throw new McpScanClientError(`MCP endpoint 重定向超过 ${MAX_SAFE_REDIRECTS} 次上限`, 'redirect-error');
      }

      let resolved: URL;
      try {
        resolved = resolveRedirectUrl(currentUrl, location);
      } catch {
        throw new McpScanClientError('MCP endpoint 返回无法解析的重定向地址', 'invalid-url');
      }
      if (currentUrl.protocol === 'https:' && resolved.protocol !== 'https:') {
        throw new McpScanClientError('MCP endpoint 重定向不允许从 HTTPS 降级', 'insecure-url');
      }
      const nextUrl = assertScanUrl(resolved.toString());
      currentHeaders = stripSensitiveHeadersForRedirect(currentHeaders, currentUrl, nextUrl);
      currentUrl = nextUrl;
      redirectsFollowed++;
    }

    if (!res.ok) {
      throw new McpScanClientError(
        `MCP endpoint 返回 HTTP ${res.status}: ${sanitizeOutputText(currentUrl.pathname)}`,
        'network',
      );
    }

    const text = await readHttpBodyCapped(res, sanitizeOutputText(currentUrl.pathname));
    try {
      return JSON.parse(text) as JsonRpcResponse;
    } catch {
      throw new McpScanClientError(
        `JSON-RPC 响应解析失败: ${sanitizeOutputText(currentUrl.pathname)}`,
        'protocol-error',
      );
    }
  };

  try {
    // 帧 1: initialize
    const initReq = makeRequest(1, 'initialize', {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'skill-switch-mcp-scan', version: '0' },
    });
    const initResp = await postJsonRpc(initReq);
    if (initResp.error) {
      throw new McpScanClientError(`initialize 失败: ${sanitizeOutputText(initResp.error.message)}`, 'rpc-error');
    }
    const initResult = initResp.result as { protocolVersion?: string } | undefined;

    // 帧 2: notifications/initialized(无响应)
    const notifyReq: JsonRpcRequest = { jsonrpc: '2.0', method: 'notifications/initialized' } as JsonRpcRequest;
    // 通知不期望响应,但仍 POST 过去(部分 server 必须收到这一帧才允许 tools/list)
    // 通知失败不阻断(部分 server 直接 405 / 不实现该 path),catch 后继续
    try {
      await postJsonRpc(notifyReq);
    } catch {
      // 通知失败是可接受的:继续 tools/list
    }

    // 帧 3: tools/list
    const toolsReq = makeRequest(2, 'tools/list', {});
    const toolsResp = await postJsonRpc(toolsReq);
    if (toolsResp.error) {
      throw new McpScanClientError(`tools/list 失败: ${sanitizeOutputText(toolsResp.error.message)}`, 'rpc-error');
    }
    const toolsResult = toolsResp.result as { tools?: unknown } | undefined;
    const toolsRaw = Array.isArray(toolsResult?.tools) ? toolsResult!.tools : [];

    const tools: ToolDefinition[] = [];
    for (const t of toolsRaw) {
      if (!t || typeof t !== 'object') continue;
      const obj = t as Record<string, unknown>;
      if (typeof obj.name !== 'string') continue;
      const description = typeof obj.description === 'string' ? obj.description : '';
      const inputSchema = obj.inputSchema;
      tools.push({ name: obj.name, description, inputSchema });
    }

    clearTimeout(timer);
    return {
      tools,
      protocolVersion: typeof initResult?.protocolVersion === 'string'
        ? initResult.protocolVersion
        : CLIENT_PROTOCOL_VERSION,
    };
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ── 统一入口 ─────────────────────────────────────────────────────────────────

/**
 * 统一入口:按 spec.transport 自动选 stdio 或 http。
 * 异常 → McpScanClientError(结构化,绝不抛裸异常)。
 */
export async function connectAndListTools(
  spec: McpServerSpec,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  opts: { fetchImpl?: McpScanFetchImpl; spawner?: StdioSpawner; hostResolver?: HostResolver } = {},
): Promise<ConnectResult> {
  if (spec.transport === 'stdio') {
    return connectStdio(spec, timeoutMs, opts.spawner);
  }
  if (spec.transport === 'http') {
    return connectHttp(spec, timeoutMs, opts.fetchImpl, opts.hostResolver);
  }
  throw new McpScanClientError(`未知的 transport: ${(spec as { transport?: string }).transport ?? '<undefined>'}`, 'protocol-error');
}

// ── 展示辅助:把 server 描述成单行字符串(供 --list 与确认提示) ───────────────

/** 描述一个 server 的"将要执行的连接",用于确认提示与人类输出。 */
export function describeServer(spec: McpServerSpec): string {
  if (spec.transport === 'stdio') {
    return `stdio: ${formatArgvForDisplay(basename(spec.command ?? '<no-command>'), spec.args ?? [])}`;
  }
  return `http: ${sanitizeOutputText(redactUrlUserinfo(spec.url ?? '<no-url>'))}`;
}
