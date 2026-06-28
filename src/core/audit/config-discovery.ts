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
//   Claude Desktop (macOS/Linux/Windows) — v0.8-D3 新增,用 os.homedir() 规避空格路径
//   - macOS: ~/Library/Application Support/Claude/claude_desktop_config.json → auditMcpConfig
//   - Linux: ~/.config/Claude/claude_desktop_config.json → auditMcpConfig
//   - Windows: %APPDATA%\Claude\claude_desktop_config.json → auditMcpConfig
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
//
// All reads silently skip missing files (they may not exist on every system).

import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { auditMcpConfig, extractMcpServerNames } from './mcp-audit.ts';
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

// ── Claude Desktop 平台特定配置路径 ──────────────────────────────────────────
//
// Claude Desktop 的配置位于含空格的路径下,不能用简单字符串拼接(KNOWN_CONFIGS 是
// home-relative,join(home, relPath) 在多数操作系统上正常,但 "Library/Application Support/..."
// 本身含空格,实际上 path.join 完全支持含空格路径——之前跳过的原因是"非简单 home 相对路径"
// 的文档表述。这里改为用 homedir() 生成绝对路径并包装成统一描述符。
//
// 平台判断:
//   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
//   Linux:   ~/.config/Claude/claude_desktop_config.json
//   Windows: %APPDATA%\Claude\claude_desktop_config.json
//            (process.env.APPDATA fallback to home\AppData\Roaming)
//
// relPath 字段用于展示,absPath 字段覆盖实际读取路径。

interface KnownConfigFileAbsolute {
  /** 实际绝对路径(不经 home 拼接)。 */
  absPath: string;
  /** Display path shown in findings. */
  relPath: string;
  kind: ConfigKind;
}

/**
 * 计算 Claude Desktop 配置文件的平台绑定绝对路径。
 * 不访问文件系统,纯路径计算。
 *
 * @param systemHome - 传入的 home 目录参数(用于 Linux 路径;macOS/Win 直接用 os.homedir())
 * @returns 该平台上 Claude Desktop 配置文件的绝对路径,以及展示用 relPath
 */
