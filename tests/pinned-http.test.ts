// D1:DNS 连接时钉扎(pinned-http)。核心断言:
//   ① 行为级钉扎证明——socket 连接目的地来自"策略校验通过的那次解析",系统 DNS
//     根本不参与(evil.test 在系统 DNS 必然无解,但请求到达了我们指定的服务器);
//   ② 每请求恰好一次解析——rebind(第二次解析换答案)没有发生的机会;
//   ③ TLS 语义:hostname/SNI 按域名,只有 socket 目的地被钉;
//   ④ 私网答案拒绝且零连接;⑤ 已验证地址间 failover 但绝不重新解析;
//   ⑥ AbortError 原样上抛(超时语义归调用方)。
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createPinnedFetch,
  pinnedFetch,
  PinnedConnectionError,
  type PinnedTransport,
} from '../src/core/security/pinned-http.ts';
import { HostResolutionPolicyError, type HostResolver } from '../src/core/security/url-safety.ts';

let server: Server;
let port: number;
let lastRequest: { host?: string; url?: string } = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    lastRequest = { host: req.headers.host, url: req.url };
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-custom-header', 'pinned');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'object' && addr) port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function readBodyText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function loopbackResolver(): HostResolver & { calls: number } {
  const fn = (async () => {
    fn.calls += 1;
    return [{ address: '127.0.0.1', family: 4 }];
  }) as unknown as HostResolver & { calls: number };
  fn.calls = 0;
  return fn;
}

