// Registry HTTP 取数层(C 线)——本工具唯一的"主动联网"出口。
//
// 安全姿态(不可协商,见 docs/registry-integration-plan.md §0):
//   1. 纯 opt-in:本模块只被 `registry` 命令显式调用时才执行;import 本文件不触发任何网络。
//   2. 仅 HTTPS:http:// 一律拒绝(防降级 / 明文窃听)。
//   3. 零遥测:不带 user-agent 指纹、不带本机信息;只发一个最小的 `accept: application/json`。
//      默认不带任何凭据 / authorization。唯一例外:调用方**显式**传 `bearerToken`(如 SkillsMP 等
//      需鉴权源,token 由用户经环境变量自带),此时附加 `authorization: Bearer <token>`——token 只进
//      请求头、绝不进 URL 或任何错误信息(错误只含 rawUrl),且只发往调用方指定的那个 HTTPS 目标。
//   4. 限大小:响应体超上限即中止(防超大响应 DoS / OOM)。
//   5. 限时:请求超时即 abort。
//   6. 校验 content-type:必须含 json,否则拒绝(防把 HTML 错误页当数据解析)。
//
// 零新依赖:用 Node 内置 `fetch` + `JSON.parse`。fetchImpl 可注入,测试全程 mock,零真实网络。
// 本文件不引用模块 URL 元数据(那会崩 SEA),也不 import node:http(s)/net(由测试哨兵把关)。

import { redactUrlUserinfo, sanitizeOutputText } from '../security/output-safety.ts';
import {
  assertResolvedHostPolicy,
  defaultHostResolver,
  hasUrlCredentials,
  HostResolutionPolicyError,
  type HostResolver,
  isPrivateNetworkLiteral,
  isRedirectStatus,
  MAX_SAFE_REDIRECTS,
  resolveRedirectUrl,
  stripSensitiveHeadersForRedirect,
} from '../security/url-safety.ts';

/** 默认请求超时(毫秒)。 */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** 默认响应体大小上限(字节);超限即中止。 */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

export interface FetchJsonOptions {
  /** 注入 fetch(测试用);默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 请求超时(毫秒)。 */
  timeoutMs?: number;
  /** 响应体大小上限(字节)。 */
  maxBytes?: number;
  /**
   * 可选 Bearer token(仅需鉴权的源用,如 SkillsMP;由用户经环境变量自带)。
   * 设置后附加 `authorization: Bearer <token>`——只进请求头、绝不进 URL 或错误信息,
   * 且只发往本次请求的 HTTPS 目标。缺省(绝大多数源)不带任何 authorization。
   */
  bearerToken?: string;
  /** DNS resolver injection for tests; production defaults to node:dns lookup(all=true). */
  hostResolver?: HostResolver;
}

/** 取数层错误:带稳定 code,便于上层归类 / 测试断言。 */
export class RegistryFetchError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'insecure-url' // 非 https://
      | 'invalid-url' // URL 无法解析
      | 'http-error' // 非 2xx
      | 'not-json' // content-type 不含 json
      | 'too-large' // 响应体超上限
      | 'timeout' // 超时 abort
      | 'parse-error' // JSON.parse 失败
      | 'redirect-error' // 重定向缺 Location 或超过上限
      | 'network', // 其它网络层错误
  ) {
    super(message);
    this.name = 'RegistryFetchError';
  }
}

/** 校验 URL 必须是 https://(opt-in 网络的硬护栏)。 */
export function assertHttpsUrl(rawUrl: string): URL {
  const safeRawUrl = sanitizeOutputText(redactUrlUserinfo(rawUrl));
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new RegistryFetchError(`无法解析的 URL:${safeRawUrl}`, 'invalid-url');
  }
  if (u.protocol !== 'https:') {
    throw new RegistryFetchError(
      `仅允许 https:// 的注册表地址(已拒绝 ${u.protocol}//…):${safeRawUrl}`,
      'insecure-url',
    );
  }
  if (hasUrlCredentials(u)) {
    throw new RegistryFetchError(`注册表 URL 不允许内嵌凭据:${safeRawUrl}`, 'invalid-url');
  }
  if (isPrivateNetworkLiteral(u.hostname)) {
    throw new RegistryFetchError(`注册表 URL 不允许私网或特殊用途 IP:${safeRawUrl}`, 'insecure-url');
  }
  return u;
}

/** content-type 是否表示 JSON(忽略大小写、容忍 charset 参数与 +json 后缀)。 */
function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const v = contentType.toLowerCase();
  return v.includes('application/json') || v.includes('+json') || v.includes('text/json');
}

/**
 * 只读、HTTPS-only、限时、限大小、零遥测地取一个 JSON 文档。
 *
 * - 拒绝 http://;校验响应 content-type 含 json;
 * - 流式读取响应体并在超过 maxBytes 时立即 abort(不把超大响应读进内存);
 * - 超时 abort;非 2xx / 非 JSON / 解析失败都抛带 code 的 RegistryFetchError。
 *
 * 绝不带凭据、不带自定义 user-agent / 指纹。
 */
