// R19-a: mcp/credential-path-access — MCP server configured with access to
// sensitive credential file paths.  Severity: medium.
//
// Threat: filesystem-style MCP servers that point at ~/.ssh, ~/.aws, ~/.gnupg,
// .netrc, ~/.config/gh, ~/.docker/config.json, ~/.kube/config, or ~/.npmrc give
// the AI agent silent read access to those credential directories, enabling
// credential harvesting (AppSecSanta 2026 MCP audit).
//
// All tests use synthetic fixture JSON — never read real ~/.ssh etc.
import { describe, expect, it } from 'vitest';
import { auditMcpConfig } from '../src/core/audit/mcp-audit.ts';

const RULE_ID = 'mcp/credential-path-access';

function json(mcpServers: Record<string, unknown>): string {
  return JSON.stringify({ mcpServers });
}

function credHits(findings: ReturnType<typeof auditMcpConfig>) {
  return findings.filter((f) => f.ruleId === RULE_ID);
}

// ──────────────────────────────────────────────────────────────────────────────
// MALICIOUS — must fire with severity medium
// ──────────────────────────────────────────────────────────────────────────────

describe('R19-a credential-path-access: malicious cases (must hit)', () => {
  it('filesystem server arg ~/.ssh → medium mcp/credential-path-access', () => {
    const findings = auditMcpConfig(
      json({
        fs: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '~/.ssh'],
        },
      }),
    );
    const hits = credHits(findings);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.severity).toBe('medium');
    expect(hits[0]!.message).toContain('.ssh');
  });

  it('absolute path /Users/alice/.aws/credentials in args → hit', () => {
    const findings = auditMcpConfig(
      json({
        evil: {
          command: 'node',
          args: ['server.js', '/Users/alice/.aws/credentials'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(1);
    expect(credHits(findings)[0]!.severity).toBe('medium');
  });

  it('~/.aws in a single arg → hit', () => {
    const findings = auditMcpConfig(
      json({
        evil: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '~/.aws'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(1);
  });

  it('~/.gnupg in args → hit', () => {
    const findings = auditMcpConfig(
      json({
        evil: {
          command: 'node',
          args: ['./server.js', '~/.gnupg'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(1);
  });

  it('.netrc in args → hit', () => {
    const findings = auditMcpConfig(
      json({
        evil: {
          command: 'node',
          args: ['./server.js', '/home/user/.netrc'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(1);
  });

  it('~/.config/gh in args → hit', () => {
    const findings = auditMcpConfig(
      json({
        evil: {
          command: 'node',
          args: ['./server.js', '~/.config/gh'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(1);
  });

  it('~/.docker/config.json in args → hit', () => {
    const findings = auditMcpConfig(
      json({
        evil: {
          command: 'node',
          args: ['./server.js', '~/.docker/config.json'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(1);
  });

  it('~/.kube/config in args → hit', () => {
    const findings = auditMcpConfig(
      json({
        evil: {
          command: 'node',
          args: ['./server.js', '~/.kube/config'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(1);
  });

  it('~/.npmrc in args → hit', () => {
    const findings = auditMcpConfig(
      json({
        evil: {
          command: 'node',
          args: ['./server.js', '~/.npmrc'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(1);
  });

  it('id_rsa path in args → hit', () => {
    const findings = auditMcpConfig(
      json({
        evil: {
          command: 'node',
          args: ['./server.js', '/home/user/.ssh/id_rsa'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(1);
  });

  it('id_ed25519 path in args → hit', () => {
    const findings = auditMcpConfig(
      json({
        evil: {
          command: 'node',
          args: ['./server.js', '/root/.ssh/id_ed25519'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(1);
  });

  it('authorized_keys in args → hit', () => {
    const findings = auditMcpConfig(
      json({
        evil: {
          command: 'node',
          args: ['./server.js', '/home/user/.ssh/authorized_keys'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(1);
  });

  it('credential path in env VALUE (not key name) → hit', () => {
    const findings = auditMcpConfig(
      json({
        evil: {
          command: 'node',
          args: ['./server.js'],
          env: { FS_ROOT: '~/.gnupg' },
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(1);
  });

  it('credential path in command itself → hit', () => {
    const findings = auditMcpConfig(
      json({
        evil: {
          command: '/home/user/.ssh/id_rsa',
          args: [],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(1);
  });

  it('case-insensitive: ~/.SSH in args → hit', () => {
    const findings = auditMcpConfig(
      json({
        evil: {
          command: 'node',
          args: ['./server.js', '~/.SSH'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// BENIGN — must NOT fire mcp/credential-path-access
// ──────────────────────────────────────────────────────────────────────────────

describe('R19-a credential-path-access: benign cases (must NOT hit)', () => {
  it('filesystem server pointed at /Users/x/projects → zero findings', () => {
    const findings = auditMcpConfig(
      json({
        fs: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/x/projects'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(0);
  });

  it('filesystem server pointed at ~/code → zero findings', () => {
    const findings = auditMcpConfig(
      json({
        fs: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '~/code'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(0);
  });

  it('server with no path args → zero findings', () => {
    const findings = auditMcpConfig(
      json({
        srv: {
          command: 'node',
          args: ['./server.js', '--port', '3000'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(0);
  });

  it('env var KEY name contains "ssh" but value is benign → zero findings', () => {
    // Key name "SSH_AUTH_SOCK" is not a path token — only values are scanned
    const findings = auditMcpConfig(
      json({
        srv: {
          command: 'node',
          args: ['./server.js'],
          env: { SSH_AUTH_SOCK: '/var/run/ssh-agent.sock' },
        },
      }),
    );
    // SSH_AUTH_SOCK value "/var/run/ssh-agent.sock" does NOT contain a credential
    // path segment (no /.ssh/, ~/.ssh, id_rsa, etc.) — only the key name has "ssh"
    expect(credHits(findings)).toHaveLength(0);
  });

  it('description prose mentioning "ssh" → zero findings', () => {
    // prose in a description field is NOT a command/arg/env value
    const findings = auditMcpConfig(
      json({
        srv: {
          command: 'node',
          args: ['./server.js'],
          description: 'This tool uses ssh to connect to remote servers.',
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(0);
  });

  it('package named containing "ssh" substring in args → zero findings', () => {
    // e.g. @modelcontextprotocol/server-ssh-helper — not a path to ~/.ssh
    const findings = auditMcpConfig(
      json({
        srv: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-ssh-helper@1.0.0'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(0);
  });

  it('normal home dir path (not a credential subdir) → zero findings', () => {
    const findings = auditMcpConfig(
      json({
        srv: {
          command: 'node',
          args: ['./server.js', '/Users/alice'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(0);
  });

  it('env value of $SSH_AUTH_SOCK variable reference → zero findings', () => {
    const findings = auditMcpConfig(
      json({
        srv: {
          command: 'node',
          args: ['./server.js'],
          env: { SOCK: `\${SSH_AUTH_SOCK}` },
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(0);
  });

  it('no env at all → zero findings', () => {
    const findings = auditMcpConfig(
      json({
        srv: { command: 'node', args: ['./server.js'] },
      }),
    );
    expect(credHits(findings)).toHaveLength(0);
  });

  it('~/.config/other (not gh) → zero findings', () => {
    // Only ~/.config/gh is flagged; other ~/.config subdirs are not
    const findings = auditMcpConfig(
      json({
        srv: {
          command: 'node',
          args: ['./server.js', '~/.config/nvim'],
        },
      }),
    );
    expect(credHits(findings)).toHaveLength(0);
  });
});
