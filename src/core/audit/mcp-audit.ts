// MCP server configuration auditor — reachable via `audit --configs` (wired through config-discovery.ts).
// Pure function: never throws, never reads the filesystem, returns AuditFinding[] per hit.
// Spec: each finding carries ruleId / severity / file / line / excerpt / message.
import type { AuditFinding } from './types.ts';

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

const EXCERPT_LIMIT = 200;

function excerpt(text: string): string {
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text;
}

/** Build a finding from a (server-scoped) field path. */
function finding(
  ruleId: string,
  severity: AuditFinding['severity'],
  message: string,
  raw: string,
  line: number,
): AuditFinding {
  return {
    ruleId,
    severity,
    file: 'mcp-config.json',
    line,
    excerpt: excerpt(raw),
    message,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Danger patterns
// ──────────────────────────────────────────────────────────────────────────────

/** Shell wrappers that execute inline payload (sh -c "…", bash -c "…"). */
const SHELL_WRAPPER_CMD = /^(?:ba)?sh$/;

/** Risky inline commands carried as shell -c argument. */
const RISKY_INLINE: Array<{ re: RegExp; ruleId: string; message: string }> = [
  {
    re: /curl[^|]*\|\s*(?:ba)?sh/,
    ruleId: 'mcp/shell-wrapper-curl-pipe-sh',
    message: 'MCP server runs a remote script via curl | sh — arbitrary code execution risk',
  },
  {
    re: /\/dev\/tcp\//,
    ruleId: 'mcp/shell-wrapper-dev-tcp',
    message: 'MCP server uses /dev/tcp/ bash redirection — likely reverse-shell',
  },
  {
    re: /rm\s+-rf\s+\/(?:\s|$|[^a-zA-Z])/,
    ruleId: 'mcp/shell-wrapper-rm-rf-root',
    message: 'MCP server issues destructive rm -rf / command',
  },
  {
    re: /(?:nc|ncat|netcat)\s+.*-e\s+|bash\s+-i\s+|python[23]?\s+-c\s+["']?import\s+socket/,
    ruleId: 'mcp/shell-wrapper-reverse-shell',
    message: 'MCP server contains a reverse-shell pattern (netcat -e / bash -i / python socket)',
  },
];

/** curl fetching a URL and piping to shell — critical RCE regardless of command context. */
const CURL_PIPE_RE = /curl[^|]*\|\s*(?:ba)?sh/;

/** Unpinned package managers: npx/uvx/bunx with no @version suffix. */
// Matches: npx <pkg> or npx -y <pkg> where pkg has no @version
// Does NOT match: npx @scope/pkg@1.2.3  or  npx pkg@2.0.0
const UNPINNED_PKG_RE =
  /^(?:npx|uvx|bunx)(?:\s+-y)?\s+(?!.*@\d)(@?[a-zA-Z0-9_@/.-]+)(?:\s|$)/;

/** Literal secret patterns in env values. */
const SECRET_VALUE_PATTERNS: Array<{ re: RegExp; ruleId: string; message: string }> = [
  {
    re: /^sk-[A-Za-z0-9]{20,}$/,
    ruleId: 'mcp/env-literal-openai-key',
    message: 'MCP env contains a hardcoded OpenAI/Anthropic API key (sk-…)',
  },
  {
    re: /^ghp_[A-Za-z0-9]{10,}$/,
    ruleId: 'mcp/env-literal-github-token',
    message: 'MCP env contains a hardcoded GitHub personal access token (ghp_…)',
  },
  {
    re: /^AKIA[A-Z0-9]{16}$/,
    ruleId: 'mcp/env-literal-aws-key',
    message: 'MCP env contains a hardcoded AWS access key ID (AKIA…)',
  },
];

/** Key-name heuristic: env key ending in _TOKEN / _SECRET / _KEY / _PASSWORD with a literal value. */
const SECRET_KEY_SUFFIX_RE = /(?:_TOKEN|_SECRET|_KEY|_PASSWORD)$/i;

/** Value is a shell/env variable reference (not literal): ${VAR} or $VAR. */
const ENV_REF_RE = /^\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)$/;

// ──────────────────────────────────────────────────────────────────────────────
// MCP config shape (loose — we accept partial / malformed gracefully)
// ──────────────────────────────────────────────────────────────────────────────

interface McpServerEntry {
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Audit an MCP server config JSON string for dangerous patterns.
 * Never throws; invalid JSON yields a single low-severity finding.
 */
export function auditMcpConfig(content: string): AuditFinding[] {
  // ── 1. Parse ──────────────────────────────────────────────────────────────
  let config: McpConfig;
  try {
    config = JSON.parse(content) as McpConfig;
  } catch {
    return [
      finding(
        'mcp/invalid-json',
        'low',
        'MCP config is not valid JSON — cannot be parsed or audited',
        content.slice(0, 80),
        1,
      ),
    ];
  }

  const findings: AuditFinding[] = [];
  const servers = config.mcpServers ?? {};

  // ── 2. Per-server checks ──────────────────────────────────────────────────
  for (const [serverName, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object') continue;

    const command = typeof server.command === 'string' ? server.command : '';
    const args: string[] = Array.isArray(server.args)
      ? server.args.filter((a): a is string => typeof a === 'string')
      : [];
    const env =
      server.env && typeof server.env === 'object' && !Array.isArray(server.env)
        ? (server.env as Record<string, unknown>)
        : {};

    // Context label for excerpts
    const ctx = `[${serverName}]`;

    // ── 2a. Shell-wrapper with risky inline command ──────────────────────────
    if (SHELL_WRAPPER_CMD.test(command) && args.length >= 2 && args[0] === '-c') {
      const inline = args.slice(1).join(' ');
      for (const { re, ruleId, message } of RISKY_INLINE) {
        if (re.test(inline)) {
          findings.push(
            finding(ruleId, 'critical', message, `${ctx} ${command} -c "${inline}"`, 1),
          );
        }
      }
    }

    // ── 2b. curl | sh anywhere in the args (not just sh -c context) ─────────
    const fullArgLine = args.join(' ');
    if (!SHELL_WRAPPER_CMD.test(command) && CURL_PIPE_RE.test(fullArgLine)) {
      findings.push(
        finding(
          'mcp/curl-pipe-sh',
          'critical',
          'MCP server args contain curl | sh — remote script execution',
          `${ctx} ${command} ${fullArgLine}`,
          1,
        ),
      );
    }

    // ── 2c. Unpinned npx/uvx/bunx (supply-chain risk) ────────────────────────
    // The executable itself can be npx/uvx/bunx, or those can appear in args.
    const commandLine = [command, ...args].join(' ').trim();
    // Check if the primary command is npx/uvx/bunx with an unpinned package
    const pkgMatch = UNPINNED_PKG_RE.exec(commandLine);
    if (pkgMatch) {
      findings.push(
        finding(
          'mcp/unpinned-package',
          'medium',
          `MCP server uses unpinned package manager command — supply-chain risk (${pkgMatch[1]})`,
          `${ctx} ${commandLine}`,
          1,
        ),
      );
    }

    // ── 2d. Literal secrets in env ────────────────────────────────────────────
    for (const [key, val] of Object.entries(env)) {
      if (typeof val !== 'string') continue;
      // Skip variable references — not literal secrets
      if (ENV_REF_RE.test(val)) continue;

      // Check known secret patterns
      for (const { re, ruleId, message } of SECRET_VALUE_PATTERNS) {
        if (re.test(val)) {
          findings.push(
            finding(ruleId, 'high', message, `${ctx} env.${key}=<redacted>`, 1),
          );
        }
      }

      // Check key-name heuristic for non-empty, non-reference values
      if (SECRET_KEY_SUFFIX_RE.test(key) && val.length > 0) {
        findings.push(
          finding(
            'mcp/env-literal-secret-key',
            'high',
            `MCP env key "${key}" appears to hold a literal secret rather than a variable reference`,
            `${ctx} env.${key}=<redacted>`,
            1,
          ),
        );
      }
    }
  }

  return findings;
}
