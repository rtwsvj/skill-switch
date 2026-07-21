// D2+D3 集成:registry / mcp-scan 经 pinned-http 钉扎路径连通本地 mock。
//
// ① registry:createPinnedFetch({allowLoopback,resolver}) 作 fetchImpl 注入,
//    请求 http://localhost:port(assertHttpsUrl 前的 URL 层仍拒 http——故注入
//    绕过 URL 层后走真 socket 的路径用「fetchImpl=钉扎实例 + 明文 loopback」
//    验证钉扎出口;生产默认路径仍是 https-only + pinnedFetch)。
// ② mcp-scan http transport:默认 loopbackPinnedFetch 连通 mock server。
// ③ 哨兵:registry 出口是 pinned-http;core 除 pinned-http 外无 node:http(s)。

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectHttp } from '../src/core/mcp-scan/client.ts';
import { fetchJson } from '../src/core/registry/fetch.ts';
import { createPinnedFetch } from '../src/core/security/pinned-http.ts';
import type { HostResolver } from '../src/core/security/url-safety.ts';

const loopbackResolver: HostResolver = async () => [{ address: '127.0.0.1', family: 4 }];

describe('D2: registry fetchJson via pinned-http', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fetchJson 经 createPinnedFetch(allowLoopback+resolver) 钉扎路径拿到 JSON', async () => {
    // registry 层 assertHttpsUrl 拒 http;集成验证「钉扎出口」时把 createPinnedFetch
    // 作为 fetchImpl 注入,并用 https URL 过 URL 护栏——resolver 钉到 loopback,
    // 但 https 连本机无 TLS 会失败。改用:直接调用注入的钉扎实例路径——
    // 即 fetchJson 在注入 fetchImpl 时跳过真实 DNS/策略,走我们给的钉扎实现。
    // 为走真 socket:注入的 fetchImpl 是 allowLoopback 钉扎实例,URL 仍须 https
    // 过 assertHttpsUrl。https+loopback 地址会被 pinned-http 公网策略拒
    // (isPrivateNetworkLiteral / allowLoopback 仅对 http)。
    //
    // 规格折中:用 createPinnedFetch 作 fetchImpl,但在外层包一层把 https
    // 改写成 http://localhost 再交给钉扎实例——证明 fetchJson→钉扎出口→真 socket。
    const pinned = createPinnedFetch({ allowLoopback: true, resolver: loopbackResolver });
    const fetchImpl = async (url: string, init?: Parameters<typeof pinned>[1]) => {
      const u = new URL(url);
      // 测试桥:https 护栏已过,连本地 mock 时改写为 loopback http
      const local = `http://127.0.0.1:${port}${u.pathname}${u.search}`;
      return pinned(local, init);
    };

    const data = await fetchJson<{ ok: boolean; path: string }>(
      'https://registry.example.test/catalog.json',
      { fetchImpl },
    );
    expect(data).toEqual({ ok: true, path: '/catalog.json' });
  });

  it('hostResolver 私网答案 → insecure-url 且不连 socket', async () => {
    await expect(
      fetchJson('https://evil.example.test/x', {
        hostResolver: async () => [{ address: '10.0.0.1', family: 4 }],
      }),
    ).rejects.toMatchObject({ code: 'insecure-url' });
  });
});

describe('D3: mcp-scan connectHttp via pinned-http', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end();
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        let parsed: { method?: string; id?: number };
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = {};
        }
        const id = typeof parsed.id === 'number' ? parsed.id : null;
        if (parsed.method === 'initialize') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'pin-mock' } },
          }));
        } else if (parsed.method === 'tools/list') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { tools: [{ name: 'pinned_tool', description: 'via pin', inputSchema: {} }] },
          }));
        } else {
          // notifications/initialized 等
          res.statusCode = 200;
          res.end('{}');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('mcp http transport 默认钉扎路径连通 mock server(POST 单地址语义)', async () => {
    // 不注入 fetchImpl:走模块内 loopbackPinnedFetch
    const r = await connectHttp({
      name: 'pin-http',
      source: '.claude/mcp.json',
      transport: 'http',
      url: baseUrl,
    }, 5000);
    expect(r.tools).toEqual([
      { name: 'pinned_tool', description: 'via pin', inputSchema: {} },
    ]);
    expect(r.protocolVersion).toBe('2025-06-18');
  });

  it('mcp hostResolver 私网答案 → insecure-url', async () => {
    await expect(connectHttp({
      name: 'evil',
      source: '.claude/mcp.json',
      transport: 'http',
      url: 'https://mcp.evil.test/v1',
    }, 1000, undefined, async () => [{ address: '192.168.0.5', family: 4 }]))
      .rejects.toMatchObject({ code: 'insecure-url' });
  });
});

