// 线 E:MCP server 测试。
//   - 直接测 handleMcpRequest(协议握手 / tools/list / tools/call / 错误路径)。
//   - stdio e2e:spawn bin/skill-switch.mjs mcp,喂行分隔 JSON-RPC,断言 stdout 响应。
//   - 安全:MCP 这条路只读;audit 工具能查出恶意 fixture 的反向 shell。
//   - 新工具:skill_switch_packs_suggest(共现建议)/ skill_switch_stats(使用统计+僵尸)。
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach } from 'vitest';
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
  it('列出全部只读工具(5 个),每个带 inputSchema', async () => {
    const res = await handleMcpRequest(req('tools/list'), VER);
    const tools = (res as { result: { tools: { name: string; inputSchema: unknown }[] } }).result
      .tools;
    expect(tools.map((t) => t.name)).toEqual([
      'skill_switch_scan',
      'skill_switch_status',
      'skill_switch_audit',
      'skill_switch_packs_suggest',
      'skill_switch_stats',
    ]);
    for (const t of tools) {
      expect(t.inputSchema).toMatchObject({ type: 'object' });
    }
    expect(tools.length).toBe(5);
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

// ── 辅助:构建带 transcript 的临时 home(用于 packs_suggest / stats 测试)──────────

/** 构造一行带 Skill tool_use 的 assistant JSONL 行 */
function skillLine(skill: string, timestamp?: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `u-${skill}-${timestamp ?? 'no-ts'}`,
    ...(timestamp ? { timestamp } : {}),
    sessionId: 'irrelevant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_x', name: 'Skill', input: { skill } }],
    },
  });
}

/** ISO 字符串:N 天前 */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/** 写入一个 session 文件(JSONL) */
async function writeSession(
  home: string,
  projDir: string,
  fileName: string,
  lines: string[],
): Promise<void> {
  const dir = join(home, '.claude', 'projects', projDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), `${lines.join('\n')}\n`);
}

