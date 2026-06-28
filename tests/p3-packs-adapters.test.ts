// P3-D6:多 adapter transcript 适配测试。
// 验证:Codex CLI adapter 解析正确(fixture)、Claude Code adapter 向后兼容、
//       adapter 注册式架构工作(静默跳过不存在目录)、parseAllAdapterInvocations 聚合。

import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  claudeCodeAdapter,
  codexAdapter,
  discoverAllTranscriptRoots,
  parseAllAdapterInvocations,
} from '../src/core/transcripts.ts';

// ── Fixture 工厂 ─────────────────────────────────────────────────────────────

/** Claude Code JSONL 行:Skill tool_use */
function ccSkillLine(skill: string, timestamp?: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `u-cc-${skill}`,
    ...(timestamp ? { timestamp } : {}),
    sessionId: 'cc-session',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_x', name: 'Skill', input: { skill } }],
    },
  });
}

/** Codex CLI JSONL 行:response_item + function_call */
function codexFuncCall(name: string, cmd?: string, timestamp?: string): string {
  const ts = timestamp ?? new Date().toISOString();
  const args = cmd ? JSON.stringify({ cmd, workdir: '/tmp', yield_time_ms: 1000 }) : '{}';
  return JSON.stringify({
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'function_call',
      name,
      arguments: args,
      call_id: `call_${name}_${Date.now()}`,
    },
  });
}

/** Codex CLI JSONL 行:function_call_output(应被忽略) */
function codexFuncOutput(callId: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output: 'some output',
    },
  });
}

/** Codex CLI JSONL 行:session_meta(应被忽略) */
function codexSessionMeta(id: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'session_meta',
    payload: { id, cli_version: '0.137.0' },
  });
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ss-adapter-'));
});

// ── Claude Code adapter:基础功能(向后兼容) ──────────────────────────────────

describe('claudeCodeAdapter', () => {
  it('discoverRoots:目录不存在时返回空数组', () => {
    const roots = claudeCodeAdapter.discoverRoots('/no/such/home', {});
    expect(roots).toEqual([]);
  });

  it('discoverRoots:~/.claude/projects 存在时返回该目录', async () => {
    const dir = join(home, '.claude', 'projects');
    await mkdir(dir, { recursive: true });
    const roots = claudeCodeAdapter.discoverRoots(home, {});
    expect(roots).toContain(dir);
  });

  it('parseInvocations:正确解析 Skill tool_use 行', () => {
    const ts = '2026-06-01T10:00:00.000Z';
    const jsonl = [ccSkillLine('loop', ts), ccSkillLine('run', ts)].join('\n');
    const { invocations, parseErrors } = claudeCodeAdapter.parseInvocations(jsonl, 'file.jsonl');
    expect(invocations).toHaveLength(2);
    expect(invocations[0]!.skill).toBe('loop');
    expect(invocations[1]!.skill).toBe('run');
    expect(parseErrors).toBe(0);
  });

  it('parseInvocations:非 Skill tool_use 行被忽略', () => {
    const bashLine = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    const { invocations } = claudeCodeAdapter.parseInvocations(bashLine, 'file.jsonl');
    expect(invocations).toHaveLength(0);
  });

  it('parseInvocations:坏 JSON 行计入 parseErrors,不崩溃', () => {
    const jsonl = `not-json\n${ccSkillLine('loop')}`;
    const { invocations, parseErrors } = claudeCodeAdapter.parseInvocations(jsonl, 'f.jsonl');
    expect(parseErrors).toBe(1);
    expect(invocations).toHaveLength(1);
  });
});

// ── Codex CLI adapter ────────────────────────────────────────────────────────

