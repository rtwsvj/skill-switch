import { describe, expect, it, vi } from 'vitest';
import { connectHttp } from '../src/core/mcp-scan/client.ts';
import {
  fetchJson as fetchJsonImpl,
  type FetchJsonOptions,
} from '../src/core/registry/fetch.ts';

const PUBLIC_RESOLVER = async () => [{ address: '93.184.216.34', family: 4 }];

function fetchJson<T = unknown>(rawUrl: string, options: FetchJsonOptions = {}): Promise<T> {
  return fetchJsonImpl<T>(rawUrl, { hostResolver: PUBLIC_RESOLVER, ...options });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 307, headers: { location } });
}

describe('redirect revalidation regression', () => {
  it('rejects registry hostnames that resolve to private addresses before fetch', async () => {
    const fetchImpl = vi.fn();
    await expect(fetchJson('https://registry.example.test/catalog.json', {
      fetchImpl: fetchImpl as never,
      hostResolver: async () => [{ address: '10.0.0.5', family: 4 }],
    })).rejects.toMatchObject({ code: 'insecure-url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('re-resolves every registry redirect target and blocks a private DNS answer', async () => {
    const fetchImpl = vi.fn(async () =>
      redirectResponse('https://internal.example.test/catalog.json'));
    const hostResolver = vi.fn(async (hostname: string) => [
      hostname === 'internal.example.test'
        ? { address: '192.168.1.20', family: 4 }
        : { address: '93.184.216.34', family: 4 },
    ]);

    await expect(fetchJson('https://registry.example.test/catalog.json', {
      fetchImpl: fetchImpl as never,
      hostResolver,
    })).rejects.toMatchObject({ code: 'insecure-url' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(hostResolver).toHaveBeenCalledWith('registry.example.test');
    expect(hostResolver).toHaveBeenCalledWith('internal.example.test');
  });

  it('rejects MCP HTTPS hostnames resolving to private addresses before fetch', async () => {
    const fetchImpl = vi.fn();
    await expect(connectHttp({
      name: 'private-dns', source: '.claude/mcp.json', transport: 'http',
      url: 'https://mcp.example.test/v1',
    }, 1000, fetchImpl as never, async () => [
      { address: '169.254.169.254', family: 4 },
    ])).rejects.toMatchObject({ code: 'insecure-url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('registry fetch handles redirects manually and rejects HTTPS downgrade before following it', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return redirectResponse('http://169.254.169.254/latest/meta-data/');
    });

    await expect(fetchJson('https://registry.example.test/catalog.json', {
      fetchImpl: fetchImpl as never,
    })).rejects.toMatchObject({ code: 'insecure-url' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('MCP HTTP handles redirects manually and rejects a redirect to private plaintext HTTP', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return redirectResponse('http://169.254.169.254/latest/meta-data/');
    });

    await expect(connectHttp({
      name: 'redirecting-server', source: '.claude/mcp.json', transport: 'http',
      url: 'https://mcp.example.test/v1',
      headers: { authorization: 'Bearer redirect-secret' },
    }, 1000, fetchImpl as never, PUBLIC_RESOLVER)).rejects.toMatchObject({ code: 'insecure-url' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('MCP rejects an HTTPS downgrade even when the target is an otherwise allowed loopback', async () => {
    const fetchImpl = vi.fn(async () => redirectResponse('http://127.0.0.1:8787/mcp'));
    await expect(connectHttp({
      name: 'redirecting-server', source: '.claude/mcp.json', transport: 'http',
      url: 'https://mcp.example.test/v1',
    }, 1000, fetchImpl as never, PUBLIC_RESOLVER)).rejects.toMatchObject({ code: 'insecure-url' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never forwards authorization when a permitted redirect changes origin', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
      if (seen.length === 1) {
        return redirectResponse('https://other-origin.example.test/mcp');
      }
      const request = JSON.parse(String(init?.body)) as { method?: string; id?: number };
      if (request.method === 'initialize') {
        return Response.json({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18' } });
      }
      if (request.method === 'tools/list') {
        return Response.json({ jsonrpc: '2.0', id: request.id, result: { tools: [] } });
      }
      return Response.json({ jsonrpc: '2.0', id: request.id, result: {} });
    });

    await connectHttp({
      name: 'redirecting-server', source: '.claude/mcp.json', transport: 'http',
      url: 'https://mcp.example.test/v1',
      headers: { authorization: 'Bearer redirect-secret' },
    }, 1000, fetchImpl as never, PUBLIC_RESOLVER).catch(() => undefined);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]!.headers.authorization).toBe('Bearer redirect-secret');
    expect(seen[1]!.url).toBe('https://other-origin.example.test/mcp');
    expect(Object.keys(seen[1]!.headers).map((key) => key.toLowerCase())).not.toContain('authorization');
  });

  it('registry strips bearer authorization after a cross-origin redirect', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
      return seen.length === 1
        ? redirectResponse('https://mirror.example.test/catalog.json')
        : Response.json({ ok: true });
    });

    await expect(fetchJson('https://registry.example.test/catalog.json', {
      bearerToken: 'registry-secret',
      fetchImpl: fetchImpl as never,
    })).resolves.toEqual({ ok: true });
    expect(seen[0]!.headers.authorization).toBe('Bearer registry-secret');
    expect(Object.keys(seen[1]!.headers).map((key) => key.toLowerCase()))
      .not.toContain('authorization');
  });

  it('enforces a maximum of five followed redirects', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return redirectResponse(`/redirect-${calls}`);
    });
    await expect(fetchJson('https://registry.example.test/catalog.json', {
      fetchImpl: fetchImpl as never,
    })).rejects.toMatchObject({ code: 'redirect-error' });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });
});
