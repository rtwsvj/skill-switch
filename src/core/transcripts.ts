// S8.1 transcript 解析层(只读):Claude Code JSONL 的路径发现与 Skill 触发提取。
// 路径发现优先级参考 ccusage 的 claude/paths.rs 模式(思路移植,非代码):
//   $CLAUDE_CONFIG_DIR → ~/.config/claude → ~/.claude,取 <root>/projects 下递归 *.jsonl。
// 防御性解析:格式无官方 schema 且随版本漂移(ccusage 为此写了大量防御),
// 任何一行解析失败/形状不符 → 跳过该行,绝不抛出。
// 触发事件形态(2026-06-12 本机实证):assistant 行 message.content[] 内
//   {"type":"tool_use","name":"Skill","input":{"skill":"…","args":"…"}}。
//
// P3-D6 扩展:adapter 注册式结构支持多个 AI 工具的 transcript 格式。
//   内置 Claude Code adapter(原有行为)+ Codex CLI adapter(~/.codex/sessions/)。
//   无对应目录时静默跳过;保持纯本地只读、零遥测。
import { existsSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface SkillInvocation {
  skill: string;
  args?: string;
  timestamp?: string;
  sessionFile: string;
}

// ── Adapter 接口(注册式架构) ─────────────────────────────────────────────────

/**
 * Transcript adapter:封装一种 AI 工具的 transcript 目录发现 + JSONL 解析逻辑。
 * 内置两个适配器:Claude Code + Codex CLI。
 * 无对应目录时 discoverRoots 返回 [];parseInvocations 静默跳过无法解析的行。
 */
export interface TranscriptAdapter {
  /** 人类可读名称,用于日志/调试 */
  name: string;
  /**
   * 发现 transcript 根目录列表(只读)。
   * home: 用户 home 目录;env: 环境变量(可注入,便于测试)。
   * 目录不存在时返回 [] 而非抛出。
   */
  discoverRoots(home: string, env: Record<string, string | undefined>): string[];
  /**
   * 从单个 JSONL 文件内容提取 SkillInvocation 列表。
   * 任何解析错误都静默跳过;返回 { invocations, parseErrors }。
   */
  parseInvocations(
    jsonl: string,
    sessionFile: string,
  ): { invocations: SkillInvocation[]; parseErrors: number };
}

// ── 工具函数 ─────────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

// ── Claude Code Adapter ───────────────────────────────────────────────────────

/**
 * Claude Code 适配器(原有行为,保持不变)。
 * 路径:$CLAUDE_CONFIG_DIR/projects 或 ~/.config/claude/projects 或 ~/.claude/projects。
 * 格式:assistant 行 message.content[] 内 {type:"tool_use",name:"Skill",input:{skill,args}}。
 */
export const claudeCodeAdapter: TranscriptAdapter = {
  name: 'Claude Code',

  discoverRoots(home, env) {
    const candidates: string[] = [];
    const configDir = env.CLAUDE_CONFIG_DIR?.trim();
    if (configDir) {
      candidates.push(join(configDir, 'projects'));
    } else {
      candidates.push(join(home, '.config', 'claude', 'projects'));
      candidates.push(join(home, '.claude', 'projects'));
    }
    return candidates.filter((dir) => existsSync(dir));
  },

  parseInvocations(jsonl, sessionFile) {
    const invocations: SkillInvocation[] = [];
    let parseErrors = 0;
    for (const line of jsonl.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parseErrors += 1;
        continue;
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
    return { invocations, parseErrors };
  },
};

// ── Codex CLI Adapter ─────────────────────────────────────────────────────────

/**
 * Codex CLI 适配器(P3-D6 新增)。
 * 路径:~/.codex/sessions/(含子目录 YYYY/MM/DD/)下的所有 *.jsonl。
 *
 * Codex JSONL 格式(2026-06 实证):
 *   {timestamp, type:"response_item", payload:{type:"function_call", name:"<工具名>", arguments:"<JSON字符串>", call_id:""}}
 *   {timestamp, type:"response_item", payload:{type:"function_call_output", ...}}
 *   {timestamp, type:"session_meta", payload:{...}}
 *   {timestamp, type:"event_msg", payload:{...}}
 *
 * skill 映射:将 payload.name 作为 skill 名(如 exec_command、pinhaoma-docs 等工具)。
 * 忽略 function_call_output 等非调用行;payload.arguments 若是 JSON 对象则取其 cmd 字段作 args。
 * 目录不存在时静默返回 []。
 */
export const codexAdapter: TranscriptAdapter = {
  name: 'Codex CLI',

  discoverRoots(home, _env) {
    // Codex CLI 固定使用 ~/.codex/sessions/,不受环境变量影响
    const sessionsDir = join(home, '.codex', 'sessions');
    return existsSync(sessionsDir) ? [sessionsDir] : [];
  },

  parseInvocations(jsonl, sessionFile) {
    const invocations: SkillInvocation[] = [];
    let parseErrors = 0;
    for (const line of jsonl.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parseErrors += 1;
        continue;
      }
      const record = asRecord(parsed);
      // Codex 行必须是 type=response_item
      if (record?.type !== 'response_item') continue;
      const payload = asRecord(record.payload);
      // 只关心 function_call(不含 function_call_output)
      if (!payload || payload.type !== 'function_call') continue;
      const skillName = typeof payload.name === 'string' ? payload.name.trim() : '';
      if (!skillName) continue;

      // 尝试从 arguments 字符串里提取 cmd 字段作为 args(可选)
      let args: string | undefined;
      if (typeof payload.arguments === 'string') {
        try {
          const argObj = asRecord(JSON.parse(payload.arguments));
          if (argObj && typeof argObj.cmd === 'string') {
            args = argObj.cmd;
          }
        } catch {
          // arguments 格式无法解析时忽略
        }
      }

      // timestamp 在顶层
      const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined;

      invocations.push({
        skill: skillName,
        ...(args !== undefined ? { args } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
        sessionFile,
      });
    }
    return { invocations, parseErrors };
  },
};

// ── Adapter 注册表(可被测试注入替换) ────────────────────────────────────────

/** 全局已注册的适配器列表;按顺序运行,互不干扰。 */
const registeredAdapters: TranscriptAdapter[] = [claudeCodeAdapter, codexAdapter];

/**
 * 注册额外的 adapter(供插件/测试使用)。
 * 如需替换全部,直接操作 registeredAdapters。
 */
export function registerTranscriptAdapter(adapter: TranscriptAdapter): void {
  registeredAdapters.push(adapter);
}

// ── 公开 API(保持向后兼容) ───────────────────────────────────────────────────

/** 发现 transcript 根目录;env 注入便于测试,真实目录永远只读。
 * 向后兼容:只查 Claude Code adapter 的根目录(原有行为)。
 */
export function discoverClaudeTranscriptRoots(
  home: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return claudeCodeAdapter.discoverRoots(home, env);
}

export async function listTranscriptFiles(roots: string[], maxDepth = 12): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= maxDepth) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(full);
      }
    }
  }
  for (const root of roots) await walk(root, 0);
  return files.sort();
}

