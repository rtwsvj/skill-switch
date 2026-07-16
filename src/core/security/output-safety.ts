// Central output-safety helpers.
//
// These functions are intentionally pure and dependency-free so every transport
// (CLI, MCP, JSON/JUnit/SARIF formatters, and diagnostic messages) can apply the
// same last-mile protections before untrusted text reaches a terminal or log.

/** Stable replacement used for values that must never reach diagnostics. */
export const REDACTED_VALUE = '<redacted>';

const CONTROL_NAMES: Readonly<Record<number, string>> = {
  0: 'NUL',
  7: 'BEL',
  8: 'BS',
  9: 'TAB',
  10: 'LF',
  11: 'VT',
  12: 'FF',
  13: 'CR',
  27: 'ESC',
  127: 'DEL',
};

/**
 * Render C0, DEL, and C1 control bytes as inert visible text.
 *
 * Replacing ESC also neutralizes CSI/OSC/DCS sequences; replacing BEL/ST
 * prevents an OSC payload from regaining a working terminator. Newlines and
 * carriage returns are rendered too, so attacker-controlled messages cannot
 * forge extra log lines.
 */
export function neutralizeTerminalControls(value: string): string {
  let output = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      const label = CONTROL_NAMES[codePoint] ?? `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
      output += `<${label}>`;
    } else {
      output += character;
    }
  }
  return output;
}

/** Remove both username and password from an absolute URL without exposing either. */
export function redactUrlUserinfo(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.username && !parsed.password) return rawUrl;

    // Modify a parsed copy rather than using a credential-matching regexp. This
    // correctly handles percent-encoded credentials and IPv6 authorities.
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Diagnostic callers may receive malformed URLs. Keep the fallback narrow:
    // only remove a userinfo-shaped authority prefix.
    return rawUrl.replace(
      /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/giu,
      '$1',
    );
  }
}

/**
 * Redact common credential formats and key/value representations in arbitrary
 * diagnostic text. This is a safety net, not a secret detector used for audit
 * decisions; false negatives must still be handled by context-specific callers
 * redacting an entire known-secret value.
 */
export function redactKnownSecrets(value: string): string {
  let output = value;

  // URL userinfo embedded in a longer message.
  output = output.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/giu,
    `$1${REDACTED_VALUE}@`,
  );

  const knownTokenPatterns: readonly RegExp[] = [
    /\bsk-(?:live-|test-|proj-)?[A-Za-z0-9_-]{16,}/gu,
    /\bgh[pousr]_[A-Za-z0-9_]{16,}/gu,
    /\bgithub_pat_[A-Za-z0-9_]{16,}/gu,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/gu,
    /\bnpm_[A-Za-z0-9]{16,}/gu,
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/gu,
    /\bBearer\s+[^\s,;"']+/giu,
  ];
  for (const pattern of knownTokenPatterns) {
    output = output.replace(pattern, REDACTED_VALUE);
  }

  // JSON and shell-style assignments whose key explicitly denotes a secret.
  // The value is bounded by the surrounding quote or a conservative delimiter.
  output = output.replace(
    /((?:["']?)[A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*(?:["']?)\s*:\s*)(["'])(.*?)(\2)/giu,
    `$1$2${REDACTED_VALUE}$2`,
  );
  output = output.replace(
    /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|auth|password|passwd|pwd|secret|client[_-]?secret|private[_-]?key)\b\s*=\s*)([^\s,;}]*)/giu,
    `$1${REDACTED_VALUE}`,
  );

  return output;
}

/** Redact known secrets, then make every terminal control byte inert. */
export function sanitizeOutputText(value: string): string {
  return neutralizeTerminalControls(redactKnownSecrets(value));
}

const SENSITIVE_VALUE_FLAGS = new Set([
  '--access-token',
  '--api-key',
  '--apikey',
  '--auth',
  '--authorization',
  '--client-secret',
  '--cookie',
  '--password',
  '--passwd',
  '--private-key',
  '--proxy-authorization',
  '--proxy-user',
  '--refresh-token',
  '--secret',
  '--token',
  '--user',
  '-u',
]);

const HEADER_FLAGS = new Set(['--header']);

function redactHeaderArgument(value: string): string {
  const separator = value.indexOf(':');
  if (separator === -1) return sanitizeOutputText(value);
  const name = value.slice(0, separator).trim();
  if (!isSensitiveHeaderName(name)) return sanitizeOutputText(value);
  return `${sanitizeOutputText(name)}: ${REDACTED_VALUE}`;
}

/** Header names whose values must not cross an origin or reach diagnostics. */
export function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'authorization' ||
    normalized === 'proxy-authorization' ||
    normalized === 'cookie' ||
    normalized === 'cookie2' ||
    normalized === 'x-api-key' ||
    normalized === 'api-key' ||
    normalized === 'x-auth-token';
}

/**
 * Return an argv copy that is safe for display. Sensitive flag values are
 * replaced contextually, including `--flag=value` and authorization headers.
 */
export function redactArgvForDisplay(args: readonly string[]): string[] {
  const output: string[] = [];
  let redactNextValue = false;
  let redactNextHeader = false;

  for (const rawArgument of args) {
    if (redactNextValue) {
      output.push(REDACTED_VALUE);
      redactNextValue = false;
      continue;
    }
    if (redactNextHeader) {
      output.push(redactHeaderArgument(rawArgument));
      redactNextHeader = false;
      continue;
    }

    const equals = rawArgument.indexOf('=');
    const rawFlag = equals === -1 ? rawArgument : rawArgument.slice(0, equals);
    const normalizedFlag = rawFlag.toLowerCase();
    if (SENSITIVE_VALUE_FLAGS.has(normalizedFlag)) {
      output.push(equals === -1
        ? sanitizeOutputText(rawFlag)
        : `${sanitizeOutputText(rawFlag)}=${REDACTED_VALUE}`);
      redactNextValue = equals === -1;
      continue;
    }
    if (HEADER_FLAGS.has(normalizedFlag) || rawFlag === '-H') {
      output.push(equals === -1
        ? sanitizeOutputText(rawFlag)
        : `${sanitizeOutputText(rawFlag)}=${redactHeaderArgument(rawArgument.slice(equals + 1))}`);
      redactNextHeader = equals === -1;
      continue;
    }

    output.push(sanitizeOutputText(rawArgument));
  }

  return output;
}

/** Quote already-redacted argv for a compact, unambiguous human description. */
export function formatArgvForDisplay(command: string, args: readonly string[]): string {
  const safe = [sanitizeOutputText(command), ...redactArgvForDisplay(args)];
  return safe.map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part)).join(' ');
}
