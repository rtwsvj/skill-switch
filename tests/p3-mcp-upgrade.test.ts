// P3-D7 MCP server 升级测试:协议版本 2025-06-18、annotations、resources、prompts、outputSchema。
//   - 全部 additive:不改动 v09-mcp.test.ts 任何用例。
//   - 直接测 handleMcpRequest(单元级,无 subprocess 开销)。
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  handleMcpRequest,
  MCP_PROTOCOL_VERSION,
  MCP_TOOLS,
  type JsonRpcRequest,
} from '../src/mcp/server.ts';

const HOME_BASIC = fileURLToPath(new URL('./fixtures/home-basic', import.meta.url));
const VER = '0.9.0-test';

function req(method: string, params?: Record<string, unknown>, id: number | null = 1): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

// ── 1. 协议版本升级 ──────────────────────────────────────────────────────────

describe('MCP P3 — 协议版本', () => {
  it('MCP_PROTOCOL_VERSION 常量为 2025-06-18', () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2025-06-18');
  });

  it('initialize 响应带正确协议版本', async () => {
    const res = await handleMcpRequest(req('initialize'), VER);
    const result = (res as { result: { protocolVersion: string } }).result;
    expect(result.protocolVersion).toBe('2025-06-18');
  });

  it('initialize capabilities 包含 tools + resources + prompts', async () => {
    const res = await handleMcpRequest(req('initialize'), VER);
    const caps = (res as { result: { capabilities: Record<string, unknown> } }).result.capabilities;
    expect(caps.tools).toBeDefined();
    expect(caps.resources).toBeDefined();
    expect(caps.prompts).toBeDefined();
  });
});

// ── 2. tools/list annotations + outputSchema ─────────────────────────────────

describe('MCP P3 — tools/list annotations', () => {
  it('每个工具都带 annotations.readOnlyHint=true', async () => {
    const res = await handleMcpRequest(req('tools/list'), VER);
    const tools = (res as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } })
      .result.tools;
    for (const t of tools) {
      expect(t.annotations, `${t.name} 缺 annotations`).toBeDefined();
      expect(t.annotations.readOnlyHint, `${t.name}.readOnlyHint 不是 true`).toBe(true);
    }
  });

  it('每个工具 annotations.destructiveHint=false', async () => {
    const res = await handleMcpRequest(req('tools/list'), VER);
    const tools = (res as { result: { tools: { name: string; annotations: { destructiveHint: boolean } }[] } })
      .result.tools;
    for (const t of tools) {
      expect(t.annotations.destructiveHint, `${t.name}.destructiveHint 不是 false`).toBe(false);
    }
  });

  it('每个工具 annotations.idempotentHint=true', async () => {
    const res = await handleMcpRequest(req('tools/list'), VER);
    const tools = (res as { result: { tools: { name: string; annotations: { idempotentHint: boolean } }[] } })
      .result.tools;
    for (const t of tools) {
      expect(t.annotations.idempotentHint, `${t.name}.idempotentHint 不是 true`).toBe(true);
    }
  });

  it('skill_switch_audit 工具带 outputSchema(含 oneOf)', async () => {
    const res = await handleMcpRequest(req('tools/list'), VER);
    const tools = (res as { result: { tools: { name: string; outputSchema?: unknown }[] } }).result.tools;
    const auditTool = tools.find((t) => t.name === 'skill_switch_audit');
    expect(auditTool).toBeDefined();
    expect(auditTool!.outputSchema).toBeDefined();
    const schema = auditTool!.outputSchema as { type: string; oneOf: unknown[] };
    expect(schema.type).toBe('object');
    expect(Array.isArray(schema.oneOf)).toBe(true);
    expect(schema.oneOf.length).toBe(2);
  });

  it('MCP_TOOLS 数组里每个工具对象带 annotations 字段', () => {
    for (const t of MCP_TOOLS) {
      expect(t.annotations, `${t.name} 缺 annotations`).toBeDefined();
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.annotations.destructiveHint).toBe(false);
      expect(t.annotations.idempotentHint).toBe(true);
    }
  });

  it('工具总数仍为 5', async () => {
    const res = await handleMcpRequest(req('tools/list'), VER);
    const tools = (res as { result: { tools: unknown[] } }).result.tools;
    expect(tools.length).toBe(5);
  });
});

// ── 3. resources/list + resources/read ───────────────────────────────────────