export function parseSkillInvocations(jsonl: string, sessionFile: string): SkillInvocation[] {
  return parseSkillInvocationsWithCounts(jsonl, sessionFile).invocations;
}

/** 同 parseSkillInvocations,但额外返回坏行计数(供 stats 透明报告 parseErrors)。
 * 使用 Claude Code adapter 解析(向后兼容原有行为)。
 */
export function parseSkillInvocationsWithCounts(
  jsonl: string,
  sessionFile: string,
): { invocations: SkillInvocation[]; parseErrors: number } {
  return claudeCodeAdapter.parseInvocations(jsonl, sessionFile);
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

/**
 * 多 adapter 聚合:用所有注册的适配器发现并解析 transcript。
 * 每个适配器的根目录独立遍历;无对应目录时静默跳过。
 * 返回:所有适配器收集到的 SkillInvocation 合并列表(按 sessionFile 排序)。
 */
export async function discoverAllTranscriptRoots(
  home: string,
  env: Record<string, string | undefined> = process.env,
  adapters: TranscriptAdapter[] = registeredAdapters,
): Promise<{ adapter: TranscriptAdapter; roots: string[] }[]> {
  return adapters.map((adapter) => ({
    adapter,
    roots: adapter.discoverRoots(home, env),
  }));
}

/**
 * 跨所有 adapter 解析 transcript,合并返回 SkillInvocation。
 * 内部用于多 agent 环境;每个适配器使用其自身的解析逻辑。
 */
export async function parseAllAdapterInvocations(
  home: string,
  env: Record<string, string | undefined> = process.env,
  maxDepth = 12,
  adapters: TranscriptAdapter[] = registeredAdapters,
): Promise<SkillInvocation[]> {
  const all: SkillInvocation[] = [];
  for (const { adapter, roots } of await discoverAllTranscriptRoots(home, env, adapters)) {
    if (roots.length === 0) continue;
    const files = await listTranscriptFiles(roots, maxDepth);
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { invocations } = adapter.parseInvocations(content, file);
      all.push(...invocations);
    }
  }
  // 按 sessionFile 排序保证确定性
  return all.sort((a, b) => a.sessionFile.localeCompare(b.sessionFile));
}
