// v0.6-2: 远程 MCP 凭据暴露 — 三项新静态检查的测试
// 测试结构: 每个新 ruleId 都有「危险配置 → 应触发」和「良性边界 → 不触发」两类用例。
// 同时验证: 旧有 finding 不受影响; 畸形 JSON 不抛异常。
import { describe, expect, it } from 'vitest';
import { auditMcpConfig } from '../src/core/audit/mcp-audit.ts';

// ──────────────────────────────────────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────────────────────────────────────

function json(mcpServers: Record<string, unknown>): string {
  return JSON.stringify({ mcpServers });
}

// ──────────────────────────────────────────────────────────────────────────────
// Check 1: mcp/header-literal-secret — 请求头明文密钥
// ──────────────────────────────────────────────────────────────────────────────

describe('v0.6-2 check 1: header-literal-secret', () => {
  // === 触发用例: auth-semantic key with literal value ===

  it('Authorization header with literal Bearer token → high mcp/header-literal-secret', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          headers: { Authorization: 'Bearer sk-proj-abc123def456ghi789jkl' },
        },
      }),
    );
    const hit = findings.find((f) => f.ruleId === 'mcp/header-literal-secret');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('high');
  });

  it('x-api-key header with literal value → high mcp/header-literal-secret', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://api.example.com/mcp',
          headers: { 'x-api-key': 'literal-api-key-value-here' },
        },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/header-literal-secret')).toBeDefined();
  });

  it('api-key header (hyphen form) with literal value → high mcp/header-literal-secret', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          serverUrl: 'https://mcp.example.com/sse',
          headers: { 'api-key': 'supersecretkey12345' },
        },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/header-literal-secret')).toBeDefined();
  });

  it('cookie header with literal value → high mcp/header-literal-secret', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          headers: { cookie: 'session=abc123; auth=xyz789' },
        },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/header-literal-secret')).toBeDefined();
  });

  it('proxy-authorization header with literal value → high mcp/header-literal-secret', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          headers: { 'proxy-authorization': 'Basic dXNlcjpwYXNz' },
        },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/header-literal-secret')).toBeDefined();
  });

  it('header value matching sk-... OpenAI key pattern → high mcp/header-literal-secret', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          // A custom header name but value matches SECRET_VALUE_PATTERNS
          headers: { 'X-Custom-Auth': 'sk-abcdefghijklmnopqrstuvwxyz123456' },
        },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/header-literal-secret')).toBeDefined();
  });

  it('header value matching ghp_ GitHub token → high mcp/header-literal-secret', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          headers: { Authorization: 'token ghp_abcdef1234567890abcd' },
        },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/header-literal-secret')).toBeDefined();
  });

  // === 良性边界 — 绝不触发 ===

  it('Authorization header with variable reference (env-ref style) → ZERO mcp/header-literal-secret', () => {
    const tokenRef = ['$', '{API_TOKEN}'].join('');
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          headers: { Authorization: `Bearer ${tokenRef}` },
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/header-literal-secret')).toHaveLength(0);
  });

  it('Authorization with bare $VAR reference → ZERO mcp/header-literal-secret', () => {
    // ENV_REF_RE matches $VAR or ${VAR} — the whole value must be the reference
    // Here value is exactly "$API_TOKEN"
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          headers: { Authorization: '$API_TOKEN' },
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/header-literal-secret')).toHaveLength(0);
  });

  it('Content-Type header (non-secret semantics) with literal value → ZERO mcp/header-literal-secret', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          headers: { 'Content-Type': 'application/json' },
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/header-literal-secret')).toHaveLength(0);
  });

  it('Accept header with literal value → ZERO mcp/header-literal-secret', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          headers: { Accept: 'application/json' },
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/header-literal-secret')).toHaveLength(0);
  });

  it('empty headers object → ZERO mcp/header-literal-secret', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          headers: {},
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/header-literal-secret')).toHaveLength(0);
  });

  it('no headers field → ZERO mcp/header-literal-secret', () => {
    const findings = auditMcpConfig(
      json({
        remote: { url: 'https://mcp.example.com/sse' },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/header-literal-secret')).toHaveLength(0);
  });

  it('auth-semantic header key with empty string value → ZERO mcp/header-literal-secret', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          headers: { Authorization: '' },
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/header-literal-secret')).toHaveLength(0);
  });

  it('non-object headers field → ZERO mcp/header-literal-secret, no throw', () => {
    expect(() =>
      auditMcpConfig(
        json({
          remote: {
            url: 'https://mcp.example.com/sse',
            headers: 'Authorization: Bearer token',
          },
        }),
      ),
    ).not.toThrow();
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          headers: 'Authorization: Bearer token',
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/header-literal-secret')).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Check 2: mcp/url-embedded-credential — URL 内嵌凭据
// ──────────────────────────────────────────────────────────────────────────────

describe('v0.6-2 check 2: url-embedded-credential', () => {
  // === 触发用例 ===

  it('https://user:pass@host → high mcp/url-embedded-credential', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://admin:secretpass@mcp.example.com/sse',
        },
      }),
    );
    const hit = findings.find((f) => f.ruleId === 'mcp/url-embedded-credential');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('high');
  });

  it('http://user:pass@host → high mcp/url-embedded-credential', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'http://api-user:tok3n@internal.corp/mcp',
        },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/url-embedded-credential')).toBeDefined();
  });

  it('serverUrl with credentials → high mcp/url-embedded-credential', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          serverUrl: 'https://bot:p@ssw0rd@api.example.com/v1/mcp',
        },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/url-embedded-credential')).toBeDefined();
  });

  it('excerpt does not contain plaintext password', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://user:mysecretpassword@mcp.example.com/sse',
        },
      }),
    );
    const hit = findings.find((f) => f.ruleId === 'mcp/url-embedded-credential');
    expect(hit).toBeDefined();
    expect(hit!.excerpt).not.toContain('mysecretpassword');
  });

  // === 良性边界 — 绝不触发 ===

  it('https://host/path (no userinfo) → ZERO mcp/url-embedded-credential', () => {
    const findings = auditMcpConfig(
      json({
        remote: { url: 'https://mcp.example.com/sse' },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/url-embedded-credential')).toHaveLength(0);
  });

  it('https://host:port/path (port only, no userinfo) → ZERO mcp/url-embedded-credential', () => {
    const findings = auditMcpConfig(
      json({
        remote: { url: 'https://mcp.example.com:8443/sse' },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/url-embedded-credential')).toHaveLength(0);
  });

  it('no url field → ZERO mcp/url-embedded-credential', () => {
    const findings = auditMcpConfig(
      json({
        local: { command: 'node', args: ['./server.js'] },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/url-embedded-credential')).toHaveLength(0);
  });

  it('non-string url field → ZERO mcp/url-embedded-credential, no throw', () => {
    expect(() =>
      auditMcpConfig(json({ remote: { url: 42 } })),
    ).not.toThrow();
    expect(
      auditMcpConfig(json({ remote: { url: 42 } })).filter(
        (f) => f.ruleId === 'mcp/url-embedded-credential',
      ),
    ).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Check 3: mcp/env-secret-to-remote — 远程环境变量明文密钥
// ──────────────────────────────────────────────────────────────────────────────

describe('v0.6-2 check 3: env-secret-to-remote', () => {
  // === 触发用例: remote server + credential-semantic key + literal value ===

  it('remote server with APIKEY literal env → medium mcp/env-secret-to-remote', () => {
    // APIKEY (no underscore) does NOT match SECRET_KEY_SUFFIX_RE (_KEY) so the
    // existing mcp/env-literal-secret-key check does not fire — this is the
    // remote-escalation path for credential-semantic keys not caught by existing checks.
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          env: { APIKEY: 'hardcoded-api-key-value' },
        },
      }),
    );
    const hit = findings.find((f) => f.ruleId === 'mcp/env-secret-to-remote');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('medium');
  });

  it('remote server with AUTH literal env → medium mcp/env-secret-to-remote', () => {
    // AUTH does NOT match SECRET_KEY_SUFFIX_RE — remote-escalation path.
    const findings = auditMcpConfig(
      json({
        remote: {
          serverUrl: 'https://mcp.example.com/sse',
          env: { AUTH: 'my-auth-literal-value-here' },
        },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/env-secret-to-remote')).toBeDefined();
  });

  it('excerpt does not contain plaintext secret value', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          env: { APIKEY: 'actual-secret-should-not-appear' },
        },
      }),
    );
    const hit = findings.find((f) => f.ruleId === 'mcp/env-secret-to-remote');
    expect(hit).toBeDefined();
    expect(hit!.excerpt).not.toContain('actual-secret-should-not-appear');
  });

  // === 良性边界 — 绝不触发 ===

  it('local server (no url) with credential-semantic env → ZERO mcp/env-secret-to-remote', () => {
    // Must NOT fire — local server, no remote endpoint
    const findings = auditMcpConfig(
      json({
        local: {
          command: 'node',
          args: ['./server.js'],
          env: { API_KEY: 'hardcoded-api-key-value' },
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/env-secret-to-remote')).toHaveLength(0);
  });

  it('remote server with env var reference (env-ref style) → ZERO mcp/env-secret-to-remote', () => {
    const keyRef = ['$', '{API_KEY}'].join('');
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          env: { API_KEY: keyRef },
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/env-secret-to-remote')).toHaveLength(0);
  });

  it('remote server with non-credential env key → ZERO mcp/env-secret-to-remote', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          env: { LOG_LEVEL: 'debug', PORT: '3000' },
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/env-secret-to-remote')).toHaveLength(0);
  });

  it('dedup: key already flagged by existing mcp/env-literal-secret-key → only ONE finding total for that key', () => {
    // MY_API_TOKEN matches SECRET_KEY_SUFFIX_RE (_TOKEN), so mcp/env-literal-secret-key fires.
    // mcp/env-secret-to-remote should NOT also fire for the same key (dedup).
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          env: { MY_API_TOKEN: 'literal-secret-value' },
        },
      }),
    );
    const envLiteralHits = findings.filter((f) => f.ruleId === 'mcp/env-literal-secret-key');
    const remoteHits = findings.filter((f) => f.ruleId === 'mcp/env-secret-to-remote');
    // Existing check should fire
    expect(envLiteralHits.length).toBeGreaterThan(0);
    // Remote escalation should NOT also fire for this same key (no duplicate)
    expect(remoteHits).toHaveLength(0);
  });

  it('dedup: key matching SECRET_VALUE_PATTERNS → no mcp/env-secret-to-remote duplicate', () => {
    // sk- prefix triggers mcp/env-literal-openai-key; check 3 must not duplicate.
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          env: { OPENAI_API_KEY: 'sk-abcdefghijklmnopqrst' },
        },
      }),
    );
    const patternHits = findings.filter((f) => f.ruleId === 'mcp/env-literal-openai-key');
    const remoteHits = findings.filter((f) => f.ruleId === 'mcp/env-secret-to-remote');
    expect(patternHits.length).toBeGreaterThan(0);
    expect(remoteHits).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 组合测试: 旧有检查 + 新检查并存 — 旧有 finding 原样保留
// ──────────────────────────────────────────────────────────────────────────────

describe('v0.6-2 combination: old + new findings coexist unchanged', () => {
  it('server with old risk (unpinned npx) + new risk (header secret) reports both', () => {
    const findings = auditMcpConfig(
      json({
        mixed: {
          command: 'npx',
          args: ['some-mcp-server'], // triggers mcp/unpinned-package (existing)
          headers: { Authorization: 'Bearer hardcoded-token-value' }, // triggers new check
        },
      }),
    );
    const ids = findings.map((f) => f.ruleId);
    expect(ids).toContain('mcp/unpinned-package');
    expect(ids).toContain('mcp/header-literal-secret');
    // Verify the existing finding shape is unchanged
    const old = findings.find((f) => f.ruleId === 'mcp/unpinned-package')!;
    expect(old.severity).toBe('medium');
    expect(typeof old.message).toBe('string');
    expect(old.message.length).toBeGreaterThan(0);
  });

  it('server with url-embedded-credential + remote-http-plaintext (old) reports both', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'http://admin:pass123@api.example.com/mcp', // both rules fire
        },
      }),
    );
    const ids = findings.map((f) => f.ruleId);
    expect(ids).toContain('mcp/remote-http-plaintext'); // existing
    expect(ids).toContain('mcp/url-embedded-credential'); // new
    // Old finding unchanged
    const old = findings.find((f) => f.ruleId === 'mcp/remote-http-plaintext')!;
    expect(old.severity).toBe('high');
  });

  it('server with header secret + env literal (old) + auto-approve (old) reports all three', () => {
    const findings = auditMcpConfig(
      json({
        srv: {
          url: 'https://mcp.example.com/sse',
          env: { MY_API_TOKEN: 'some-literal-token' }, // triggers mcp/env-literal-secret-key (old)
          headers: { 'x-api-key': 'hardcoded-key-value' }, // triggers mcp/header-literal-secret (new)
          autoApprove: true, // triggers mcp/auto-approve-wildcard (old)
        },
      }),
    );
    const ids = findings.map((f) => f.ruleId);
    expect(ids).toContain('mcp/env-literal-secret-key'); // old unchanged
    expect(ids).toContain('mcp/header-literal-secret'); // new
    expect(ids).toContain('mcp/auto-approve-wildcard'); // old unchanged
    // Old findings severity unchanged
    expect(findings.find((f) => f.ruleId === 'mcp/env-literal-secret-key')!.severity).toBe('high');
    expect(findings.find((f) => f.ruleId === 'mcp/auto-approve-wildcard')!.severity).toBe('high');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 畸形 JSON / 边界健壮性 — 绝不抛异常
// ──────────────────────────────────────────────────────────────────────────────

describe('v0.6-2 robustness: malformed/partial configs never throw', () => {
  it('invalid JSON → single low finding, no throw', () => {
    expect(() => auditMcpConfig('not json at all {{')).not.toThrow();
    const findings = auditMcpConfig('not json at all {{');
    expect(findings[0]!.ruleId).toBe('mcp/invalid-json');
  });

  it('headers field is an array → no throw, no header finding', () => {
    expect(() =>
      auditMcpConfig(
        json({
          remote: {
            url: 'https://mcp.example.com/sse',
            headers: ['Authorization: Bearer token'],
          },
        }),
      ),
    ).not.toThrow();
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          headers: ['Authorization: Bearer token'],
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/header-literal-secret')).toHaveLength(0);
  });

  it('headers values are non-string → no throw, no header finding', () => {
    expect(() =>
      auditMcpConfig(
        json({
          remote: {
            url: 'https://mcp.example.com/sse',
            headers: { Authorization: 42, 'x-api-key': null, token: true },
          },
        }),
      ),
    ).not.toThrow();
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'https://mcp.example.com/sse',
          headers: { Authorization: 42, 'x-api-key': null, token: true },
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/header-literal-secret')).toHaveLength(0);
  });

  it('url is null or number → no url-embedded-credential finding, no throw', () => {
    expect(() =>
      auditMcpConfig(json({ a: { url: null }, b: { url: 99 } })),
    ).not.toThrow();
    expect(
      auditMcpConfig(json({ a: { url: null }, b: { url: 99 } })).filter(
        (f) => f.ruleId === 'mcp/url-embedded-credential',
      ),
    ).toHaveLength(0);
  });

  it('completely empty mcpServers → no findings, no throw', () => {
    expect(() => auditMcpConfig(json({}))).not.toThrow();
    expect(auditMcpConfig(json({}))).toHaveLength(0);
  });
});
