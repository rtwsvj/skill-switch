// S8.1 transcript 解析层(只读):Claude Code JSONL 的路径发现与 Skill 触发提取。
// 路径发现优先级参考 ccusage 的 claude/paths.rs 模式(思路移植,非代码):
//   $CLAUDE_CONFIG_DIR → ~/.config/claude → ~/.claude,取 <root>/projects 下递归 *.jsonl。
// 防御性解析:格式无官方 schema 且随版本漂移(ccusage 为此写了大量防御),
// 任何一行解析失败/形状不符 → 跳过该行,绝不抛出。
// 触发事件形态(2026-06-12 本机实证):assistant 行 message.content[] 内
//   {"type":"tool_use","name":"Skill","input":{"skill":"…","args":"…"}}。
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface SkillInvocation {
  skill: string;
  args?: string;
  timestamp?: string;
  sessionFile: string;
}

/** 发现 transcript 根目录;env 注入便于测试,真实目录永远只读。 */
export function discoverClaudeTranscriptRoots(
  home: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const candidates: string[] = [];
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) {
    candidates.push(join(configDir, 'projects'));
  } else {
    candidates.push(join(home, '.config', 'claude', 'projects'));
    candidates.push(join(home, '.claude', 'projects'));
  }
  return candidates.filter((dir) => existsSync(dir));
}

export async function listTranscriptFiles(roots: string[]): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
  }
  for (const root of roots) await walk(root);
  return files.sort();
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export function parseSkillInvocations(jsonl: string, sessionFile: string): SkillInvocation[] {
  const invocations: SkillInvocation[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // 坏行跳过
    }
    const record = asRecord(parsed);
    const message = asRecord(record?.message);
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const b = asRecord(block);
      if (!b || b.type !== 'tool_use' || b.name !== 'Skill') continue;
      const input = asRecord(b.input);
      if (!input || typeof input.skill !== 'string' || input.skill === '') continue;
      invocations.push({
        skill: input.skill,
        ...(typeof input.args === 'string' ? { args: input.args } : {}),
        ...(typeof record?.timestamp === 'string' ? { timestamp: record.timestamp } : {}),
        sessionFile,
      });
    }
  }
  return invocations;
}

export async function parseSkillInvocationsFromFiles(files: string[]): Promise<SkillInvocation[]> {
  const all: SkillInvocation[] = [];
  for (const file of files) {
    try {
      all.push(...parseSkillInvocations(await readFile(file, 'utf8'), file));
    } catch {
      // 单文件不可读不影响整体
    }
  }
  return all;
}
