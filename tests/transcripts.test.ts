// S8.1:transcript 解析层 — 路径发现优先级 + Skill tool_use 提取 + 防御性解析。
// fixture 形态系 2026-06-12 对本机真实 transcript 行结构脱敏复刻
//(顶层 type/timestamp/sessionId/message,content[] 内 tool_use{name:'Skill',input:{skill,args}})。
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverClaudeTranscriptRoots,
  listTranscriptFiles,
  parseSkillInvocationsFromFiles,
} from '../src/core/transcripts.ts';

const THOME = join(import.meta.dirname, 'fixtures', 'transcripts', 'home');

describe('路径发现', () => {
  it('默认在 home 下找 .claude/projects(存在才返回)', () => {
    const roots = discoverClaudeTranscriptRoots(THOME, {});
    expect(roots).toEqual([join(THOME, '.claude', 'projects')]);
  });

  it('CLAUDE_CONFIG_DIR 优先于默认位置', () => {
    const custom = join(THOME, '.claude'); // 任意存在目录充当自定义配置根
    const roots = discoverClaudeTranscriptRoots(THOME, { CLAUDE_CONFIG_DIR: custom });
    expect(roots).toEqual([join(custom, 'projects')]);
  });

  it('全都不存在时返回空(不抛)', () => {
    expect(discoverClaudeTranscriptRoots('/no/such/home', {})).toEqual([]);
  });
});

describe('JSONL 提取与防御', () => {
  it('递归发现 *.jsonl 并提取全部 Skill 触发(坏行/null input/未知字段不致崩)', async () => {
    const roots = discoverClaudeTranscriptRoots(THOME, {});
    const files = await listTranscriptFiles(roots);
    expect(files).toHaveLength(2);

    const invocations = await parseSkillInvocationsFromFiles(files);
    // session-a:loop + commit-style(Bash 行、坏 JSON 行、input:null 行、字符串 content 行全部安全跳过)
    // session-b:loop
    expect(invocations).toHaveLength(3);
    expect(invocations.map((i) => i.skill).sort()).toEqual(['commit-style', 'loop', 'loop']);
  });

  it('记录 timestamp 与来源文件', async () => {
    const roots = discoverClaudeTranscriptRoots(THOME, {});
    const files = await listTranscriptFiles(roots);
    const invocations = await parseSkillInvocationsFromFiles(files);
    const loop = invocations.find((i) => i.skill === 'loop' && i.sessionFile.includes('session-a'));
    expect(loop).toBeDefined();
    expect(loop!.timestamp).toBe('2026-06-10T08:00:05.000Z');
  });

  it('整文件全是坏行也不抛,返回空', async () => {
    const invocations = await parseSkillInvocationsFromFiles([]);
    expect(invocations).toEqual([]);
  });
});
