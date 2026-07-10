import { describe, expect, it } from 'vitest';
import { formatAuditReport } from '../src/cli/commands/audit.ts';
import { runRules } from '../src/core/audit/engine.ts';
import { auditSettingsJson } from '../src/core/audit/settings-audit.ts';
import type { AuditFinding, AuditRule } from '../src/core/audit/types.ts';
import { describeServer, describeStdioCommand } from '../src/core/mcp-scan/client.ts';

function hasUnsafeControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x08 || code === 0x0b || code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
  });
}

describe('audit output redaction regression', () => {
  it('never returns a literal settings secret in a finding excerpt', () => {
    const secret = 'sk-live-THIS_MUST_NEVER_APPEAR_1234567890';
    const findings = auditSettingsJson(JSON.stringify({ env: { OPENAI_API_KEY: secret } }));
    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it('neutralizes terminal control bytes in generic rule excerpts', () => {
    const rules: AuditRule[] = [{
      id: 'test/curl', severity: 'high', pattern: /curl/, message: 'test', source: 'test',
    }];
    const line = '\u001b]52;c;YXR0YWNrZXI=\u0007 curl https://example.invalid';
    const findings = runRules(rules, [{ file: 'SKILL.md', content: line }]);
    expect(findings).toHaveLength(1);
    expect(hasUnsafeControlCharacter(findings[0]!.excerpt)).toBe(false);
    expect(findings[0]!.excerpt).not.toContain('\u001b');
  });

  it('defensively sanitizes findings at the human-output boundary', () => {
    const secret = 'ghp_THIS_MUST_NOT_REACH_CI_LOGS_1234567890';
    const finding: AuditFinding = {
      ruleId: 'test/output', severity: 'high', file: 'SKILL.md', line: 1,
      message: `found token ${secret}\u001b[2J`,
      excerpt: `token=${secret}\u001b]52;c;Y29weQ==\u0007`,
    };
    const output = formatAuditReport('/tmp/skill', {
      findings: [finding], score: 90, verdict: 'SAFE',
    });
    expect(output).not.toContain(secret);
    expect(hasUnsafeControlCharacter(output)).toBe(false);
    expect(output).not.toContain('\u001b');
  });
});

describe('MCP connection-description redaction regression', () => {
  it('redacts credential flag values and terminal controls from stdio argv', () => {
    const secretA = 'stdio-secret-token-A';
    const secretB = 'stdio-secret-token-B';
    const description = describeStdioCommand({
      name: 'x', source: '.claude/mcp.json', transport: 'stdio', command: 'node',
      args: ['server.js', '--token', secretA, `--api-key=${secretB}`, '\u001b[2J'],
    });
    expect(description).not.toContain(secretA);
    expect(description).not.toContain(secretB);
    expect(hasUnsafeControlCharacter(description)).toBe(false);
    expect(description).not.toContain('\u001b');
  });

  it('redacts URL userinfo from HTTP server descriptions', () => {
    const password = 'url-password-MUST-NOT-LEAK';
    const description = describeServer({
      name: 'x', source: '.claude/mcp.json', transport: 'http',
      url: `https://audit-user:${password}@mcp.example.com/v1`,
    });
    expect(description).not.toContain(password);
    expect(description).not.toContain('audit-user');
  });
});