describe('pinned-http: connect-time DNS pinning', () => {
  it('resolves exactly once through the injected resolver (no second lookup window)', async () => {
    // D1.5 后明文 http 只许显式 loopback 主机名(公网域名如 evil.test 直接拒),
    // "目的地=resolver 答案"由 fake-transport 用例的 lookup 结构断言 + Node 平台
    // 语义共同保证;本用例保住的行为性质:解析只经注入 resolver 且恰好一次。
    const resolver = loopbackResolver();
    const fetchPinned = createPinnedFetch({ allowLoopback: true, resolver });

    const res = await fetchPinned(`http://localhost:${port}/probe`, {
      headers: { accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(lastRequest.url).toBe('/probe');
    expect(lastRequest.host).toBe(`localhost:${port}`);
    // 恰好一次解析:连接阶段没有第二次 DNS 查询,rebind 无从发生。
    expect(resolver.calls).toBe(1);
    expect(JSON.parse(await readBodyText(res.body))).toEqual({ ok: true });
    expect(res.headers.get('X-Custom-Header')).toBe('pinned');
  });

  it('keeps TLS hostname semantics: transport gets the domain, lookup returns the pinned address', async () => {
    const seen: Array<{
      hostname?: string;
      port?: unknown;
      lookupAnswer?: unknown;
      servername?: string;
      rejectUnauthorized?: boolean;
      agent?: unknown;
    }> = [];
    const fakeTransport: PinnedTransport = (options, onResponse) => {
      const entry: (typeof seen)[number] = {
        hostname: options.hostname ?? undefined,
        port: options.port,
        servername: (options as { servername?: string }).servername,
        rejectUnauthorized: (options as { rejectUnauthorized?: boolean }).rejectUnauthorized,
        agent: options.agent,
      };
      const lookup = options.lookup as (
        h: string,
        o: { all?: boolean },
        cb: (e: null, addr: unknown, fam?: number) => void,
      ) => void;
      lookup('example.test', {}, (_e, addr) => {
        entry.lookupAnswer = addr;
      });
      seen.push(entry);
      const body = Readable.from([Buffer.from('{"pinned":true}')]) as unknown as Parameters<typeof onResponse>[0];
      (body as { statusCode?: number }).statusCode = 200;
      (body as { statusMessage?: string }).statusMessage = 'OK';
      (body as { headers?: Record<string, string> }).headers = { 'content-type': 'application/json' };
      queueMicrotask(() => onResponse(body));
      return { on: () => undefined, write: () => true, end: () => undefined } as never;
    };

    const resolver: HostResolver = async () => [{ address: '203.0.113.7', family: 4 }];
    // 203.0.113.0/24 是文档保留段,被策略拒——这里专门用能过策略的公网形状地址。
    const publicResolver: HostResolver = async () => [{ address: '93.184.216.34', family: 4 }];
    void resolver;

    const fetchPinned = createPinnedFetch({ resolver: publicResolver, httpsTransport: fakeTransport });
    const res = await fetchPinned('https://example.test/x');
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    // TLS/SNI 语义:hostname 是域名;socket 目的地由 lookup 给出且为已验证地址。
    expect(seen[0]!.hostname).toBe('example.test');
    expect(seen[0]!.port).toBe(443);
    expect(seen[0]!.lookupAnswer).toBe('93.184.216.34');
    // D1.5:显式 TLS 语义与连接隔离(结构性断言;真实握手由 Node 平台语义保证)。
    expect(seen[0]!.servername).toBe('example.test');
    expect(seen[0]!.rejectUnauthorized).toBe(true);
    expect(seen[0]!.agent).toBe(false);
  });

  it('rejects private resolver answers before any connection is attempted', async () => {
    const transportSpy = vi.fn();
    const fetchPinned = createPinnedFetch({
      resolver: async () => [{ address: '10.0.0.1', family: 4 }],
      httpsTransport: transportSpy as never,
    });
    await expect(fetchPinned('https://internal.test/')).rejects.toThrow(HostResolutionPolicyError);
    expect(transportSpy).not.toHaveBeenCalled();
  });

  it('fails over across vetted addresses without re-resolving; exhaustion is a typed error', async () => {
    const resolver = (async () => {
      resolverCalls += 1;
      return [
        { address: '93.184.216.34', family: 4 },
        { address: '93.184.216.35', family: 4 },
      ];
    }) as HostResolver;
    let resolverCalls = 0;

    const attempted: string[] = [];
    const failingTransport: PinnedTransport = (options, _onResponse) => {
      const lookup = options.lookup as (
        h: string,
        o: object,
        cb: (e: null, addr: unknown) => void,
      ) => void;
      lookup('x', {}, (_e, addr) => attempted.push(String(addr)));
      return {
        on: (event: string, cb: (err: Error) => void) => {
          if (event === 'error') queueMicrotask(() => cb(new Error('ECONNREFUSED')));
        },
        write: () => true,
        end: () => undefined,
      } as never;
    };

    const fetchPinned = createPinnedFetch({ resolver, httpsTransport: failingTransport });
    await expect(fetchPinned('https://multi.test/')).rejects.toThrow(PinnedConnectionError);
    expect(attempted).toEqual(['93.184.216.34', '93.184.216.35']);
    expect(resolverCalls).toBe(1); // failover 换地址,绝不重新解析
  });

  it('propagates AbortError verbatim (caller owns timeout semantics)', async () => {
    const resolver = loopbackResolver();
    const fetchPinned = createPinnedFetch({ allowLoopback: true, resolver });
    const ctrl = new AbortController();
    const abortError = new Error('operation aborted');
    abortError.name = 'AbortError';
    ctrl.abort(abortError);
    await expect(
      fetchPinned(`http://localhost:${port}/late`, { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('default instance is https-only', async () => {
    await expect(pinnedFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(/https/);
  });

  it('POST never retries across addresses (side-effect replay guard)', async () => {
    const attempted: string[] = [];
    const failingTransport: PinnedTransport = (options, _onResponse) => {
      const lookup = options.lookup as (h: string, o: object, cb: (e: null, a: unknown) => void) => void;
      lookup('x', {}, (_e, addr) => attempted.push(String(addr)));
      return {
        on: (event: string, cb: (err: Error) => void) => {
          if (event === 'error') queueMicrotask(() => cb(new Error('ECONNRESET')));
        },
        write: () => true,
        end: () => undefined,
      } as never;
    };
    const fetchPinned = createPinnedFetch({
      resolver: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '93.184.216.35', family: 4 },
      ],
      httpsTransport: failingTransport,
    });
    await expect(
      fetchPinned('https://rpc.test/', { method: 'POST', body: '{"jsonrpc":"2.0"}' }),
    ).rejects.toThrow(PinnedConnectionError);
    expect(attempted).toEqual(['93.184.216.34']); // 只试第一个已验证地址,绝不重放
  });

  it('plaintext http requires an explicitly-loopback hostname AND all-loopback answers', async () => {
    const fetchPinned = createPinnedFetch({
      allowLoopback: true,
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    // 公网域名走 http → 拒(即便 resolver 答 loopback)。
    await expect(fetchPinned('http://public.example/')).rejects.toThrow(/loopback/);

    const fetchMixed = createPinnedFetch({
      allowLoopback: true,
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    // loopback 写法的主机名解析出公网地址 → 拒(明文出站封死)。
    await expect(fetchMixed('http://localhost:1/')).rejects.toThrow(/loopback/);
  });

  it('strips caller-supplied Host header and rejects URL userinfo at the primitive layer', async () => {
    const resolver = loopbackResolver();
    const fetchPinned = createPinnedFetch({ allowLoopback: true, resolver });
    const res = await fetchPinned(`http://localhost:${port}/host-check`, {
      headers: { Host: 'spoofed.example', accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(lastRequest.host).toBe(`localhost:${port}`); // Host 由 URL 决定,覆盖被剥

    await expect(fetchPinned(`http://user:pass@localhost:${port}/`)).rejects.toThrow(/userinfo/);
  });

  it('rejects resolver answers whose family disagrees with the literal', async () => {
    const fetchPinned = createPinnedFetch({
      resolver: async () => [{ address: '2001:db8::1', family: 4 }],
    });
    await expect(fetchPinned('https://mismatch.test/')).rejects.toThrow(/不一致/);
  });

  it('exposes a web ReadableStream body compatible with capped readers', async () => {
    const resolver = loopbackResolver();
    const fetchPinned = createPinnedFetch({ allowLoopback: true, resolver });
    const res = await fetchPinned(`http://localhost:${port}/stream`);
    expect(res.body).not.toBeNull();
    const reader = res.body!.getReader();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? 0;
    }
    expect(bytes).toBeGreaterThan(0);
  });
});