describe('codexAdapter', () => {
  it('discoverRoots:~/.codex/sessions 不存在时返回空数组', () => {
    const roots = codexAdapter.discoverRoots('/no/such/home', {});
    expect(roots).toEqual([]);
  });

  it('discoverRoots:~/.codex/sessions 存在时返回该目录', async () => {
    const sessionsDir = join(home, '.codex', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const roots = codexAdapter.discoverRoots(home, {});
    expect(roots).toEqual([sessionsDir]);
  });

  it('discoverRoots:不受 CLAUDE_CONFIG_DIR 影响(Codex 目录固定)', async () => {
    const sessionsDir = join(home, '.codex', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const roots = codexAdapter.discoverRoots(home, { CLAUDE_CONFIG_DIR: '/custom/path' });
    // Codex adapter 忽略环境变量,只看 home/.codex/sessions
    expect(roots).toEqual([sessionsDir]);
  });

  it('parseInvocations:正确解析 function_call 行', () => {
    const ts = '2026-06-01T10:00:00.000Z';
    const jsonl = [
      codexSessionMeta('session-1'),
      codexFuncCall('exec_command', 'ls -la', ts),
      codexFuncCall('pinhaoma-docs', undefined, ts),
      codexFuncOutput('call_abc'),
    ].join('\n');
    const { invocations, parseErrors } = codexAdapter.parseInvocations(jsonl, 'file.jsonl');
    // session_meta 和 function_call_output 被忽略,只有 2 个 function_call
    expect(invocations).toHaveLength(2);
    expect(invocations[0]!.skill).toBe('exec_command');
    expect(invocations[0]!.args).toBe('ls -la'); // cmd 字段提取为 args
    expect(invocations[0]!.timestamp).toBe(ts);
    expect(invocations[1]!.skill).toBe('pinhaoma-docs');
    expect(parseErrors).toBe(0);
  });

  it('parseInvocations:function_call_output 行被忽略', () => {
    const jsonl = codexFuncOutput('call_xyz');
    const { invocations } = codexAdapter.parseInvocations(jsonl, 'f.jsonl');
    expect(invocations).toHaveLength(0);
  });

  it('parseInvocations:session_meta/event_msg 行被忽略', () => {
    const jsonl = [
      codexSessionMeta('session-abc'),
      JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { msg: 'hi' } }),
    ].join('\n');
    const { invocations } = codexAdapter.parseInvocations(jsonl, 'f.jsonl');
    expect(invocations).toHaveLength(0);
  });

  it('parseInvocations:坏 JSON 行计入 parseErrors', () => {
    const jsonl = `broken json\n${codexFuncCall('exec_command', 'ls')}`;
    const { parseErrors, invocations } = codexAdapter.parseInvocations(jsonl, 'f.jsonl');
    expect(parseErrors).toBe(1);
    expect(invocations).toHaveLength(1);
  });

  it('parseInvocations:arguments 格式非法时静默忽略 args,skill 名仍正确', () => {
    // arguments 不是合法 JSON
    const line = JSON.stringify({
      timestamp: '2026-06-01T10:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: 'not-json-at-all',
        call_id: 'call_abc',
      },
    });
    const { invocations } = codexAdapter.parseInvocations(line, 'f.jsonl');
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.skill).toBe('exec_command');
    expect(invocations[0]!.args).toBeUndefined(); // 无法解析则 args 缺失
  });
});

// ── parseAllAdapterInvocations 聚合 ──────────────────────────────────────────

describe('parseAllAdapterInvocations — 多 adapter 聚合', () => {
  it('两个 adapter 目录都不存在时返回空数组(静默)', async () => {
    const result = await parseAllAdapterInvocations('/no/such/home');
    expect(result).toEqual([]);
  });

  it('只有 Claude Code 目录时返回 CC 调用,Codex 静默跳过', async () => {
    const ccDir = join(home, '.claude', 'projects', 'proj');
    await mkdir(ccDir, { recursive: true });
    const ts = '2026-06-01T10:00:00.000Z';
    await writeFile(join(ccDir, 'session.jsonl'), `${ccSkillLine('loop', ts)}\n`);
    const result = await parseAllAdapterInvocations(home, {}, 12, [claudeCodeAdapter, codexAdapter]);
    expect(result).toHaveLength(1);
    expect(result[0]!.skill).toBe('loop');
  });

  it('只有 Codex 目录时返回 Codex 调用,Claude Code 静默跳过', async () => {
    const codexDir = join(home, '.codex', 'sessions', '2026', '06', '01');
    await mkdir(codexDir, { recursive: true });
    const ts = '2026-06-01T10:00:00.000Z';
    await writeFile(
      join(codexDir, 'session.jsonl'),
      `${codexFuncCall('exec_command', 'ls', ts)}\n`,
    );
    const result = await parseAllAdapterInvocations(home, {}, 12, [claudeCodeAdapter, codexAdapter]);
    expect(result).toHaveLength(1);
    expect(result[0]!.skill).toBe('exec_command');
  });

  it('两个 adapter 都有数据时合并返回', async () => {
    // CC session
    const ccDir = join(home, '.claude', 'projects', 'proj');
    await mkdir(ccDir, { recursive: true });
    const ts = '2026-06-01T10:00:00.000Z';
    await writeFile(join(ccDir, 'cc.jsonl'), `${ccSkillLine('loop', ts)}\n`);

    // Codex session
    const codexDir = join(home, '.codex', 'sessions', '2026', '06', '01');
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, 'codex.jsonl'), `${codexFuncCall('exec_command', 'ls', ts)}\n`);

    const result = await parseAllAdapterInvocations(home, {}, 12, [claudeCodeAdapter, codexAdapter]);
    expect(result).toHaveLength(2);
    const skills = result.map((i) => i.skill).sort();
    expect(skills).toContain('loop');
    expect(skills).toContain('exec_command');
  });
});

// ── discoverAllTranscriptRoots ───────────────────────────────────────────────

describe('discoverAllTranscriptRoots', () => {
  it('返回每个 adapter 的 roots(包括空数组)', async () => {
    // 只创建 CC 目录
    const ccDir = join(home, '.claude', 'projects');
    await mkdir(ccDir, { recursive: true });
    const infos = await discoverAllTranscriptRoots(home, {}, [claudeCodeAdapter, codexAdapter]);
    expect(infos).toHaveLength(2);
    const cc = infos.find((i) => i.adapter.name === 'Claude Code');
    const codex = infos.find((i) => i.adapter.name === 'Codex CLI');
    expect(cc!.roots).toContain(ccDir);
    expect(codex!.roots).toEqual([]); // Codex 目录不存在
  });
});
