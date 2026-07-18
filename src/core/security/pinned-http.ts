// DNS 连接时钉扎的唯一受控 HTTP 出口(设计:2026-07-18-dns-pinning-design,方案 A)。
//
// 威胁模型:assertResolvedHostPolicy 的校验解析与 HTTP 客户端的连接解析是两次独立
// DNS 查询——恶意权威 DNS 可在两次之间 rebind(先答公网过校验,再答私网实连),
// 把请求打进内网/云元数据。本模块把两步合一:每个请求恰好解析一次,策略校验通过的
// 地址列表被逐字钉进 socket 连接(node:https 的 lookup 选项),期间绝不重新解析。
//
// 安全性质:
//   - 一次解析:resolveVerifiedAddresses 的返回就是连接目的地;失败换下一个已验证
//     地址,绝不回落到系统 DNS 或未钉扎路径。
//   - TLS 语义不变:lookup 只改 socket 目的地址,SNI 与证书主机名校验仍按域名
//     (hostname 传域名,Node 默认 servername=hostname)。
//   - 协议边界:仅 https:;http: 仅当调用方显式 allowLoopback(MCP 本地 transport),
//     且地址仍须过 loopback 策略。
//   - 零遥测形状与全局 fetch 对齐:不带 cookie(node:http 天然无 cookie jar)、
//     不自动跟随重定向(重定向循环归调用方,每跳重新走本模块=每跳钉扎)、
//     调用方自管 accept/authorization 头。
//   - 响应体上限由调用方(readBodyCapped)控制;本模块暴露 Web ReadableStream。
//
// 测试注入面:resolver(假 DNS)与 transport(假 request 实现);生产零注入。
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { Readable } from 'node:stream';
import {
  HostResolutionPolicyError,
  isLoopbackHost,
  resolveVerifiedAddresses,
  type HostResolver,
  type ResolvedHostAddress,
} from './url-safety.ts';

/** fetch RequestInit 的受控子集(消费方 fetchJson / mcp-scan client 实际使用面)。 */
export interface PinnedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** 兼容 fetch 签名;本模块本就绝不自动跟随重定向。 */
  redirect?: 'manual';
  /** 兼容 fetch 签名;node:http 天然无 cookie。 */
  credentials?: 'omit';
}

/**
 * fetch Response 的受控子集。刻意**不提供** text()/json():安全传输层不暴露无上限
 * 的整体读取(内存 DoS 面+与 body 流的双消费歧义);调用方一律经 body 流配上限读取
 * (registry readBodyCapped / mcp-scan 同型逻辑)。
 */
export interface PinnedResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export type PinnedTransport = (options: RequestOptions, onResponse: (res: IncomingMessage) => void) => ClientRequest;

export interface PinnedFetchOptions {
  /** DNS resolver 注入(测试);生产默认 node:dns lookup(all=true)。 */
  resolver?: HostResolver;
  /** 仅 MCP 本地 http transport 显式打开;地址仍须过 loopback 策略。 */
  allowLoopback?: boolean;
  /** 传输层注入(测试);生产默认 node:https / node:http 的 request。 */
  httpsTransport?: PinnedTransport;
  httpTransport?: PinnedTransport;
  /** 追加受信 CA(仅测试:让真实 TLS 握手用自签证书跑通;绝不放松校验)。 */
  tlsCa?: readonly (string | Buffer)[];
}

export class PinnedConnectionError extends Error {
  constructor(
    message: string,
    readonly attempts: readonly string[],
  ) {
    super(message);
    this.name = 'PinnedConnectionError';
  }
}

function headerGetter(res: IncomingMessage): PinnedResponse['headers'] {
  return {
    get(name: string): string | null {
      const value = res.headers[name.toLowerCase()];
      if (value === undefined) return null;
      return Array.isArray(value) ? value.join(', ') : value;
    },
  };
}

type NodeLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/** 把策略校验过的地址逐字钉进 socket:lookup 永远只回已验证地址,绝不再查 DNS。 */
function pinnedLookup(pinned: ResolvedHostAddress) {
  return (
    _hostname: string,
    optionsOrCb: unknown,
    maybeCb?: NodeLookupCallback,
  ): void => {
    const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as NodeLookupCallback;
    const wantAll =
      typeof optionsOrCb === 'object' && optionsOrCb !== null &&
      (optionsOrCb as { all?: boolean }).all === true;
    if (wantAll) {
      cb(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      cb(null, pinned.address, pinned.family);
    }
  };
}

/** 剥掉调用方试图覆盖的 Host 头:Host 永远由 URL 域名决定,防止头级重定向。 */
function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'host'),
  );
}