describe('MCP P3 — resources', () => {
  it('resources/list 返回至少两个资源', async () => {
    const res = await handleMcpRequest(req('resources/list'), VER);
    const resources = (res as { result: { resources: { uri: string; name: string }[] } }).result.resources;
    expect(Array.isArray(resources)).toBe(true);
    expect(resources.length).toBeGreaterThanOrEqual(2);
  });

  it('resources/list 包含 skill-switch://rules', async () => {
    const res = await handleMcpRequest(req('resources/list'), VER);
    const resources = (res as { result: { resources: { uri: string }[] } }).result.resources;
    expect(resources.some((r) => r.uri === 'skill-switch://rules')).toBe(true);
  });

  it('resources/read skill-switch://rules 返回规则类目 JSON', async () => {
    const res = await handleMcpRequest(
      req('resources/read', { uri: 'skill-switch://rules' }),
      VER,
    );
    const contents = (
      res as { result: { contents: { uri: string; mimeType: string; text: string }[] } }
    ).result.contents;
    expect(Array.isArray(contents)).toBe(true);
    expect(contents.length).toBeGreaterThan(0);
    const c = contents[0]!;
    expect(c.uri).toBe('skill-switch://rules');
    expect(c.mimeType).toBe('application/json');
    // 内容应是合法 JSON,且包含 categories 字段
    const parsed = JSON.parse(c.text) as { categories: { id: string }[] };
    expect(Array.isArray(parsed.categories)).toBe(true);
    expect(parsed.categories.length).toBeGreaterThan(0);
    // 至少包含反向 shell 和凭据钓鱼类目
    const ids = parsed.categories.map((c) => c.id);
    expect(ids).toContain('reverse-shell');
    expect(ids).toContain('credential-theft');
  });

  it('resources/read skill-switch://report/last 返回说明文本', async () => {
    const res = await handleMcpRequest(
      req('resources/read', { uri: 'skill-switch://report/last' }),
      VER,
    );
    const contents = (
      res as { result: { contents: { mimeType: string; text: string }[] } }
    ).result.contents;
    expect(contents[0]!.mimeType).toBe('text/plain');
    expect(contents[0]!.text.length).toBeGreaterThan(0);
  });

  it('resources/read 未知 URI 返回 -32602', async () => {
    const res = await handleMcpRequest(
      req('resources/read', { uri: 'skill-switch://no-such-resource' }),
      VER,
    );
    expect((res as { error: { code: number } }).error.code).toBe(-32602);
  });
});

// ── 4. prompts/list + prompts/get ────────────────────────────────────────────

describe('MCP P3 — prompts', () => {
  it('prompts/list 返回至少 3 条内置审计模板', async () => {
    const res = await handleMcpRequest(req('prompts/list'), VER);
    const prompts = (res as { result: { prompts: { name: string; description: string }[] } }).result.prompts;
    expect(Array.isArray(prompts)).toBe(true);
    expect(prompts.length).toBeGreaterThanOrEqual(3);
    for (const p of prompts) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it('prompts/list 包含 audit-all-skills / find-zombie-skills / audit-single-skill', async () => {
    const res = await handleMcpRequest(req('prompts/list'), VER);
    const names = (res as { result: { prompts: { name: string }[] } }).result.prompts.map((p) => p.name);
    expect(names).toContain('audit-all-skills');
    expect(names).toContain('find-zombie-skills');
    expect(names).toContain('audit-single-skill');
  });

  it('prompts/get audit-all-skills 返回 messages 数组(含 user 角色文本)', async () => {
    const res = await handleMcpRequest(
      req('prompts/get', { name: 'audit-all-skills', arguments: {} }),
      VER,
    );
    const result = (res as { result: { description: string; messages: { role: string; content: { type: string; text: string } }[] } }).result;
    expect(result.description.length).toBeGreaterThan(0);
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
    const msg = result.messages[0]!;
    expect(msg.role).toBe('user');
    expect(msg.content.type).toBe('text');
    expect(msg.content.text).toContain('skill_switch_audit');
  });

  it('prompts/get find-zombie-skills 带 days 参数:文本中提及 N 天', async () => {
    const res = await handleMcpRequest(
      req('prompts/get', { name: 'find-zombie-skills', arguments: { days: '30' } }),
      VER,
    );
    const messages = (res as { result: { messages: { content: { text: string } }[] } }).result.messages;
    expect(messages[0]!.content.text).toContain('30');
  });

  it('prompts/get audit-single-skill 带 path 参数:文本中带路径', async () => {
    const res = await handleMcpRequest(
      req('prompts/get', { name: 'audit-single-skill', arguments: { path: '/tmp/my-skill' } }),
      VER,
    );
    const messages = (res as { result: { messages: { content: { text: string } }[] } }).result.messages;
    expect(messages[0]!.content.text).toContain('/tmp/my-skill');
  });

  it('prompts/get 未知 prompt 返回 -32602', async () => {
    const res = await handleMcpRequest(
      req('prompts/get', { name: 'nope-does-not-exist' }),
      VER,
    );
    expect((res as { error: { code: number } }).error.code).toBe(-32602);
  });
});

// ── 5. 向后兼容:旧方法一律不变 ─────────────────────────────────────────────

describe('MCP P3 — 向后兼容', () => {
  it('tools/call 仍正常工作(scan)', async () => {
    const res = await handleMcpRequest(
      req('tools/call', { name: 'skill_switch_scan', arguments: { home: HOME_BASIC } }),
      VER,
    );
    const result = (res as { result: { content: { type: string; text: string }[] } }).result;
    expect(Array.isArray(result.content)).toBe(true);
    const data = JSON.parse(result.content[0]!.text) as { total: number };
    expect(typeof data.total).toBe('number');
  });

  it('ping 仍返回空对象', async () => {
    const res = await handleMcpRequest(req('ping'), VER);
    expect((res as { result: unknown }).result).toEqual({});
  });

  it('notifications/initialized 仍返回 null(无响应)', async () => {
    const res = await handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, VER);
    expect(res).toBeNull();
  });

  it('未知方法(带 id)仍返回 -32601', async () => {
    const res = await handleMcpRequest(req('unknown/method'), VER);
    expect((res as { error: { code: number } }).error.code).toBe(-32601);
  });
});