/** 写一个 SKILL.md 到指定 skills 目录,模拟已安装 skill */
async function writeSkillMd(home: string, skillName: string): Promise<void> {
  const dir = join(home, '.claude', 'skills', skillName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: fixture.\n---\nContent.\n`,
  );
}

let mcpHome: string;

beforeEach(() => {
  mcpHome = mkdtempSync(join(tmpdir(), 'ss-mcp-new-'));
});

describe('MCP server — skill_switch_packs_suggest', () => {
  it('无 transcript 时返回空建议列表,不抛', async () => {
    const res = await handleMcpRequest(
      req('tools/call', { name: 'skill_switch_packs_suggest', arguments: { home: mcpHome } }),
      VER,
    );
    const data = JSON.parse(callText(res)) as {
      sessionCount: number;
      suggestionCount: number;
      suggestions: unknown[];
    };
    expect(data.sessionCount).toBe(0);
    expect(data.suggestionCount).toBe(0);
    expect(data.suggestions).toEqual([]);
  });

  it('两 skill 高频共现 → 产出套餐建议(含 id/suggestedName/skills/rationale/strength)', async () => {
    // 写 5 个 session,每个都包含 alpha + beta,满足 minSessionsTogether=3 阈值
    for (let i = 0; i < 5; i++) {
      await writeSession(mcpHome, 'p', `s${i}.jsonl`, [
        skillLine('alpha', daysAgo(1)),
        skillLine('beta', daysAgo(1)),
      ]);
    }
    const res = await handleMcpRequest(
      req('tools/call', { name: 'skill_switch_packs_suggest', arguments: { home: mcpHome } }),
      VER,
    );
    const data = JSON.parse(callText(res)) as {
      sessionCount: number;
      suggestionCount: number;
      suggestions: { id: string; suggestedName: string; skills: string[]; rationale: string; strength: number }[];
    };
    expect(data.sessionCount).toBe(5);
    expect(data.suggestionCount).toBeGreaterThan(0);
    const s = data.suggestions[0]!;
    expect(s.id).toMatch(/^pack-/);
    expect(s.suggestedName).toMatch(/工作流$/);
    expect(s.skills).toContain('alpha');
    expect(s.skills).toContain('beta');
    expect(typeof s.rationale).toBe('string');
    expect(s.rationale.length).toBeGreaterThan(0);
    expect(s.strength).toBeGreaterThan(0);
    expect(s.strength).toBeLessThanOrEqual(1);
    // 内容安全:不含对话内容或 fileContents 等内部字段
    const raw = callText(res);
    expect(raw).not.toContain('fileContents');
    expect(raw).not.toContain('dialog');
  });

  it('windowDays 参数生效:窗口外触发被排除不产生建议', async () => {
    // 写 5 个 session,但时间戳是 40 天前(超出 windowDays=7)
    for (let i = 0; i < 5; i++) {
      await writeSession(mcpHome, 'p', `old${i}.jsonl`, [
        skillLine('alpha', daysAgo(40)),
        skillLine('beta', daysAgo(40)),
      ]);
    }
    const res = await handleMcpRequest(
      req('tools/call', {
        name: 'skill_switch_packs_suggest',
        arguments: { home: mcpHome, windowDays: 7 },
      }),
      VER,
    );
    const data = JSON.parse(callText(res)) as {
      windowDays: number;
      suggestionCount: number;
    };
    expect(data.windowDays).toBe(7);
    expect(data.suggestionCount).toBe(0);
  });
});

describe('MCP server — skill_switch_stats', () => {
  it('无 transcript 无 skill 时返回空报告,不抛', async () => {
    const res = await handleMcpRequest(
      req('tools/call', { name: 'skill_switch_stats', arguments: { home: mcpHome } }),
      VER,
    );
    const data = JSON.parse(callText(res)) as {
      invocations: number;
      usage: unknown[];
      zombieCount: number;
      zombies: unknown[];
    };
    expect(data.invocations).toBe(0);
    expect(data.usage).toEqual([]);
    expect(data.zombieCount).toBe(0);
    expect(data.zombies).toEqual([]);
  });

  it('有 transcript + 已安装 skill → 报告 usage 计数和僵尸 skill', async () => {
    // 安装两个 skill:used-skill 有触发,zombie-skill 零触发
    await writeSkillMd(mcpHome, 'used-skill');
    await writeSkillMd(mcpHome, 'zombie-skill');
    // 写 transcript:used-skill 近期 3 次触发
    await writeSession(mcpHome, 'proj', 'sess.jsonl', [
      skillLine('used-skill', daysAgo(1)),
      skillLine('used-skill', daysAgo(2)),
      skillLine('used-skill', daysAgo(3)),
    ]);
    const res = await handleMcpRequest(
      req('tools/call', { name: 'skill_switch_stats', arguments: { home: mcpHome } }),
      VER,
    );
    const data = JSON.parse(callText(res)) as {
      invocations: number;
      usage: { skill: string; count: number }[];
      zombieCount: number;
      zombies: { name: string }[];
    };
    expect(data.invocations).toBe(3);
    const usedEntry = data.usage.find((u) => u.skill === 'used-skill');
    expect(usedEntry).toBeDefined();
    expect(usedEntry!.count).toBe(3);
    expect(data.zombieCount).toBe(1);
    expect(data.zombies.map((z) => z.name)).toContain('zombie-skill');
    // 内容安全:不含对话正文或 fileContents
    const raw = callText(res);
    expect(raw).not.toContain('fileContents');
  });

  it('days 参数生效:窗口外触发被排除', async () => {
    await writeSkillMd(mcpHome, 'used-skill');
    await writeSession(mcpHome, 'proj', 'sess.jsonl', [
      skillLine('used-skill', daysAgo(1)),   // 窗口内
      skillLine('used-skill', daysAgo(40)),  // 窗口外
    ]);
    const res = await handleMcpRequest(
      req('tools/call', { name: 'skill_switch_stats', arguments: { home: mcpHome, days: 7 } }),
      VER,
    );
    const data = JSON.parse(callText(res)) as {
      since: string;
      invocations: number;
      usage: { skill: string; count: number }[];
    };
    expect(data.since).toBeTruthy();
    expect(data.invocations).toBe(1);
    const entry = data.usage.find((u) => u.skill === 'used-skill');
    expect(entry!.count).toBe(1);
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
