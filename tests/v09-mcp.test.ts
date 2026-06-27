// 线 E:MCP server 测试。
//   - 直接测 handleMcpRequest(协议握手 / tools/list / tools/call / 错误路径)。
//   - stdio e2e:spawn bin/skill-switch.mjs mcp,喂行分隔 JSON-RPC,断言 stdout 响应。
//   - 安全:MCP 这条路只读;audit 工具能查出恶意 fixture 的反向 shell。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  handleMcpRequest,
  MCP_PROTOCOL_VERSION,
  MCP_TOOLS,
  type JsonRpcRequest,
} from '../src/mcp/server.ts';

const HOME_BASIC = fileURLToPath(new URL('./fixtures/home-basic', import.meta.url));
const MALICIOUS = fileURLToPath(
  new URL('./fixtures/skills-malicious/revshell-netcat', import.meta.url),
);
const BIN = fileURLToPath(new URL('../bin/skill-switch.mjs', import.meta.url));
const VER = '0.9.0-test';

function req(method: string, params?: Record<string, unknown>, id: number | null = 1): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

/** 解析 tools/call 文本结果(我们的工具都返回 JSON 字符串)。 */
function callText(res: Awaited<ReturnType<typeof handleMcpRequest>>): string {
  const result = (res as { result: { content: { type: string; text: string }[]; isError?: boolean } })
    .result;
  return result.content[0]!.text;
}

describe('MCP server — 协议握手', () => {
  it('initialize 返回协议版本 + serverInfo', async () => {
    const res = await handleMcpRequest(req('initialize'), VER);
    expect(res).not.toBeNull();
    const result = (res as { result: Record<string, unknown> }).result as {
      protocolVersion: string;
      capabilities: { tools: unknown };
      serverInfo: { name: string; version: string };
    };
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.serverInfo).toEqual({ name: 'skill-switch', version: VER });
    expect(result.capabilities.tools).toBeDefined();
  });

  it('notifications/initialized 是通知,无响应', async () => {
    const res = await handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, VER);
    expect(res).toBeNull();
  });

  it('ping 返回空对象', async () => {
    const res = await handleMcpRequest(req('ping'), VER);
    expect((res as { result: unknown }).result).toEqual({});
  });

  it('未知方法(带 id)返回 -32601', async () => {
    const res = await handleMcpRequest(req('does/not/exist'), VER);
    expect((res as { error: { code: number } }).error.code).toBe(-32601);
  });
});

describe('MCP server — tools/list', () => {
  it('列出全部只读工具,每个带 inputSchema', async () => {
    const res = await handleMcpRequest(req('tools/list'), VER);
    const tools = (res as { result: { tools: { name: string; inputSchema: unknown }[] } }).result
      .tools;
    expect(tools.map((t) => t.name)).toEqual([
      'skill_switch_scan',
      'skill_switch_status',
      'skill_switch_audit',
    ]);
    for (const t of tools) {
      expect(t.inputSchema).toMatchObject({ type: 'object' });
    }
    expect(tools.length).toBe(MCP_TOOLS.length);
  });
});

describe('MCP server — tools/call', () => {
  it('skill_switch_scan 返回 home 内 skill 清单', async () => {
    const res = await handleMcpRequest(
      req('tools/call', { name: 'skill_switch_scan', arguments: { home: HOME_BASIC } }),
      VER,
    );
    const data = JSON.parse(callText(res)) as { total: number; skills: unknown[] };
    expect(data.total).toBeGreaterThan(0);
    expect(Array.isArray(data.skills)).toBe(true);
  });

  it('skill_switch_status 返回现状摘要', async () => {
    const res = await handleMcpRequest(
      req('tools/call', { name: 'skill_switch_status', arguments: { home: HOME_BASIC } }),
      VER,
    );
    const data = JSON.parse(callText(res)) as { onDisk: number; health: string; agents: string[] };
    expect(typeof data.onDisk).toBe('number');
    expect(['ok', 'no-declaration', 'drifted']).toContain(data.health);
  });

  it('skill_switch_audit(给 path)查出恶意 skill 的反向 shell', async () => {
    const res = await handleMcpRequest(
      req('tools/call', { name: 'skill_switch_audit', arguments: { path: MALICIOUS } }),
      VER,
    );
    const data = JSON.parse(callText(res)) as {
      mode: string;
      findingCount: number;
      findings: { ruleId: string; severity: string }[];
    };
    expect(data.mode).toBe('path');
    expect(data.findingCount).toBeGreaterThan(0);
    expect(data.findings.some((f) => f.ruleId.includes('reverse-shell'))).toBe(true);
    // 不泄露内部字段(fileContents Map 等)
    expect(callText(res)).not.toContain('fileContents');
  });

  it('skill_switch_audit(给 home)审整个 home 并报 anyBlocked', async () => {
    const res = await handleMcpRequest(
      req('tools/call', { name: 'skill_switch_audit', arguments: { home: HOME_BASIC } }),
      VER,
    );
    const data = JSON.parse(callText(res)) as { mode: string; total: number; anyBlocked: boolean };
    expect(data.mode).toBe('home');
    expect(typeof data.anyBlocked).toBe('boolean');
  });

  it('未知工具返回 -32602', async () => {
    const res = await handleMcpRequest(
      req('tools/call', { name: 'nope', arguments: {} }),
      VER,
    );
    expect((res as { error: { code: number } }).error.code).toBe(-32602);
  });

  it('工具执行出错 → isError 结果(而非 JSON-RPC error)', async () => {
    // 给 audit 一个不存在的路径,auditSkillDir 应抛错 → 转 isError
    const res = await handleMcpRequest(
      req('tools/call', {
        name: 'skill_switch_audit',
        arguments: { path: '/no/such/path/__definitely_missing__' },
      }),
      VER,
    );
    const result = (res as { result: { isError?: boolean } }).result;
    expect(result.isError).toBe(true);
  });
});

describe('MCP server — stdio e2e(bin shim,cwd 无关)', () => {
  it('initialize + tools/list 走真实 stdio 往返', async () => {
    const responses = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        out += d;
      });
      child.on('error', reject);
      child.on('close', () => {
        const lines = out.split('\n').filter((l) => l.trim());
        resolve(lines.map((l) => JSON.parse(l) as Record<string, unknown>));
      });
      child.stdin.write(`${JSON.stringify(req('initialize', {}, 1))}\n`);
      child.stdin.write(`${JSON.stringify(req('tools/list', {}, 2))}\n`);
      child.stdin.end();
    });

    expect(responses.length).toBe(2);
    const init = responses.find((r) => r.id === 1) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    const list = responses.find((r) => r.id === 2) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toContain('skill_switch_audit');
  }, 20_000);
});
