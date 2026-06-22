// Detection-only module for dangerous content in .claude/settings.json-style agent configs.
// Reachable via `audit --configs` (wired through src/core/audit/config-discovery.ts).
// Usage: call auditSettingsJson(rawString) and inspect the returned AuditFinding[].

import type { AuditFinding, Severity } from './types.ts';

// ─── internal helper ───────────────────────────────────────────────────────

const EXCERPT_LIMIT = 200;

function makeExcerpt(value: unknown): string {
  const raw = JSON.stringify(value) ?? String(value);
  return raw.length > EXCERPT_LIMIT ? `${raw.slice(0, EXCERPT_LIMIT)}…` : raw;
}

function finding(
  ruleId: string,
  severity: Severity,
  message: string,
  line: number,
  excerpt: string,
): AuditFinding {
  return { ruleId, severity, file: '.claude/settings.json', line, message, excerpt };
}

// ─── danger patterns ───────────────────────────────────────────────────────

/** Shell command patterns that indicate a reverse shell or data exfiltration. */
const HOOK_COMMAND_DANGERS: Array<{ id: string; pattern: RegExp; message: string }> = [
  {
    id: 'settings/hook-reverse-shell-dev-tcp',
    pattern: /\/dev\/tcp\//,
    message: 'Hook command contains a /dev/tcp/ reverse-shell pattern',
  },
  {
    id: 'settings/hook-curl-pipe-sh',
    pattern: /curl[^|\n]*\|\s*(?:ba)?sh/,
    message: 'Hook command downloads and pipes a remote script to a shell (curl | sh)',
  },
  {
    id: 'settings/hook-wget-pipe-sh',
    pattern: /wget[^|\n]*\|\s*(?:ba)?sh/,
    message: 'Hook command downloads and pipes a remote script to a shell (wget | sh)',
  },
  {
    id: 'settings/hook-exfiltration-curl-body',
    pattern: /curl[^"'\n]*-[dF-][^"'\n]*(http|https):\/\//i,
    message: 'Hook command sends data to a remote URL with curl (possible exfiltration)',
  },
  {
    id: 'settings/hook-rm-rf-root',
    pattern: /rm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(\/|~\/?\s*$)/,
    message: 'Hook command contains rm -rf / or rm -rf ~ (destructive wipe)',
  },
  {
    id: 'settings/hook-mkfs',
    pattern: /mkfs\b|dd\s+.*of=\/dev\/(sd|nvme|hd)/,
    message: 'Hook command contains disk-overwrite operations (mkfs/dd to block device)',
  },
  {
    id: 'settings/hook-netcat-exec',
    pattern: /\bnc\b.*-e\s+|ncat\b.*--exec|netcat\b.*-e\s+/,
    message: 'Hook command uses netcat with -e (reverse-shell exec)',
  },
  {
    id: 'settings/hook-python-socket-reverse',
    pattern: /import\s+socket.*exec|socket\.connect\s*\(/,
    message: 'Hook command contains a Python socket-based reverse shell',
  },
];

/** Permissions that are considered overly broad when used literally. */
const BROAD_PERMISSION_PATTERNS: Array<{ id: string; pattern: RegExp; message: string }> = [
  {
    id: 'settings/permission-wildcard-star',
    pattern: /^\*$/,
    message: 'Permission entry is a bare wildcard (*) — allows any tool or command',
  },
  {
    id: 'settings/permission-bash-wildcard',
    pattern: /^Bash\(\*\)$/,
    message: 'Permission "Bash(*)" grants unrestricted shell execution',
  },
  {
    // Write(/**), Write(/*), Write(~/**), Write(~/*)  — root or home-root write grants
    // Matches: Write( followed by / or ~/ then optional globs or path segments then )
    // Does NOT match: Write(src/**), Write(./dist/*), Write(/usr/local/bin/mytool)
    // Precision note: we require the path to be exactly / or ~/ (optionally followed by
    // ** or * globs) so that specific absolute paths like /usr/local/bin/foo are NOT flagged.
    id: 'settings/permission-write-root',
    pattern: /^Write\(\s*(?:~\/?\*\*?|\/\*\*?|~\/|\/)\s*\)$/,
    message:
      'Permission grants Write access to the filesystem root or home root — any file on the system can be overwritten',
  },
  {
    // Read(/**), Read(/*), Read(~/**), Read(~/*) — root or home-root read grants
    id: 'settings/permission-read-root',
    pattern: /^Read\(\s*(?:~\/?\*\*?|\/\*\*?|~\/|\/)\s*\)$/,
    message:
      'Permission grants Read access to the filesystem root or home root — any file on the system can be read',
  },
];

/** Secret-looking literal values. Uses conservative patterns to avoid false positives. */
const SECRET_PATTERNS: Array<{ id: string; pattern: RegExp; message: string }> = [
  {
    id: 'settings/literal-openai-key',
    pattern: /\bsk-[A-Za-z0-9]{20,}/,
    message: 'Possible OpenAI/Anthropic API key literal embedded in settings',
  },
  {
    id: 'settings/literal-github-pat',
    pattern: /\bghp_[A-Za-z0-9]{36,}/,
    message: 'Possible GitHub personal-access token literal embedded in settings',
  },
  {
    id: 'settings/literal-aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16,}/,
    message: 'Possible AWS access key ID literal embedded in settings',
  },
  // H1 修复:不再用无锚点的「40 字符 base64/alphanum」规则匹配 AWS secret——它会把
  // git commit SHA(正好 40 位)、内容摘要、构建 ID 等 settings 里常见的 40 字符值误判为
  // 密钥并以 high 拦下 `audit --configs`。真正的 secret 几乎总在 *_SECRET/_KEY/_TOKEN 等
  // 命名字段里,已由下方基于 key 名的 settings/env-secret-literal 覆盖;裸 40 字符串与
  // git SHA 无法区分,不应误报。
];

/** Key suffixes that, when their value is a non-empty non-env literal string, look like embedded secrets. */
const SECRET_KEY_SUFFIXES = ['_TOKEN', '_SECRET', '_KEY', '_PASSWORD', '_PASS'];

// ─── JSON structure walkers ────────────────────────────────────────────────

/**
 * Walk the hooks section of a parsed settings object.
 * settings.hooks is typically: Record<eventName, Array<{ command: string; ... }>>
 * or a flat object with command strings.
 */
function auditHooks(hooks: unknown, findings: AuditFinding[]): void {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return;

  for (const [_event, hookList] of Object.entries(hooks as Record<string, unknown>)) {
    const items = Array.isArray(hookList) ? hookList : [hookList];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;

      // Support both { command: string } and { commands: string[] } shapes
      const commands: string[] = [];
      if (typeof record.command === 'string') commands.push(record.command);
      if (Array.isArray(record.commands)) {
        for (const c of record.commands) {
          if (typeof c === 'string') commands.push(c);
        }
      }

      for (const cmd of commands) {
        for (const rule of HOOK_COMMAND_DANGERS) {
          if (rule.pattern.test(cmd)) {
            findings.push(
              finding(rule.id, 'critical', rule.message, 0, makeExcerpt(cmd)),
            );
          }
        }
      }
    }
  }
}

/**
 * Walk the permissions section (allow/deny lists).
 * Typical shape: { allow: string[], deny: string[] }
 */
function auditPermissions(permissions: unknown, findings: AuditFinding[]): void {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return;

  const record = permissions as Record<string, unknown>;
  const lists = [record.allow, record.deny].filter(Boolean);

  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== 'string') continue;
      for (const rule of BROAD_PERMISSION_PATTERNS) {
        if (rule.pattern.test(entry.trim())) {
          findings.push(
            finding(rule.id, 'high', rule.message, 0, makeExcerpt(entry)),
          );
        }
      }
    }
  }
}