export async function fetchJson<T = unknown>(
  rawUrl: string,
  opts: FetchJsonOptions = {},
): Promise<T> {
  const url = assertHttpsUrl(rawUrl);
  const initialUrlForDisplay = sanitizeOutputText(redactUrlUserinfo(rawUrl));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const hostResolver = opts.hostResolver ?? defaultHostResolver;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new RegistryFetchError('请求超时', 'timeout')), timeoutMs);

  try {
    // 零遥测:只发一个最小的 accept 头;不带 user-agent / cookie / 任何本机信息。
    // 仅当调用方显式传 bearerToken 时附加 authorization(见 FetchJsonOptions.bearerToken)。
    let headers: Record<string, string> = { accept: 'application/json' };
    if (opts.bearerToken) headers.authorization = `Bearer ${opts.bearerToken}`;

    let currentUrl = url;
    let redirectsFollowed = 0;
    let res: Response;
    for (;;) {
      try {
        await assertResolvedHostPolicy(currentUrl, { resolver: hostResolver });
      } catch (error) {
        if (error instanceof HostResolutionPolicyError) {
          throw new RegistryFetchError(
            error.message,
            error.code === 'non-public-address' ? 'insecure-url' : 'network',
          );
        }
        throw error;
      }
      res = await fetchImpl(currentUrl.toString(), {
        signal: ctrl.signal,
        headers,
        redirect: 'manual',
        // 永不带 cookie 凭据(即便目标同源也不附 cookie);authorization 仅在上面显式附加。
        credentials: 'omit',
      });

      if (!isRedirectStatus(res.status)) break;
      const location = res.headers.get('location');
      if (!location) {
        throw new RegistryFetchError('注册表重定向缺少 Location 响应头', 'redirect-error');
      }
      if (redirectsFollowed >= MAX_SAFE_REDIRECTS) {
        throw new RegistryFetchError(`注册表重定向超过 ${MAX_SAFE_REDIRECTS} 次上限`, 'redirect-error');
      }

      let resolved: URL;
      try {
        resolved = resolveRedirectUrl(currentUrl, location);
      } catch {
        throw new RegistryFetchError('注册表返回无法解析的重定向地址', 'invalid-url');
      }
      const nextUrl = assertHttpsUrl(resolved.toString());
      headers = stripSensitiveHeadersForRedirect(headers, currentUrl, nextUrl);
      currentUrl = nextUrl;
      redirectsFollowed++;
    }

    const responseUrlForDisplay = sanitizeOutputText(redactUrlUserinfo(currentUrl.toString()));
    if (!res.ok) {
      throw new RegistryFetchError(`注册表返回 HTTP ${res.status}:${responseUrlForDisplay}`, 'http-error');
    }
    if (!isJsonContentType(res.headers.get('content-type'))) {
      throw new RegistryFetchError(
        `响应不是 JSON(content-type=${sanitizeOutputText(res.headers.get('content-type') ?? '空')}):${responseUrlForDisplay}`,
        'not-json',
      );
    }

    const text = await readBodyCapped(res, maxBytes, responseUrlForDisplay);
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new RegistryFetchError(
        `响应 JSON 解析失败:${sanitizeOutputText(e instanceof Error ? e.message : String(e))}`,
        'parse-error',
      );
    }
  } catch (e) {
    if (e instanceof RegistryFetchError) throw e;
    if (e instanceof Error && e.name === 'AbortError') {
      throw new RegistryFetchError(`请求超时(>${timeoutMs}ms):${initialUrlForDisplay}`, 'timeout');
    }
    throw new RegistryFetchError(
      `网络请求失败:${sanitizeOutputText(e instanceof Error ? e.message : String(e))}`,
      'network',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读响应体但设字节上限:能流式读就流式累加(超限立刻中止,绝不把超大响应读进内存);
 * 拿不到 reader 的实现(如简易 mock)退化为先读文本再按字节长度校验。
 */
async function readBodyCapped(res: Response, maxBytes: number, rawUrl: string): Promise<string> {
  // 优先用 Content-Length 提前拒绝(若服务器诚实地给了长度)。
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RegistryFetchError(`响应体过大(声明 ${declared} > 上限 ${maxBytes} 字节):${rawUrl}`, 'too-large');
  }

  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let out = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          if (received > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new RegistryFetchError(`响应体超过上限 ${maxBytes} 字节,已中止:${rawUrl}`, 'too-large');
          }
          out += decoder.decode(value, { stream: true });
        }
      }
      out += decoder.decode();
      return out;
    } finally {
      reader.releaseLock?.();
    }
  }

  // 没有可流式读的 body(mock / 旧实现):退化为先读文本再校验字节长度。
  const text = await res.text();
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maxBytes) {
    throw new RegistryFetchError(`响应体过大(${bytes} > 上限 ${maxBytes} 字节):${rawUrl}`, 'too-large');
  }
  return text;
}
