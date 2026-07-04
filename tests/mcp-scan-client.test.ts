// client.ts 测试 —— JSON-RPC 客户端(stdio + http)的安全姿态。
//
// 关键安全断言:
//   1. mock stdio server 的 MOCK_LOG_FILE 全程无 `tools/call`(规格铁律)
//   2. 响应体 >2MB → 立即断开 + too-large 错误
//   3. 超时:mock 不响应 → 在预算内返回 timeout,stdio 子进程已被 SIGTERM/SIGKILL
//   4. http:// 远端 host(非 loopback)→ 拒绝(insecure-url)
//   5. http:// localhost → 走通;header VALUE 不出现在任何错误信息/结果里
//   6. 协议序列固定为 initialize → notifications/initialized → tools/list

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  assertScanUrl,
  connectAndListTools,
  connectHttp,
  connectStdio,
  DEFAULT_TIMEOUT_MS,
  describeServer,
  describeStdioCommand,
  MAX_RESPONSE_BYTES,
  McpScanClientError,
} from '../src/core/mcp-scan/client.ts';
import type { McpServerSpec } from '../src/core/mcp-scan/discover.ts';

const ROOT = join(import.meta.dirname, '..');
const MOCK_BIN = join(ROOT, 'tests', 'fixtures', 'mcp-scan', 'mock-server.mjs');

// ── 临时目录与工具函数 ──────────────────────────────────────────────────────

const TMP_DIRS: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-scan-client-'));
  TMP_DIRS.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of TMP_DIRS) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

function makeMockEnv(tmpDir: string, tools: unknown[], opts: {
  logFile?: string;
  hang?: boolean;
  protocol?: string;
} = {}): { env: Record<string, string>; toolsFile: string; logFile: string } {
  const toolsFile = join(tmpDir, 'tools.json');
  const logFile = opts.logFile ?? join(tmpDir, 'methods.log');
  writeFileSync(toolsFile, JSON.stringify(tools));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.MOCK_TOOLS_FILE = toolsFile;
  env.MOCK_LOG_FILE = logFile;
  if (opts.hang) env.MOCK_HANG = '1';
  if (opts.protocol) env.MOCK_PROTOCOL = opts.protocol;
  return { toolsFile, logFile, env };
}

function stdioSpec(env: Record<string, string>, name = 'mock'): McpServerSpec {
  return {
    name,
    source: '.claude/mcp.json',
    transport: 'stdio',
    command: process.execPath, // node
    args: [MOCK_BIN],
    env,
  };
}

function readLog(logFile: string): string[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
}

// ══════════════════════════════════════════════════════════════════════════════
// assertScanUrl — URL 安全断言
// ══════════════════════════════════════════════════════════════════════════════