/**
 * Check for settings that disable the human-in-the-loop confirmation step.
 *
 * Several Claude/agent config keys can silently suppress permission prompts or
 * auto-approve every tool call without user interaction:
 *   - dangerouslySkipPermissions: true   (Claude Code CLI flag surfaced in settings)
 *   - autoApprove: true                  (generic auto-approval toggle)
 *   - confirmations: "never" | false     (confirmation policy set to never ask)
 *
 * These are high-severity because a compromised / injected config can silently
 * elevate agent privileges and remove the last human gate before destructive actions.
 *
 * Precision notes:
 *   - We only flag boolean `true` or the string `"never"` / `"none"` / `"off"` for
 *     the confirmation key — `"always"`, `"ask"`, `"prompt"` etc. are fine.
 *   - Nested occurrences (e.g. under a profile key) are also flagged.
 *   - `autoApprove: false` or absent is not flagged.
 */

/** Keys whose truthy value indicates auto-approval / skip-confirmation semantics. */
const AUTO_APPROVE_BOOL_KEYS: ReadonlySet<string> = new Set([
  'dangerouslySkipPermissions',
  'autoApprove',
  'skipPermissions',
]);

/** Keys whose value can be a string selecting confirmation policy; flagged when set to a never-confirm value. */
const CONFIRMATION_POLICY_KEYS: ReadonlySet<string> = new Set([
  'confirmations',
  'confirmationPolicy',
  'approval',
  'approvalMode',
]);

/** String values for a confirmation policy key that mean "never confirm". */
const CONFIRMATION_NEVER_VALUES: ReadonlySet<string> = new Set(['never', 'none', 'off', 'disable', 'disabled', 'skip']);

/** Check a single key-value pair for boolean auto-approve semantics. */
function checkBoolAutoApproveKey(key: string, value: unknown, findings: AuditFinding[]): void {
  if (AUTO_APPROVE_BOOL_KEYS.has(key) && value === true) {
    findings.push(
      finding(
        'settings/auto-approve-enabled',
        'high',
        `Setting "${key}: true" disables human-in-the-loop confirmation — tool calls proceed without approval`,
        0,
        makeExcerpt({ [key]: value }),
      ),
    );
  }
}