function requestOnce(
  transport: PinnedTransport,
  url: URL,
  init: PinnedFetchInit,
  address: ResolvedHostAddress,
  tlsCa: readonly (string | Buffer)[] | undefined,
): Promise<IncomingMessage> {
  return new Promise((resolvePromise, rejectPromise) => {
    const options: RequestOptions = {
      protocol: url.protocol,
      // hostname 保持域名:Host 头与 TLS SNI/证书校验按域名;实际 socket 目的地
      // 由 lookup 钉在已验证地址上。
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      headers: sanitizeHeaders(init.headers),
      lookup: pinnedLookup(address) as RequestOptions['lookup'],
      signal: init.signal,
      // 每请求独立连接:全局 Agent 的 keep-alive 复用可能把 socket 交给同 IP:port
      // 的其它主机名请求,也可能被环境代理配置接管——安全传输拒绝共享连接池。
      agent: false,
    };
    if (url.protocol === 'https:') {
      // 显式钉死 TLS 语义(即便与 Node 默认一致也不依赖默认):
      // SNI/证书校验按域名,校验绝不放松;tlsCa 仅追加受信根(测试自签用)。
      options.servername = url.hostname;
      options.rejectUnauthorized = true;
      if (tlsCa) options.ca = [...tlsCa];
    }
    const req = transport(options, resolvePromise);
    req.on('error', rejectPromise);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/**
 * 构造一个钉扎版 fetch。默认实例见下方 pinnedFetch(https-only);
 * mcp-scan 的本地 http transport 用 createPinnedFetch({ allowLoopback: true })。
 */
export function createPinnedFetch(options: PinnedFetchOptions = {}) {
  return async function pinnedFetchImpl(
    rawUrl: string,
    init: PinnedFetchInit = {},
  ): Promise<PinnedResponse> {
    const url = new URL(rawUrl);
    // 传输层原语自身拒绝 URL userinfo,不依赖外层调用方把关。
    if (url.username.length > 0 || url.password.length > 0) {
      throw new HostResolutionPolicyError(
        '出站 URL 不允许携带 userinfo 凭据',
        'non-public-address',
      );
    }
    const isHttp = url.protocol === 'http:';
    if (url.protocol !== 'https:' && !(options.allowLoopback && isHttp)) {
      throw new HostResolutionPolicyError(
        `仅允许 https 出站(本地 MCP transport 除外): ${url.protocol}`,
        'non-public-address',
      );
    }
    // 明文 http 只服务"显式本机"场景:URL 主机名本身必须是 loopback 写法,
    // 且下方解析出的全部地址也必须是 loopback——公网域名/公网地址一律拒绝,
    // allowLoopback 实例绝不成为明文出站通道。https 始终走公网策略。
    if (isHttp && !isLoopbackHost(url.hostname)) {
      throw new HostResolutionPolicyError(
        `明文 http 仅允许显式 loopback 主机: ${url.hostname}`,
        'non-public-address',
      );
    }

    // 一次解析 + 策略校验;返回列表即连接目的地全集。
    const addresses = await resolveVerifiedAddresses(url, {
      resolver: options.resolver,
      allowLoopback: isHttp,
    });
    if (isHttp && addresses.some(({ address }) => !isLoopbackHost(address))) {
      throw new HostResolutionPolicyError(
        `明文 http 的解析地址必须全部为 loopback: ${url.hostname}`,
        'non-public-address',
      );
    }

    // 非幂等方法禁止地址级自动重试:连接错误与"服务端已执行但响应中断"在传输层
    // 不可区分,重发 POST 可能重放副作用(JSON-RPC 无传输层去重)。
    const method = (init.method ?? 'GET').toUpperCase();
    const attemptable = method === 'GET' || method === 'HEAD' ? addresses : addresses.slice(0, 1);

    const transport: PinnedTransport =
      url.protocol === 'https:'
        ? (options.httpsTransport ?? (httpsRequest as unknown as PinnedTransport))
        : (options.httpTransport ?? (httpRequest as unknown as PinnedTransport));

    const attempts: string[] = [];
    let lastError: unknown;
    for (const address of attemptable) {
      attempts.push(address.address);
      try {
        const res = await requestOnce(transport, url, init, address, options.tlsCa);
        const bodyStream = Readable.toWeb(res) as ReadableStream<Uint8Array>;
        return {
          ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          url: url.toString(),
          headers: headerGetter(res),
          body: bodyStream,
        };
      } catch (error) {
        // AbortError(超时/取消)不换地址,原样上抛保留调用方的超时语义。
        if (error instanceof Error && error.name === 'AbortError') throw error;
        lastError = error;
      }
    }
    throw new PinnedConnectionError(
      `已验证地址均连接失败(尝试 ${attempts.length} 个): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      attempts,
    );
  };
}

/** 默认钉扎 fetch(https-only):registry 等公网出站的标准出口。 */
export const pinnedFetch = createPinnedFetch();
