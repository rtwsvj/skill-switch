// C 线测试:registry 取数层 fetch.ts 的安全护栏。
// 覆盖:HTTPS-only(拒 http://)、content-type 必须 JSON、响应体大小上限、超时、零遥测头、解析错误。
// 全程 mock fetch,零真实网络。
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_BYTES,
  RegistryFetchError,
  assertHttpsUrl,
  fetchJson,
} from '../src/core/registry/fetch.ts';

/** 造一个最小可用的 Response(带可流式读的 body)。 */
function jsonResponse(
  obj: unknown,
  init: { status?: number; contentType?: string | null; contentLength?: string } = {},
): Response {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const headers = new Headers();
  if (init.contentType !== null) headers.set('content-type', init.contentType ?? 'application/json');
  if (init.contentLength) headers.set('content-length', init.contentLength);
  return new Response(text, { status: init.status ?? 200, headers });
}

describe('registry/fetch: HTTPS-only 护栏', () => {
  it('http:// 被拒(insecure-url),且根本不发请求', async () => {
    const spy = vi.fn();
    await expect(fetchJson('http://registry.example.com/x', { fetchImpl: spy as never })).rejects.toMatchObject({
      code: 'insecure-url',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('非法 URL 被拒(invalid-url),不发请求', async () => {
    const spy = vi.fn();
    await expect(fetchJson('not a url', { fetchImpl: spy as never })).rejects.toMatchObject({
      code: 'invalid-url',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('assertHttpsUrl 放行 https://、拒绝 ftp:// 与 file://', () => {
    expect(assertHttpsUrl('https://x.test/a').protocol).toBe('https:');
    expect(() => assertHttpsUrl('ftp://x.test')).toThrow(RegistryFetchError);
    expect(() => assertHttpsUrl('file:///etc/passwd')).toThrow(RegistryFetchError);
  });
});

describe('registry/fetch: 零遥测请求姿态', () => {
  it('只发最小 accept 头,带 credentials:omit,不带 user-agent / cookie / authorization', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse({ ok: true });
    });
    await fetchJson('https://registry.test/v0/servers?search=x', { fetchImpl: fetchImpl as never });

    expect(capturedUrl).toBe('https://registry.test/v0/servers?search=x');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.accept).toBe('application/json');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('user-agent');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('cookie');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(capturedInit?.credentials).toBe('omit');
  });
});

describe('registry/fetch: content-type 校验', () => {
  it('content-type 不含 json → 拒绝(not-json),即便正文是合法 JSON', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ a: 1 }, { contentType: 'text/html' }));
    await expect(fetchJson('https://r.test/x', { fetchImpl: fetchImpl as never })).rejects.toMatchObject({
      code: 'not-json',
    });
  });

  it('缺失 content-type → 拒绝(not-json)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ a: 1 }, { contentType: null }));
    await expect(fetchJson('https://r.test/x', { fetchImpl: fetchImpl as never })).rejects.toMatchObject({
      code: 'not-json',
    });
  });

  it('application/json; charset=utf-8 与 +json 后缀都被接受', async () => {
    for (const ct of ['application/json; charset=utf-8', 'application/scim+json', 'text/json']) {
      const fetchImpl = vi.fn(async () => jsonResponse({ ct }, { contentType: ct }));
      await expect(fetchJson('https://r.test/x', { fetchImpl: fetchImpl as never })).resolves.toEqual({ ct });
    }
  });
});

describe('registry/fetch: HTTP 状态 / 解析错误', () => {
  it('非 2xx → http-error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ msg: 'nope' }, { status: 404 }));
    await expect(fetchJson('https://r.test/x', { fetchImpl: fetchImpl as never })).rejects.toMatchObject({
      code: 'http-error',
    });
  });

  it('正文非 JSON → parse-error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('{ not json', { contentType: 'application/json' }));
    await expect(fetchJson('https://r.test/x', { fetchImpl: fetchImpl as never })).rejects.toMatchObject({
      code: 'parse-error',
    });
  });
});

describe('registry/fetch: 响应体大小上限', () => {
  it('声明的 content-length 超上限 → 立刻拒绝(too-large),不读正文', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ a: 1 }, { contentLength: String(DEFAULT_MAX_BYTES + 1) }),
    );
    await expect(fetchJson('https://r.test/x', { fetchImpl: fetchImpl as never })).rejects.toMatchObject({
      code: 'too-large',
    });
  });

  it('流式正文超过 maxBytes → 中止(too-large)', async () => {
    // 造一个会吐出超过上限字节的流式 body。
    const maxBytes = 16;
    const chunk = new TextEncoder().encode('x'.repeat(64));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' }, // 故意不给 content-length
    });
    const fetchImpl = vi.fn(async () => res);
    await expect(
      fetchJson('https://r.test/x', { fetchImpl: fetchImpl as never, maxBytes }),
    ).rejects.toMatchObject({ code: 'too-large' });
  });

  it('正文在上限内 → 正常解析', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ hello: 'world' }));
    await expect(
      fetchJson('https://r.test/x', { fetchImpl: fetchImpl as never, maxBytes: 1024 }),
    ).resolves.toEqual({ hello: 'world' });
  });
});

describe('registry/fetch: 超时', () => {
  it('AbortError → timeout', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    await expect(
      fetchJson('https://r.test/x', { fetchImpl: fetchImpl as never, timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});
