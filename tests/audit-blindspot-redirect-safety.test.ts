import { describe, expect, it, vi } from 'vitest';
import { connectHttp } from '../src/core/mcp-scan/client.ts';
import { fetchJson } from '../src/core/registry/fetch.ts';

function redirectResponse(location: string): Response {
  return new Response(null, { status: 307, headers: { location } });
}

describe('redirect revalidation regression', () => {
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
    }, 1000, fetchImpl as never)).rejects.toMatchObject({ code: 'insecure-url' });
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
    }, 1000, fetchImpl as never).catch(() => undefined);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]!.headers.authorization).toBe('Bearer redirect-secret');
    expect(seen[1]!.url).toBe('https://other-origin.example.test/mcp');
    expect(Object.keys(seen[1]!.headers).map((key) => key.toLowerCase())).not.toContain('authorization');
  });
});