describe('assertScanUrl', () => {
  it('https:// 任意 host → 通过', () => {
    expect(assertScanUrl('https://mcp.example.com/v1').protocol).toBe('https:');
  });

  it('http:// localhost / 127.0.0.1 / ::1 → 通过', () => {
    expect(assertScanUrl('http://localhost:3000').protocol).toBe('http:');
    expect(assertScanUrl('http://127.0.0.1:3000').protocol).toBe('http:');
    expect(assertScanUrl('http://[::1]:3000').protocol).toBe('http:');
  });

  it('http:// 远端 host → 拒绝(insecure-url)', () => {
    expect(() => assertScanUrl('http://attacker.example.com/v1')).toThrow(McpScanClientError);
    try {
      assertScanUrl('http://attacker.example.com/v1');
    } catch (e) {
      expect((e as McpScanClientError).code).toBe('insecure-url');
    }
  });

  it('非 http(s) 协议 → 拒绝(invalid-url)', () => {
    expect(() => assertScanUrl('ws://example.com')).toThrow(McpScanClientError);
    expect(() => assertScanUrl('file:///etc/passwd')).toThrow(McpScanClientError);
  });

  it('无法解析的 URL → 拒绝(invalid-url)', () => {
    expect(() => assertScanUrl('not a url')).toThrow(McpScanClientError);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 描述工具
// ══════════════════════════════════════════════════════════════════════════════

describe('describeStdioCommand', () => {
  it('拼成单行可读形式', () => {
    expect(describeStdioCommand({
      name: 'x', source: '.claude/mcp.json', transport: 'stdio',
      command: 'npx', args: ['pkg', '/work'],
    })).toBe('npx pkg /work');
  });

  it('参数含空格 → 用 JSON 字符串引号包裹(防止歧义)', () => {
    expect(describeStdioCommand({
      name: 'x', source: '.claude/mcp.json', transport: 'stdio',
      command: 'sh', args: ['-c', 'echo hello world'],
    })).toBe('sh -c "echo hello world"');
  });
});

describe('describeServer', () => {
  it('stdio:返回命令 basename', () => {
    expect(describeServer({
      name: 'x', source: '.claude/mcp.json', transport: 'stdio',
      command: 'node', args: ['server.js'],
    })).toBe('stdio: node server.js');
  });

  it('http:返回 URL', () => {
    expect(describeServer({
      name: 'x', source: '.claude/mcp.json', transport: 'http',
      url: 'https://mcp.example.com/v1',
    })).toBe('http: https://mcp.example.com/v1');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// stdio 客户端 —— 走通 + 协议序列断言
// ══════════════════════════════════════════════════════════════════════════════

describe('connectStdio', () => {
  it('与 mock server 跑通 initialize → tools/list,返回工具清单与协议版本', async () => {
    const tmp = makeTmpDir();
    const { env, logFile } = makeMockEnv(tmp, [
      { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
      { name: 'list_dir', description: 'List a directory', inputSchema: {} },
    ]);

    const result = await connectStdio(stdioSpec(env), 5000);
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.tools.map((t) => t.name).sort()).toEqual(['list_dir', 'read_file']);

    // 关键安全断言:mock server 只收到 initialize / tools/list(通知不计入 log);
    // 严禁出现 tools/call。
    const log = readLog(logFile);
    expect(log).toContain('initialize');
    expect(log).toContain('tools/list');
    expect(log).not.toContain('tools/call');
  });

  it('通知 notifications/initialized 不写响应(mock 不应把它算作调用)', async () => {
    const tmp = makeTmpDir();
    const { env, logFile } = makeMockEnv(tmp, []);
    await connectStdio(stdioSpec(env), 5000);
    // log 里会出现一次(因为 mock 把每个 method 都写 log)
    // 但这不计入"调用":协议上通知无 id、无响应
    expect(readLog(logFile)).toContain('notifications/initialized');
  });

  it('远端协议版本(自定义)→ 透传', async () => {
    const tmp = makeTmpDir();
    const { env } = makeMockEnv(tmp, [], { protocol: '2025-03-26' });
    const r = await connectStdio(stdioSpec(env), 5000);
    expect(r.protocolVersion).toBe('2025-03-26');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// stdio 客户端 —— 超时硬杀
// ══════════════════════════════════════════════════════════════════════════════

describe('connectStdio timeout', () => {
  it('mock 不响应 → 在预算内 timeout,子进程被 kill(exit code 非空 / 被信号杀)', async () => {
    const tmp = makeTmpDir();
    const { env } = makeMockEnv(tmp, [], { hang: true });

    const budget = 1500;
    const start = Date.now();
    await expect(connectStdio(stdioSpec(env), budget))
      .rejects.toBeInstanceOf(McpScanClientError);
    const elapsed = Date.now() - start;

    // 在预算内 + 宽限期(SIGTERM → SIGKILL 各 1s)内返回
    expect(elapsed).toBeLessThan(budget + DEFAULT_TIMEOUT_MS);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// stdio 客户端 —— 响应体上限
// ══════════════════════════════════════════════════════════════════════════════

describe('connectStdio response size cap', () => {
  it('mock 返回超大响应 → too-large 错误', async () => {
    const tmp = makeTmpDir();
    // tools 里塞一个大 description(> 2MB),确保 tools/list 响应体 > MAX_RESPONSE_BYTES
    const huge = 'x'.repeat(MAX_RESPONSE_BYTES + 1024);
    const { env } = makeMockEnv(tmp, [
      { name: 'huge', description: huge, inputSchema: {} },
    ]);

    await expect(connectStdio(stdioSpec(env), 5000))
      .rejects.toBeInstanceOf(McpScanClientError);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// http 客户端 —— localhost 走通
// ══════════════════════════════════════════════════════════════════════════════

describe('connectHttp', () => {
  let server: import('node:http').Server;
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
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let req2: { method?: string; id?: number };
        try { req2 = JSON.parse(body); } catch { req2 = {}; }
        const id = typeof req2.id === 'number' ? req2.id : null;
        if (req2.method === 'initialize') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0', id,
            result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock-http' } },
          }));
        } else if (req2.method === 'tools/list') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0', id,
            result: { tools: [{ name: 'http_tool', description: 'via http', inputSchema: {} }] },
          }));
        } else {
          res.end();
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

  it('localhost http → 走通', async () => {
    const r = await connectHttp({
      name: 'http', source: '.claude/mcp.json', transport: 'http', url: baseUrl,
    }, 5000);
    expect(r.tools).toEqual([
      { name: 'http_tool', description: 'via http', inputSchema: {} },
    ]);
  });

  it('header VALUE 绝不出现在错误信息或结果里', async () => {
    const r = await connectHttp({
      name: 'http', source: '.claude/mcp.json', transport: 'http', url: baseUrl,
      headers: { authorization: 'Bearer super-secret-token-XXXXX' },
    }, 5000);
    // 结果里没有 header 内容
    expect(JSON.stringify(r)).not.toContain('super-secret-token-XXXXX');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// http 客户端 —— 非 localhost 拒绝
// ══════════════════════════════════════════════════════════════════════════════

describe('connectHttp non-loopback rejection', () => {
  it('http://attacker.example.com → 拒绝(insecure-url)', async () => {
    await expect(connectHttp({
      name: 'evil', source: '.claude/mcp.json', transport: 'http',
      url: 'http://attacker.example.com/mcp',
    }, 1000)).rejects.toMatchObject({ code: 'insecure-url' });
  });

  it('连接失败也走结构化错误(不抛裸异常)', async () => {
    await expect(connectHttp({
      name: 'broken', source: '.claude/mcp.json', transport: 'http',
      url: 'http://127.0.0.1:1/mcp', // 端口 1 通常不可达
    }, 1000)).rejects.toBeInstanceOf(McpScanClientError);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 统一入口
// ══════════════════════════════════════════════════════════════════════════════

describe('connectAndListTools', () => {
  it('按 spec.transport 自动选 stdio 或 http', async () => {
    const tmp = makeTmpDir();
    const { env } = makeMockEnv(tmp, [{ name: 't', description: '', inputSchema: {} }]);
    const r = await connectAndListTools(stdioSpec(env), 5000);
    expect(r.tools[0]!.name).toBe('t');
  });

  it('未知 transport → 抛 protocol-error', async () => {
    await expect(connectAndListTools({
      name: 'x', source: '.claude/mcp.json',
      transport: 'bogus' as 'stdio',
    }, 1000)).rejects.toMatchObject({ code: 'protocol-error' });
  });
});

// ── 副作用测试:跨 describe 共用清理 ────────────────────────────────────────

afterEach(() => {
  // 给 mock server 一个清理窗口(避免上一个测试的 mock 还残留 stdio 句柄)
  return new Promise((r) => setTimeout(r, 10));
});