function claudeDesktopConfigPath(systemHome: string): { absPath: string; relPath: string } | null {
  const platform = process.platform;
  if (platform === 'darwin') {
    // macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
    // 用 homedir() 而非传入的 systemHome,确保真实路径(测试时传入 home 会被覆盖,
    // 但测试 fixture 用 absPath 覆盖,见 buildDeepConfigs)。
    const absPath = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    return { absPath, relPath: 'Library/Application Support/Claude/claude_desktop_config.json' };
  }
  if (platform === 'win32') {
    // Windows: %APPDATA%\Claude\claude_desktop_config.json
    const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
    return {
      absPath: join(appData, 'Claude', 'claude_desktop_config.json'),
      relPath: 'AppData/Roaming/Claude/claude_desktop_config.json',
    };
  }
  // Linux / 其他 Unix:~/.config/Claude/claude_desktop_config.json
  return {
    absPath: join(systemHome, '.config', 'Claude', 'claude_desktop_config.json'),
    relPath: '.config/Claude/claude_desktop_config.json',
  };
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
 *
 * v0.8-D3 新增:
 *   1. Claude Desktop 平台绑定路径纳入扫描(用 os.homedir() 规避含空格路径的历史问题)。
 *   2. 全量扫描完成后进行跨 server 名冲突检测(mcp/tool-name-collision):
 *      同名 MCP server 在多个配置文件中注册 → 后注册者会影子化(shadow)先注册者。
 */
export async function auditConfigFiles(home: string): Promise<ConfigFileResult[]> {
  const results: ConfigFileResult[] = [];

  // 跨 server 名冲突检测所需的 side-channel:记录每个 server 名首次出现的文件
  // key = server 名, value = relPath(首次出现的文件)
  const serverNameToFirstFile = new Map<string, string>();

  /**
   * 处理单个配置文件:读取 → 审计 → 收集 server 名(MCP 文件)→ 追加结果。
   * 内联到主循环以避免二次读文件。
   */
  async function processFile(absPath: string, relPath: string, kind: ConfigKind): Promise<void> {
    // Guard: 不追踪符号链接
    try {
      const st = await lstat(absPath);
      if (st.isSymbolicLink()) return;
    } catch {
      // 路径不存在 — 静默跳过
      return;
    }

    let content: string;
    try {
      content = await readFile(absPath, 'utf8');
    } catch {
      // 不可读 — 静默跳过
      return;
    }

    const baseFindings = kind === 'settings'
      ? auditSettingsJson(content)
      : auditMcpConfig(content);

    // 修正 file 字段以展示 home 相对路径
    const annotated = baseFindings.map((f) => ({ ...f, file: relPath }));
    const result: ConfigFileResult = { absPath, relPath, findings: annotated };
    results.push(result);

    // ── 跨 server 名冲突检测:收集本文件的 server 名 ──────────────────────
    if (kind === 'mcp') {
      const serverNames = extractMcpServerNames(content);
      for (const serverName of serverNames) {
        const firstFile = serverNameToFirstFile.get(serverName);
        if (firstFile === undefined) {
          // 首次出现:记录
          serverNameToFirstFile.set(serverName, relPath);
        } else {
          // 冲突:同名 server 在两个文件中都出现
          // finding 附加到"后入"文件(当前文件),因为后入者会影子化先入者
          result.findings.push({
            ruleId: 'mcp/tool-name-collision',
            severity: 'high',
            file: relPath,
            line: 1,
            excerpt: `[${serverName}] 也出现在 ${firstFile}`,
            message:
              `MCP server "${serverName}" 在多个配置文件中重复注册` +
              `(${firstFile} 与 ${relPath})` +
              ` — 后注册文件的 server 会影子化先注册者,攻击者可借此劫持工具调用(CSA 2025 最高危向量)`,
          });
        }
      }
    }
  }

  // ── 1. 扫描 KNOWN_CONFIGS(home 相对路径列表) ────────────────────────────
  for (const descriptor of KNOWN_CONFIGS) {
    const absPath = join(home, descriptor.relPath);
    await processFile(absPath, descriptor.relPath, descriptor.kind);
  }

  // ── 2. Claude Desktop 平台绑定路径(含空格,用绝对路径处理) ───────────────
  // 用 claudeDesktopConfigPath(home) 计算平台绑定绝对路径;
  // 若与 KNOWN_CONFIGS 的某个路径完全重合则去重跳过。
  const cdConfig = claudeDesktopConfigPath(home);
  if (cdConfig) {
    const alreadyScanned = results.some((r) => r.absPath === cdConfig.absPath);
    if (!alreadyScanned) {
      await processFile(cdConfig.absPath, cdConfig.relPath, 'mcp');
    }
  }

  return results;
}

/**
 * 构造 Claude Desktop 配置文件的平台绑定绝对路径列表。
 * 在真实运行时使用 os.homedir();测试时通过 home 参数覆盖 Linux 路径。
 * 不访问文件系统(纯路径计算)。
 * 供测试直接调用以验证路径生成逻辑。
 */
export function buildClaudeDesktopPaths(home: string): KnownConfigFileAbsolute[] {
  const result = claudeDesktopConfigPath(home);
  if (!result) return [];
  return [{ ...result, kind: 'mcp' }];
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

  // 构建待扫描列表:KNOWN_CONFIGS 中 kind=mcp 的 + Claude Desktop 平台绑定路径
  const mcpEntries: Array<{ absPath: string; relPath: string }> = [];
  for (const descriptor of KNOWN_CONFIGS) {
    if (descriptor.kind !== 'mcp') continue;
    mcpEntries.push({ absPath: join(home, descriptor.relPath), relPath: descriptor.relPath });
  }
  // Claude Desktop 平台绑定路径(v0.8-D3)
  const cdConfig = claudeDesktopConfigPath(home);
  if (cdConfig && !mcpEntries.some((e) => e.absPath === cdConfig.absPath)) {
    mcpEntries.push(cdConfig);
  }

  for (const { absPath, relPath } of mcpEntries) {
    try {
      const st = await lstat(absPath);
      if (st.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    try {
      const content = await readFile(absPath, 'utf8');
      result.set(relPath, content);
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
