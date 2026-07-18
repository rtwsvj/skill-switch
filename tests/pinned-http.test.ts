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

function loopbackResolver(): HostResolver & { calls: number } {
  const fn = (async () => {
    fn.calls += 1;
    return [{ address: '127.0.0.1', family: 4 }];
  }) as unknown as HostResolver & { calls: number };
  fn.calls = 0;
  return fn;
}

describe('pinned-http: connect-time DNS pinning', () => {
  it('connects to the vetted resolver answer, not the system DNS (behavioral pin proof)', async () => {
    const resolver = loopbackResolver();
    const fetchPinned = createPinnedFetch({ allowLoopback: true, resolver });

    // evil.test 在系统 DNS 无解;请求到达本地服务器 = 目的地只来自被校验的解析。
    const res = await fetchPinned(`http://evil.test:${port}/probe`, {
      headers: { accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(lastRequest.url).toBe('/probe');
    // Host 头保持域名语义(服务端看到的是 evil.test,不是 IP)。
    expect(lastRequest.host).toBe(`evil.test:${port}`);
    // ② 恰好一次解析:连接阶段没有第二次 DNS 查询,rebind 无从发生。
    expect(resolver.calls).toBe(1);
    expect(await res.json()).toEqual({ ok: true });
    // headers.get 大小写不敏感。
    expect(res.headers.get('X-Custom-Header')).toBe('pinned');
  });

  it('keeps TLS hostname semantics: transport gets the domain, lookup returns the pinned address', async () => {
    const seen: Array<{ hostname?: string; port?: unknown; lookupAnswer?: unknown }> = [];
    const fakeTransport: PinnedTransport = (options, onResponse) => {
      const entry: (typeof seen)[number] = { hostname: options.hostname ?? undefined, port: options.port };
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
      fetchPinned(`http://evil.test:${port}/late`, { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('default instance is https-only', async () => {
    await expect(pinnedFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(/https/);
  });

  it('exposes a web ReadableStream body compatible with capped readers', async () => {
    const resolver = loopbackResolver();
    const fetchPinned = createPinnedFetch({ allowLoopback: true, resolver });
    const res = await fetchPinned(`http://evil.test:${port}/stream`);
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
