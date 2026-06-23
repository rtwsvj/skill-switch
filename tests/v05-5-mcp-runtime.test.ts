// v0.5-5: 运行时 MCP 审计 — 新增三项静态能力检查的测试
// 测试结构:每个新 ruleId 都有「危险配置 → 应触发」和「良性边界 → 不触发」两类用例。
// 同时验证:组合旧+新风险的配置旧有 finding 仍原样输出;畸形 JSON 不抛异常。
import { describe, expect, it } from 'vitest';
import { auditMcpConfig } from '../src/core/audit/mcp-audit.ts';

// ──────────────────────────────────────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────────────────────────────────────

function json(mcpServers: Record<string, unknown>): string {
  return JSON.stringify({ mcpServers });
}

// ──────────────────────────────────────────────────────────────────────────────
// Check 1: mcp/remote-http-plaintext — http:// 非回环主机
// ──────────────────────────────────────────────────────────────────────────────

describe('v0.5-5 check 1: remote-http-plaintext', () => {
  // === 触发用例 ===

  it('http:// to a remote host → high mcp/remote-http-plaintext', () => {
    const findings = auditMcpConfig(
      json({
        remote: {
          url: 'http://api.example.com/mcp',
          command: 'node',
          args: ['./server.js'],
        },
      }),
    );
    const hit = findings.find((f) => f.ruleId === 'mcp/remote-http-plaintext');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('high');
  });

  it('http:// to a raw IP (non-loopback) → high mcp/remote-http-plaintext', () => {
    const findings = auditMcpConfig(
      json({
        remote: { url: 'http://203.0.113.5:8080/mcp' },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/remote-http-plaintext')).toBeDefined();
  });

  it('serverUrl field with http:// remote host is also checked', () => {
    const findings = auditMcpConfig(
      json({
        remote: { serverUrl: 'http://evil.internal/mcp' },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/remote-http-plaintext')).toBeDefined();
  });

  // === 良性边界 — 绝不触发 ===

  it('http://localhost → ZERO mcp/remote-http-plaintext (loopback is safe)', () => {
    const findings = auditMcpConfig(
      json({ local: { url: 'http://localhost:3000/mcp' } }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/remote-http-plaintext')).toHaveLength(0);
  });

  it('http://127.0.0.1 → ZERO mcp/remote-http-plaintext', () => {
    const findings = auditMcpConfig(
      json({ local: { url: 'http://127.0.0.1:8080/' } }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/remote-http-plaintext')).toHaveLength(0);
  });

  it('http://[::1] → ZERO mcp/remote-http-plaintext', () => {
    const findings = auditMcpConfig(
      json({ local: { url: 'http://[::1]:4000/sse' } }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/remote-http-plaintext')).toHaveLength(0);
  });

  it('https:// to a normal domain → ZERO mcp/remote-http-plaintext', () => {
    const findings = auditMcpConfig(
      json({ remote: { url: 'https://api.example.com/mcp' } }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/remote-http-plaintext')).toHaveLength(0);
  });

  it('no url field at all → ZERO remote transport findings', () => {
    const findings = auditMcpConfig(
      json({ srv: { command: 'node', args: ['./server.js'] } }),
    );
    expect(findings.filter((f) => f.ruleId.startsWith('mcp/remote-'))).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Check 1b: mcp/remote-untrusted-host — https:// 裸 IP
// ──────────────────────────────────────────────────────────────────────────────

describe('v0.5-5 check 1b: remote-untrusted-host', () => {
  it('https:// to a raw IP (non-loopback) → medium mcp/remote-untrusted-host', () => {
    const findings = auditMcpConfig(
      json({ remote: { url: 'https://192.168.1.50/mcp' } }),
    );
    const hit = findings.find((f) => f.ruleId === 'mcp/remote-untrusted-host');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('medium');
  });

  // 良性边界

  it('https://127.0.0.1 → ZERO mcp/remote-untrusted-host (loopback)', () => {
    const findings = auditMcpConfig(
      json({ local: { url: 'https://127.0.0.1:9000/' } }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/remote-untrusted-host')).toHaveLength(0);
  });

  it('https:// to a normal domain → ZERO mcp/remote-untrusted-host', () => {
    const findings = auditMcpConfig(
      json({ remote: { url: 'https://mcp.example.com/sse' } }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/remote-untrusted-host')).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Check 2: 自动批准绕过 — mcp/auto-approve-wildcard + mcp/auto-approve-broad
// ──────────────────────────────────────────────────────────────────────────────

describe('v0.5-5 check 2: auto-approve-wildcard', () => {
  // === 触发 ===

  it('autoApprove: true → high mcp/auto-approve-wildcard', () => {
    const findings = auditMcpConfig(
      json({ srv: { command: 'node', args: ['./server.js'], autoApprove: true } }),
    );
    const hit = findings.find((f) => f.ruleId === 'mcp/auto-approve-wildcard');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('high');
  });

  it('alwaysAllow: true → high mcp/auto-approve-wildcard', () => {
    const findings = auditMcpConfig(
      json({ srv: { command: 'node', args: ['./server.js'], alwaysAllow: true } }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/auto-approve-wildcard')).toBeDefined();
  });

  it('autoApprove: ["*"] → high mcp/auto-approve-wildcard', () => {
    const findings = auditMcpConfig(
      json({ srv: { command: 'node', args: ['./server.js'], autoApprove: ['*'] } }),
    );
    const hit = findings.find((f) => f.ruleId === 'mcp/auto-approve-wildcard');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('high');
  });

  it('alwaysAllow: ["tool1", "*", "tool2"] → high mcp/auto-approve-wildcard', () => {
    const findings = auditMcpConfig(
      json({
        srv: {
          command: 'node',
          args: ['./server.js'],
          alwaysAllow: ['tool1', '*', 'tool2'],
        },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/auto-approve-wildcard')).toBeDefined();
  });

  // === 良性边界 ===

  it('autoApprove absent → ZERO auto-approve findings', () => {
    const findings = auditMcpConfig(
      json({ srv: { command: 'node', args: ['./server.js'] } }),
    );
    expect(findings.filter((f) => f.ruleId.startsWith('mcp/auto-approve'))).toHaveLength(0);
  });

  it('autoApprove: [] (empty array) → ZERO auto-approve findings', () => {
    const findings = auditMcpConfig(
      json({ srv: { command: 'node', args: ['./server.js'], autoApprove: [] } }),
    );
    expect(findings.filter((f) => f.ruleId.startsWith('mcp/auto-approve'))).toHaveLength(0);
  });

  it('autoApprove: ["read_file"] (single tool, targeted) → ZERO wildcard finding', () => {
    const findings = auditMcpConfig(
      json({
        srv: {
          command: 'node',
          args: ['./server.js'],
          autoApprove: ['read_file'],
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/auto-approve-wildcard')).toHaveLength(0);
  });

  it('autoApprove: false → ZERO auto-approve findings', () => {
    const findings = auditMcpConfig(
      json({ srv: { command: 'node', args: ['./server.js'], autoApprove: false } }),
    );
    expect(findings.filter((f) => f.ruleId.startsWith('mcp/auto-approve'))).toHaveLength(0);
  });
});

describe('v0.5-5 check 2b: auto-approve-broad', () => {
  // === 触发 ===

  it('autoApprove: 5-tool list → medium mcp/auto-approve-broad', () => {
    const findings = auditMcpConfig(
      json({
        srv: {
          command: 'node',
          args: ['./server.js'],
          autoApprove: ['read_file', 'write_file', 'list_dir', 'exec_cmd', 'fetch_url'],
        },
      }),
    );
    const hit = findings.find((f) => f.ruleId === 'mcp/auto-approve-broad');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('medium');
  });

  it('alwaysAllow with 8 tools → medium mcp/auto-approve-broad', () => {
    const findings = auditMcpConfig(
      json({
        srv: {
          command: 'node',
          args: ['./server.js'],
          alwaysAllow: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
        },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/auto-approve-broad')).toBeDefined();
  });

  // === 良性边界 ===

  it('autoApprove: 2 specific tools → ZERO auto-approve-broad (targeted is fine)', () => {
    const findings = auditMcpConfig(
      json({
        srv: {
          command: 'node',
          args: ['./server.js'],
          autoApprove: ['read_file', 'list_dir'],
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/auto-approve-broad')).toHaveLength(0);
  });

  it('autoApprove: 4 tools (below threshold) → ZERO auto-approve-broad', () => {
    const findings = auditMcpConfig(
      json({
        srv: {
          command: 'node',
          args: ['./server.js'],
          autoApprove: ['read_file', 'write_file', 'list_dir', 'exec_cmd'],
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/auto-approve-broad')).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Check 3a: mcp/broad-filesystem-scope — args 包含根/home 路径
// ──────────────────────────────────────────────────────────────────────────────

describe('v0.5-5 check 3a: broad-filesystem-scope', () => {
  // === 触发 ===

  it('arg is exactly "/" → high mcp/broad-filesystem-scope', () => {
    const findings = auditMcpConfig(
      json({
        fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0', '/'] },
      }),
    );
    const hit = findings.find((f) => f.ruleId === 'mcp/broad-filesystem-scope');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('high');
  });

  it('arg is "~" → high mcp/broad-filesystem-scope', () => {
    const findings = auditMcpConfig(
      json({
        fs: { command: 'node', args: ['./server.js', '~'] },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/broad-filesystem-scope')).toBeDefined();
  });

  it('arg is "$HOME" → high mcp/broad-filesystem-scope', () => {
    const findings = auditMcpConfig(
      json({
        fs: { command: 'node', args: ['./server.js', '$HOME'] },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/broad-filesystem-scope')).toBeDefined();
  });

  it('arg is shell $HOME reference → high mcp/broad-filesystem-scope', () => {
    // Build the literal string without template syntax to keep the linter happy
    const homeRef = ['$', '{HOME}'].join('');
    const findings = auditMcpConfig(
      json({
        fs: { command: 'node', args: ['./server.js', homeRef] },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/broad-filesystem-scope')).toBeDefined();
  });

  it('arg is Windows drive root "C:\\" → high mcp/broad-filesystem-scope', () => {
    const findings = auditMcpConfig(
      json({
        fs: { command: 'node.exe', args: ['server.js', 'C:\\'] },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/broad-filesystem-scope')).toBeDefined();
  });

  // === 良性边界 ===

  it('arg is a normal project subpath → ZERO mcp/broad-filesystem-scope', () => {
    const findings = auditMcpConfig(
      json({
        fs: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0', '/home/user/projects'],
        },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/broad-filesystem-scope')).toHaveLength(0);
  });

  it('arg is "~/projects" (home subdir) → ZERO mcp/broad-filesystem-scope', () => {
    const findings = auditMcpConfig(
      json({
        fs: { command: 'node', args: ['./server.js', '~/projects/myapp'] },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/broad-filesystem-scope')).toHaveLength(0);
  });

  it('no args → ZERO mcp/broad-filesystem-scope', () => {
    const findings = auditMcpConfig(
      json({ srv: { url: 'https://mcp.example.com/sse' } }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/broad-filesystem-scope')).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Check 3b: mcp/dangerous-permission-flag — 危险权限标志
// ──────────────────────────────────────────────────────────────────────────────

describe('v0.5-5 check 3b: dangerous-permission-flag', () => {
  // === 触发 ===

  it('arg --allow-all → medium mcp/dangerous-permission-flag', () => {
    const findings = auditMcpConfig(
      json({
        srv: { command: 'deno', args: ['run', '--allow-all', 'server.ts'] },
      }),
    );
    const hit = findings.find((f) => f.ruleId === 'mcp/dangerous-permission-flag');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('medium');
  });

  it('arg --no-sandbox → medium mcp/dangerous-permission-flag', () => {
    const findings = auditMcpConfig(
      json({
        srv: { command: 'node', args: ['--no-sandbox', './server.js'] },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/dangerous-permission-flag')).toBeDefined();
  });

  it('arg --dangerously-skip-permissions → medium mcp/dangerous-permission-flag', () => {
    const findings = auditMcpConfig(
      json({
        srv: { command: 'node', args: ['./server.js', '--dangerously-skip-permissions'] },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/dangerous-permission-flag')).toBeDefined();
  });

  it('arg --allow-read=* → medium mcp/dangerous-permission-flag', () => {
    const findings = auditMcpConfig(
      json({
        srv: { command: 'deno', args: ['run', '--allow-read=*', 'server.ts'] },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/dangerous-permission-flag')).toBeDefined();
  });

  it('arg --unsafe-perm → medium mcp/dangerous-permission-flag', () => {
    const findings = auditMcpConfig(
      json({
        srv: { command: 'node', args: ['--unsafe-perm', './server.js'] },
      }),
    );
    expect(findings.find((f) => f.ruleId === 'mcp/dangerous-permission-flag')).toBeDefined();
  });

  // === 良性边界 ===

  it('--allow-read=/safe/path (specific path, not wildcard) → ZERO mcp/dangerous-permission-flag', () => {
    const findings = auditMcpConfig(
      json({
        srv: { command: 'deno', args: ['run', '--allow-read=/opt/data', 'server.ts'] },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/dangerous-permission-flag')).toHaveLength(0);
  });

  it('normal node flags → ZERO mcp/dangerous-permission-flag', () => {
    const findings = auditMcpConfig(
      json({
        srv: { command: 'node', args: ['--experimental-vm-modules', './server.js', '--port', '3000'] },
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/dangerous-permission-flag')).toHaveLength(0);
  });

  it('no args → ZERO mcp/dangerous-permission-flag', () => {
    const findings = auditMcpConfig(
      json({ srv: { url: 'https://mcp.example.com/sse' } }),
    );
    expect(findings.filter((f) => f.ruleId === 'mcp/dangerous-permission-flag')).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 组合测试: 旧有检查 + 新检查并存 — 旧 finding 原样保留
// ──────────────────────────────────────────────────────────────────────────────

describe('v0.5-5 combination: old + new findings coexist unchanged', () => {
  it('server with old risk (unpinned npx) + new risk (http url) reports both', () => {
    const findings = auditMcpConfig(
      json({
        mixed: {
          command: 'npx',
          args: ['some-mcp-server'], // triggers mcp/unpinned-package (existing)
          url: 'http://attacker.example.com/mcp', // triggers mcp/remote-http-plaintext (new)
        },
      }),
    );
    const ids = findings.map((f) => f.ruleId);
    expect(ids).toContain('mcp/unpinned-package');
    expect(ids).toContain('mcp/remote-http-plaintext');
    // Verify the existing finding shape is unchanged
    const old = findings.find((f) => f.ruleId === 'mcp/unpinned-package')!;
    expect(old.severity).toBe('medium');
    expect(typeof old.message).toBe('string');
    expect(old.message.length).toBeGreaterThan(0);
  });

  it('server with literal secret (old) + autoApprove wildcard (new) reports both', () => {
    const findings = auditMcpConfig(
      json({
        srv: {
          command: 'node',
          args: ['./server.js'],
          env: { MY_API_TOKEN: 'literal-secret-value' }, // triggers mcp/env-literal-secret-key
          autoApprove: ['*'], // triggers mcp/auto-approve-wildcard
        },
      }),
    );
    const ids = findings.map((f) => f.ruleId);
    expect(ids).toContain('mcp/env-literal-secret-key');
    expect(ids).toContain('mcp/auto-approve-wildcard');
  });

  it('server with LD_PRELOAD (old) + broad fs scope (new) + dangerous flag (new) reports all three', () => {
    const findings = auditMcpConfig(
      json({
        srv: {
          command: 'node',
          args: ['./server.js', '--allow-all', '/'],
          env: { LD_PRELOAD: '/tmp/evil.so' }, // old: mcp/env-preload-hijack (critical)
        },
      }),
    );
    const ids = findings.map((f) => f.ruleId);
    expect(ids).toContain('mcp/env-preload-hijack');
    expect(ids).toContain('mcp/broad-filesystem-scope');
    expect(ids).toContain('mcp/dangerous-permission-flag');
    // Old finding severity unchanged
    expect(findings.find((f) => f.ruleId === 'mcp/env-preload-hijack')!.severity).toBe('critical');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 畸形 JSON / 边界健壮性 — 绝不抛异常
// ──────────────────────────────────────────────────────────────────────────────

describe('v0.5-5 robustness: malformed/partial configs never throw', () => {
  it('invalid JSON string → single low finding, no throw', () => {
    expect(() => auditMcpConfig('not json at all {{')).not.toThrow();
    const findings = auditMcpConfig('not json at all {{');
    expect(findings[0]!.ruleId).toBe('mcp/invalid-json');
  });

  it('server entry with non-string url → no throw, no remote finding', () => {
    const weird = JSON.stringify({
      mcpServers: {
        a: { url: 42 },
        b: { url: null },
        c: { url: { nested: 'object' } },
      },
    });
    expect(() => auditMcpConfig(weird)).not.toThrow();
    const findings = auditMcpConfig(weird);
    expect(findings.filter((f) => f.ruleId.startsWith('mcp/remote-'))).toHaveLength(0);
  });

  it('server entry with non-array autoApprove values → no throw, no auto-approve finding', () => {
    const weird = JSON.stringify({
      mcpServers: {
        a: { autoApprove: 'yes' },
        b: { autoApprove: 42 },
        c: { alwaysAllow: { nested: true } },
      },
    });
    expect(() => auditMcpConfig(weird)).not.toThrow();
    // Non-boolean / non-array values are not flagged (only true or arrays)
    const findings = auditMcpConfig(weird);
    expect(findings.filter((f) => f.ruleId.startsWith('mcp/auto-approve'))).toHaveLength(0);
  });

  it('server entry with null / numeric args elements → no throw', () => {
    const weird = JSON.stringify({
      mcpServers: {
        a: { command: 'node', args: [null, 42, '/', true] },
      },
    });
    expect(() => auditMcpConfig(weird)).not.toThrow();
  });

  it('completely empty mcpServers → no findings, no throw', () => {
    expect(() => auditMcpConfig(json({}))).not.toThrow();
    expect(auditMcpConfig(json({}))).toHaveLength(0);
  });
});
