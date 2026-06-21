// Config-file discovery and auditing for the `audit --configs` path.
// Pure read: discovers known agent config files under a home root,
// reads each one, runs the appropriate detection module, and returns findings
// grouped by file path.
//
// Currently covers:
//   - <home>/.claude/settings.json   → auditSettingsJson
//   - <home>/.claude/settings.local.json → auditSettingsJson
//   - <home>/.claude/claude_desktop_config.json → auditMcpConfig
//   - <home>/.claude/mcp.json        → auditMcpConfig
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
  // Claude Code user settings
  { relPath: '.claude/settings.json', kind: 'settings' },
  { relPath: '.claude/settings.local.json', kind: 'settings' },
  // Claude Desktop MCP config (also consumed by Claude Code)
  { relPath: '.claude/claude_desktop_config.json', kind: 'mcp' },
  // MCP config used by some setups
  { relPath: '.claude/mcp.json', kind: 'mcp' },
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
