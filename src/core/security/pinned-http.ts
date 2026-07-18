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

/** fetch Response 的受控子集(status/ok/headers.get/body 流/text/json)。 */
export interface PinnedResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  json(): Promise<unknown>;
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

async function collectText(res: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
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

function requestOnce(
  transport: PinnedTransport,
  url: URL,
  init: PinnedFetchInit,
  address: ResolvedHostAddress,
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
      headers: init.headers,
      lookup: pinnedLookup(address) as RequestOptions['lookup'],
      signal: init.signal,
    };
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
    if (url.protocol !== 'https:' && !(options.allowLoopback && url.protocol === 'http:')) {
      throw new HostResolutionPolicyError(
        `仅允许 https 出站(本地 MCP transport 除外): ${url.protocol}`,
        'non-public-address',
      );
    }

    // 一次解析 + 策略校验;返回列表即连接目的地全集。
    const addresses = await resolveVerifiedAddresses(url, {
      resolver: options.resolver,
      allowLoopback: options.allowLoopback,
    });

    const transport: PinnedTransport =
      url.protocol === 'https:'
        ? (options.httpsTransport ?? (httpsRequest as unknown as PinnedTransport))
        : (options.httpTransport ?? (httpRequest as unknown as PinnedTransport));

    const attempts: string[] = [];
    let lastError: unknown;
    for (const address of addresses) {
      attempts.push(address.address);
      try {
        const res = await requestOnce(transport, url, init, address);
        const bodyStream = Readable.toWeb(res) as ReadableStream<Uint8Array>;
        let textPromise: Promise<string> | undefined;
        const text = () => {
          textPromise ??= collectText(res);
          return textPromise;
        };
        return {
          ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          url: url.toString(),
          headers: headerGetter(res),
          body: bodyStream,
          text,
          json: async () => JSON.parse(await text()) as unknown,
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