describe('D2/D3 哨兵:pinned-http 是 core 唯一 socket 出口', () => {
  it('registry/fetch.ts 经 pinned-http 出站', async () => {
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'core', 'registry', 'fetch.ts'),
      'utf8',
    );
    expect(src).toMatch(/from ['"]\.\.\/security\/pinned-http\.ts['"]/);
    expect(src).toMatch(/\bpinnedFetch\b/);
    expect(src).toMatch(/\bcreatePinnedFetch\b/);
    expect(src).not.toMatch(/\bassertResolvedHostPolicy\b/);
    expect(src).not.toMatch(/typeof fetch\s*=\s*fetch/);
  });

  it('mcp-scan/client.ts 经 pinned-http 出站且 http 用 allowLoopback 实例', async () => {
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'core', 'mcp-scan', 'client.ts'),
      'utf8',
    );
    expect(src).toMatch(/from ['"]\.\.\/security\/pinned-http\.ts['"]/);
    expect(src).toMatch(/\bpinnedFetch\b/);
    expect(src).toMatch(/createPinnedFetch\(\{\s*allowLoopback:\s*true\s*\}\)/);
    // 不得从 url-safety 再 import 策略预解析(策略已并入钉扎出口)
    expect(src).not.toMatch(/assertResolvedHostPolicy/);
    expect(src).not.toMatch(/defaultHostResolver/);
  });

  it('src/core 除 security/pinned-http.ts 外不得 import node:http(s)', async () => {
    const coreRoot = join(import.meta.dirname, '..', 'src', 'core');
    const pinnedHttp = join(coreRoot, 'security', 'pinned-http.ts');
    const stack = [coreRoot];
    const offenders: string[] = [];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!ent.name.endsWith('.ts')) continue;
        if (full === pinnedHttp) continue;
        const src = await readFile(full, 'utf8');
        if (/from ['"]node:(http|https)['"]/.test(src) || /require\(['"]node:(http|https)['"]\)/.test(src)) {
          offenders.push(full.slice(coreRoot.length + 1));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── D3.5(Codex 复核补钉):逐跳 redirect 钉扎回归 ────────────────────────────
import { Readable } from 'node:stream';
import { RegistryFetchError } from '../src/core/registry/fetch.ts';
import type { PinnedTransport } from '../src/core/security/pinned-http.ts';

describe('D3.5: per-hop redirect pinning regression', () => {
  it('re-resolves each redirect hop through the pinned path and blocks private second hops before connecting', async () => {
    const resolvedHosts: string[] = [];
    const connectedHosts: string[] = [];
    const resolver = async (hostname: string) => {
      resolvedHosts.push(hostname);
      if (hostname === 'private.hop') return [{ address: '10.0.0.8', family: 4 }];
      return [{ address: '93.184.216.34', family: 4 }];
    };
    const transport: PinnedTransport = (options, onResponse) => {
      connectedHosts.push(String(options.hostname));
      const body = Readable.from([Buffer.from('')]) as unknown as Parameters<typeof onResponse>[0];
      (body as { statusCode?: number }).statusCode = 302;
      (body as { headers?: Record<string, string> }).headers = {
        location: 'https://private.hop/next',
      };
      queueMicrotask(() => onResponse(body));
      return { on: () => undefined, write: () => true, end: () => undefined } as never;
    };
    const fetchImpl = createPinnedFetch({ resolver, httpsTransport: transport });

    await expect(
      fetchJson('https://public.start/api', { fetchImpl: fetchImpl as never }),
    ).rejects.toThrow(RegistryFetchError);
    // 第一跳解析+连接;第二跳解析出私网 → 连接前被拒(绝无第二跳 socket)。
    expect(resolvedHosts).toEqual(['public.start', 'private.hop']);
    expect(connectedHosts).toEqual(['public.start']);
  });
});

// 错误映射表驱动:HostResolutionPolicyError 的 code 分类在两个消费方保持稳定。
import { HostResolutionPolicyError } from '../src/core/security/url-safety.ts';

describe('D3.5: policy error code mapping is table-stable', () => {
  const cases = [
    { policyCode: 'non-public-address' as const, registry: 'insecure-url', mcp: 'insecure-url' },
    { policyCode: 'lookup-failed' as const, registry: 'network', mcp: 'network' },
  ];

  for (const { policyCode, registry } of cases) {
    it(`registry maps ${policyCode} → ${registry}`, async () => {
      const thrower = async () => {
        throw new HostResolutionPolicyError('mapped', policyCode);
      };
      await expect(
        fetchJson('https://map.test/', { fetchImpl: thrower as never }),
      ).rejects.toMatchObject({ name: 'RegistryFetchError', code: registry });
    });
  }

  for (const { policyCode, mcp } of cases) {
    it(`mcp-scan maps ${policyCode} → ${mcp}`, async () => {
      const thrower = async () => {
        throw new HostResolutionPolicyError('mapped', policyCode);
      };
      await expect(
        connectHttp(
          { name: 's', transport: 'http', url: 'https://map.test/' } as never,
          1000,
          thrower as never,
        ),
      ).rejects.toMatchObject({ name: 'McpScanClientError', code: mcp });
    });
  }
});

