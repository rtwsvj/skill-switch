// Config-file discovery and auditing for the `audit --configs` path.
// Pure read: discovers known agent config files under a home root,
// reads each one, runs the appropriate detection module, and returns findings
// grouped by file path.
//
// Currently covers:
//   Claude Code
//   - <home>/.claude/settings.json         → auditSettingsJson
//   - <home>/.claude/settings.local.json   → auditSettingsJson
//   - <home>/.claude/claude_desktop_config.json → auditMcpConfig
//   - <home>/.claude/mcp.json              → auditMcpConfig
//   - <home>/.mcp.json                     → auditMcpConfig  (user-level MCP config)
//   Gemini CLI
//   - <home>/.gemini/settings.json         → auditSettingsJson
//   Cursor
//   - <home>/.cursor/mcp.json              → auditMcpConfig
//   VS Code (MCP extension)
//   - <home>/.vscode/mcp.json              → auditMcpConfig
//   Windsurf (Codeium)
//   - <home>/.codeium/windsurf/mcp_config.json → auditMcpConfig
//   Zed AI
//   - <home>/.config/zed/settings.json     → auditSettingsJson(MCP 服务器在 context_servers 键下)
//
// Deliberately skipped(无兼容解析器 / 路径不规范 / 已废弃):
//   - ~/.codex/config.toml  (Codex — TOML 格式,未引入 TOML 解析器)
//   - Cline:配置在 VS Code globalStorage 下(含空格、随 VS Code 变体/平台变化,非简单 home 相对路径)
//   - Continue:~/.continue/config.json 已废弃→改 YAML(config.yaml)+ mcpServers/ 目录,审计废弃 JSON 无意义
//   - Claude Desktop:~/Library/Application Support/Claude/...(含空格,非简单 home 相对路径)
//
// All reads silently skip missing files (they may not exist on every system).

import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auditMcpConfig } from './mcp-audit.ts';
import { auditSettingsJson } from './settings-audit.ts';
import type { AuditFinding } from './types.ts';

export interface ConfigFileResult {
  /** Absolute path of the config file that was read. */
  absPath: string;
  /** Display path relative to home (e.g. ".claude/settings.json"). */
  relPath: string;
  /** Findings from the detection module, possibly empty. */
  findings: AuditFinding[];
}

// ─── Known config file descriptors ────────────────────────────────────────────

type ConfigKind = 'settings' | 'mcp';

interface KnownConfigFile {
  /** Path relative to home root. */
  relPath: string;
  kind: ConfigKind;
}

/**
 * Ordered list of known agent config files.
 * Extend here as more agent configs are identified.
 */
const KNOWN_CONFIGS: KnownConfigFile[] = [
  // ── Claude Code user settings ──────────────────────────────────────────────
  { relPath: '.claude/settings.json', kind: 'settings' },
  { relPath: '.claude/settings.local.json', kind: 'settings' },
  // Claude Desktop MCP config (also consumed by Claude Code)
  { relPath: '.claude/claude_desktop_config.json', kind: 'mcp' },
  // MCP config used by some setups
  { relPath: '.claude/mcp.json', kind: 'mcp' },
  // User-level MCP config (home root, loaded by Claude Code alongside .claude/mcp.json)
  { relPath: '.mcp.json', kind: 'mcp' },

  // ── Gemini CLI ─────────────────────────────────────────────────────────────
  // ~/.gemini/settings.json is the canonical Gemini CLI user config
  { relPath: '.gemini/settings.json', kind: 'settings' },

  // ── Cursor ─────────────────────────────────────────────────────────────────
  // ~/.cursor/mcp.json is Cursor's global MCP server config
  { relPath: '.cursor/mcp.json', kind: 'mcp' },

  // ── VS Code (MCP extension) ────────────────────────────────────────────────
  // ~/.vscode/mcp.json is VS Code's user-level MCP config (GitHub Copilot agent mode)
  { relPath: '.vscode/mcp.json', kind: 'mcp' },

  // ── Windsurf (Codeium) ─────────────────────────────────────────────────────
  // ~/.codeium/windsurf/mcp_config.json 是 Windsurf Cascade 的规范 MCP 配置(官方文档确认,标准 mcpServers 形态)
  { relPath: '.codeium/windsurf/mcp_config.json', kind: 'mcp' },

  // ── Zed AI ─────────────────────────────────────────────────────────────────
  // ~/.config/zed/settings.json 是 Zed 的规范用户配置(XDG 风格);MCP 服务器在 context_servers 键下
  { relPath: '.config/zed/settings.json', kind: 'settings' },
];

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Discover and audit all known agent config files under `home`.
 * Files that don't exist are silently skipped (not an error).
 * Never throws.
 */
export async function auditConfigFiles(home: string): Promise<ConfigFileResult[]> {
  const results: ConfigFileResult[] = [];

  for (const descriptor of KNOWN_CONFIGS) {
    const absPath = join(home, descriptor.relPath);
    // Guard: never follow symlinks — lstat does not dereference.
    // If the config path is a symlink (even to a regular file outside home),
    // skip it silently, just like a missing file.
    try {
      const st = await lstat(absPath);
      if (st.isSymbolicLink()) continue;
    } catch {
      // Path does not exist — skip silently
      continue;
    }

    let content: string;
    try {
      content = await readFile(absPath, 'utf8');
    } catch {
      // Unreadable — skip silently
      continue;
    }

    const findings = descriptor.kind === 'settings'
      ? auditSettingsJson(content)
      : auditMcpConfig(content);

    // Fix up the `file` field to show the home-relative path
    const annotated = findings.map((f) => ({ ...f, file: descriptor.relPath }));

    results.push({ absPath, relPath: descriptor.relPath, findings: annotated });
  }

  return results;
}

/** Collect all findings from config file results into a flat array. */
export function flattenConfigFindings(results: ConfigFileResult[]): AuditFinding[] {
  return results.flatMap((r) => r.findings);
}

/**
 * 读取 home 下所有 kind='mcp' 的配置文件原始内容,返回 Map<relPath, rawContent>。
 * 文件不存在或不可读则静默跳过;符号链接跳过(与 auditConfigFiles 保持一致)。
 * 供 MCP 漂移检测(fingerprintMcpServersFromRaw)使用。
 */
export async function readMcpConfigsRaw(home: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  for (const descriptor of KNOWN_CONFIGS) {
    if (descriptor.kind !== 'mcp') continue;
    const absPath = join(home, descriptor.relPath);
    try {
      const st = await lstat(absPath);
      if (st.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    try {
      const content = await readFile(absPath, 'utf8');
      result.set(descriptor.relPath, content);
    } catch {
      // 不可读 — 跳过
    }
  }

  return result;
}

/**
 * 读取 home 下所有 kind='settings' 的配置文件原始内容,返回 Map<relPath, rawContent>。
 * 文件不存在或不可读则静默跳过;符号链接跳过(与 auditConfigFiles 保持一致)。
 * 供 settings 漂移检测(fingerprintSettingsFilesFromRaw)使用。
 */
export async function readSettingsConfigsRaw(home: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  for (const descriptor of KNOWN_CONFIGS) {
    if (descriptor.kind !== 'settings') continue;
    const absPath = join(home, descriptor.relPath);
    try {
      const st = await lstat(absPath);
      if (st.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    try {
      const content = await readFile(absPath, 'utf8');
      result.set(descriptor.relPath, content);
    } catch {
      // 不可读 — 跳过
    }
  }

  return result;
}