/** Check a single key-value pair for a "never confirm" confirmation-policy value. */
function checkConfirmationPolicyKey(key: string, value: unknown, findings: AuditFinding[]): void {
  if (!CONFIRMATION_POLICY_KEYS.has(key)) return;
  const isNeverBool = value === false;
  const isNeverStr = typeof value === 'string' && CONFIRMATION_NEVER_VALUES.has(value.toLowerCase());
  if (isNeverBool || isNeverStr) {
    findings.push(
      finding(
        'settings/auto-approve-enabled',
        'high',
        `Setting "${key}: ${JSON.stringify(value)}" disables permission prompts — agent will never ask for confirmation`,
        0,
        makeExcerpt({ [key]: value }),
      ),
    );
  }
}

function auditAutoApproveInObject(obj: unknown, findings: AuditFinding[]): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    checkBoolAutoApproveKey(key, value, findings);
    checkConfirmationPolicyKey(key, value, findings);
    // Recurse into nested objects
    if (value && typeof value === 'object') {
      auditAutoApproveInObject(value, findings);
    }
  }
}

/** Check whether a string looks like an env var reference rather than a literal. */
function isEnvReference(value: string): boolean {
  // Patterns like ${MY_VAR}, $MY_VAR, %MY_VAR%
  return /^\$\{[^}]+\}$/.test(value) || /^\$[A-Z_][A-Z0-9_]*$/.test(value) || /^%[A-Z_][A-Z0-9_]+%$/.test(value);
}

/**
 * Recursively walk any object for keys whose names look like secret fields
 * and whose values are suspicious literal strings.
 */
function auditSecretsInObject(obj: unknown, findings: AuditFinding[]): void {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) auditSecretsInObject(item, findings);
    return;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) {
      // 1. Pattern-based detection: value looks like a known token format (most specific).
      //    Run this first so we can suppress the generic key-based finding when it matches,
      //    preventing duplicate findings for the same value+location.
      let patternMatched = false;
      if (!isEnvReference(value)) {
        for (const rule of SECRET_PATTERNS) {
          if (rule.pattern.test(value)) {
            findings.push(
              finding(rule.id, 'high', rule.message, 0, makeExcerpt(value)),
            );
            patternMatched = true;
          }
        }
      }

      // 2. Key-based detection: key ends with a secret-looking suffix.
      //    Only emit if no pattern-based rule already matched this value — deduplicates
      //    cases like OPENAI_KEY: "sk-XXXX" that would otherwise produce two findings.
      if (!patternMatched) {
        const upperKey = key.toUpperCase();
        const keyLooksLikeSecret = SECRET_KEY_SUFFIXES.some((s) => upperKey.endsWith(s));
        if (keyLooksLikeSecret && !isEnvReference(value)) {
          findings.push(
            finding(
              'settings/env-secret-literal',
              'high',
              `Config key "${key}" contains what appears to be a literal secret (not an env reference)`,
              0,
              makeExcerpt(value),
            ),
          );
        }
      }
    }
    // Recurse into nested objects
    if (value && typeof value === 'object') {
      auditSecretsInObject(value, findings);
    }
  }
}

// ─── public API ────────────────────────────────────────────────────────────

/**
 * Audit the raw string content of a `.claude/settings.json`-style agent config file.
 *
 * Returns an array of `AuditFinding` objects — one per detected issue.
 * Returns an empty array for clean configs (zero false positives is the design goal).
 * Never throws: invalid JSON yields a single low-severity "unparseable" finding.
 *
 * Detected dangers:
 *   - Hook commands containing reverse-shell / curl-pipe-sh / rm -rf / or exfiltration patterns → critical
 *   - Overly broad permissions ("*", "Bash(*)") → high
 *   - Literal secrets embedded in values (known API key formats, *_TOKEN/*_SECRET keys) → high
 *
 * Reachable via `audit --configs` (wired through config-discovery.ts).
 */
export function auditSettingsJson(content: string): AuditFinding[] {
  // ── 1. Parse defensively ──────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [
      finding(
        'settings/unparseable',
        'low',
        'The settings file could not be parsed as JSON — it may be malformed or empty',
        0,
        content.length > EXCERPT_LIMIT ? `${content.slice(0, EXCERPT_LIMIT)}…` : content,
      ),
    ];
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }

  const settings = parsed as Record<string, unknown>;
  const findings: AuditFinding[] = [];

  // ── 2. Hook commands ──────────────────────────────────────────────────────
  if ('hooks' in settings) {
    auditHooks(settings.hooks, findings);
  }

  // ── 3. Permissions ────────────────────────────────────────────────────────
  if ('permissions' in settings) {
    auditPermissions(settings.permissions, findings);
  }

  // ── 4. Auto-approve / disabled confirmation settings ─────────────────────
  auditAutoApproveInObject(settings, findings);

  // ── 5. Literal secrets anywhere in the config ─────────────────────────────
  auditSecretsInObject(settings, findings);

  return findings;
}
