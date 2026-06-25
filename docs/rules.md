# skill-switch 审计规则目录

skill-switch 的 `audit` 命令会对 AI agent skill 文件及 MCP/agent 配置文件逐条执行以下规则。每条规则有唯一的 **ruleId**（`类别/名称` 格式）、严重度，以及一句话说明它会拦什么。

**严重度含义：**

| 严重度 | 含义 |
|--------|------|
| `critical` | 几乎确认是攻击行为，必须阻断 |
| `high` | 高风险模式，默认阻断 CI |
| `medium` | 值得关注但可能有合法用途，告警 |
| `low` | 信息级，不阻断 |

**如何处理发现：**

- **`--fix --apply`**：对有自动修复器的规则（反弹 shell、curl|sh 等）注释化可疑命令行，并写 `.bak` 备份。
- **策略抑制**：在 `.skill-switch-policy.json` 的 `suppress[]` 里写入 ruleId，该条 finding 仍显示但不计入退出码（SARIF 标为 suppressed）。
- **基线化**：`--write-baseline <file>` 把现有 finding 存入基线；后续 `--baseline <file>` 只对新增 finding 失败，存量不再阻断 CI。

---

## 反弹 Shell（reverse-shell）

攻击者通过 skill 指令让宿主机向外发起 shell 连接，获得远程控制权。

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `reverse-shell/dev-tcp` | critical | bash `/dev/tcp/` 重定向——典型反弹 shell |
| `reverse-shell/netcat-exec` | critical | `nc -e /bin/bash` 或 `ncat -c`——netcat 反弹 shell |
| `reverse-shell/scripting-socket` | critical | Python/Perl/Ruby 内联 socket 反弹 shell |

---

## 远程下载执行（clickfix / staged）

诱导用户或 agent 从远端拉取并执行未经验证的代码。

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `clickfix/gatekeeper-bypass` | critical | `xattr -d com.apple.quarantine` / `spctl --master-disable`——绕过 macOS Gatekeeper |
| `clickfix/curl-pipe-shell` | critical | `curl … \| bash` 一行式安装——下载即执行远程脚本 |
| `clickfix/copy-paste-lure` | medium | 诱导"复制粘贴到终端"运行不可信命令（ClickFix 社工） |
| `staged/chained-download-exec` | high | 下载脚本 → `chmod +x` → 运行的分阶段执行链 |
| `staged/prerequisite-install` | medium | "先安装这个"前置步骤指向额外下载（分阶段投毒外壳） |

---

## 数据外传 / Exfiltration（exfiltration）

将敏感文件、密钥或环境变量发送到外部服务器。

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `exfiltration/curl-body-with-secret` | critical | `curl -d $TOKEN` / `-F $KEY`——把含密钥变量的请求体发往外部 |
| `exfiltration/sensitive-file-exfil` | critical | 同行同时出现私钥/凭据库路径与外传命令（`curl`、`scp` 等） |
| `exfiltration/exfil-endpoint` | high | 向已知外渗端点（`webhook.site`、`requestbin.com`、`ngrok.io` 等）发送数据 |
| `exfiltration/env-var-exfil-instruction` | high | 指令要求将环境变量/密钥/凭据外传至外部 URL（MCP 工具描述注入常见模式） |
| `exfiltration/sensitive-path-reference` | low | 提到私钥/凭据库/钱包/浏览器登录数据等敏感路径（确认未外传） |
| `exfiltration/staged-read-exfil` | high | 跨行：一行读取高置信敏感路径，另一行执行外传动作 |

---

## 凭据窃取（credential-theft）

钓鱼索要凭据、读取本机凭据库或把 token 发往收集端点。

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `credential-theft/phishing-request` | high | 钓鱼式索要用户密码/API key/secret/token |
| `credential-theft/credential-store-read` | high | 读取本机钥匙串、CLI token 文件（`~/.config/gh`、`~/.docker/config.json` 等） |
| `credential-theft/token-exfil` | high | 把 `GITHUB_TOKEN`、`API_TOKEN` 等认证 token 发往外部收集端点 |

---

## 供应链攻击（supply-chain）

仿名包、不可信 registry 或从短链/Gist 直接安装依赖。

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `supply-chain/typosquat-package` | medium | 安装疑似仿名/错拼的依赖包（`python-requests`、`djanga` 等） |
| `supply-chain/untrusted-install-source` | medium | 从 `http://`、短链、`raw.githubusercontent.com`、`gist` 等不可信 URL 安装依赖 |
| `supply-chain/unofficial-registry` | medium | 安装命令的 `--registry`/`--index-url` 指向明文 HTTP、原始 IP、保留 TLD 或已知短链域名 |

---

## 持久化机制（persistence）

在系统中植入开机自启、计划任务或 git hook 等持久化后门。

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `persistence/cron` | high | 修改 `crontab` 或写系统 cron 目录——计划任务持久化 |
| `persistence/shell-startup` | high | 写入 `.bashrc`/`.zshrc`/`.profile` 等 shell 启动文件——登录持久化 |
| `persistence/service-autostart` | high | `launchctl load` 或 `systemctl enable`——注册开机自启服务 |
| `persistence/git-hooks` | high | 写入 `.git/hooks/`——git 操作触发的持久化后门 |

---

## 全局 Agent 配置篡改（global-tamper）

篡改 AI agent 自身配置文件，注入后门指令或静默扩权。

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `global-tamper/agent-config-write` | critical | 写入/覆盖 `settings.json`/`CLAUDE.md`/`AGENTS.md`/`config.toml`——篡改 agent 自身行为 |
| `global-tamper/permission-grant` | critical | 在 agent settings 中注入通配放行规则（`Bash(*)`/`"*"`/`allowAll`）——静默扩权 |

---

## 破坏性命令（destructive）

删除文件系统、格式化磁盘或 fork bomb 等毁灭性操作。

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `destructive/rm-rf-root` | critical | `rm -rf /`、`rm -rf ~`、`rm -rf *`——破坏性删除根/家目录或通配 |
| `destructive/disk-overwrite` | critical | `dd if=/dev/zero` 或 `mkfs.*`——覆写磁盘/格式化文件系统 |
| `destructive/fork-bomb` | critical | `:(){ :\|:& };:` fork bomb——耗尽进程资源 |
| `destructive/chmod-777-root` | high | `chmod 777 /`——破坏全系统权限 |

---

## 混淆载荷（obfuscation）

Base64 编码的危险命令、Trojan-Source 不可见字符、ANSI 终端注入等混淆手段。

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `obfuscation/base64-encoded-payload` | critical | `base64 -d \| sh` 且解码内容含危险模式（外渗/反弹 shell 等） |
| `obfuscation/invisible-bidi-chars` | high | 双向覆盖/隔离控制字符（U+202A–U+202E/U+2066–U+2069）——Trojan-Source 混淆 |
| `obfuscation/unicode-tag-chars` | high | Unicode Tag 字符块（U+E0000–U+E007F）——可编码对人眼不可见的 ASCII 隐藏指令 |
| `obfuscation/deprecated-bidi-format` | high | Unicode 3.0 废弃双向格式字符（U+206A–U+206F）——任何合法现代文本均不应包含 |
| `obfuscation/invisible-math-operators` | medium | 不可见数学运算符（U+2061–U+2064）——在非 MathML 上下文中可疑 |
| `obfuscation/ansi-escape-injection` | high | 原始 ANSI 转义序列（ESC U+001B）——可操控终端显示或隐藏文字 |

---

## 提示注入（prompt-injection）

试图覆盖 AI agent 指令、隐藏行为或用不可见字符绕过扫描。

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `prompt-injection/instruction-override` | high | "ignore/disregard/forget/override … previous/prior/all … instructions"——覆盖既有指令 |
| `prompt-injection/conceal-from-user` | high | "do not tell/reveal/warn … user"——指示对用户隐瞒 agent 行为 |
| `prompt-injection/zero-width-chars` | medium | 零宽空格/ZWJ 等不可见 Unicode（紧贴 ASCII 字母时才报）——拆词绕过扫描 |
| `prompt-injection/hidden-style-text` | medium | `display:none`/`font-size:0`/`visibility:hidden`——用 CSS 隐藏对模型的指令 |

---

## MCP 配置安全（mcp）

`audit --configs` 对 Claude Code/Cursor/VS Code/Windsurf/Zed 等工具的 MCP server 配置执行的检查。

### MCP Shell 包装器危险内联命令

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `mcp/shell-wrapper-curl-pipe-sh` | critical | MCP server 用 `sh -c "curl \| sh"` 运行远程脚本——任意代码执行 |
| `mcp/shell-wrapper-dev-tcp` | critical | MCP server 的 shell 内联命令含 `/dev/tcp/`——反弹 shell |
| `mcp/shell-wrapper-rm-rf-root` | critical | MCP server 的 shell 内联命令含 `rm -rf /`——破坏性操作 |
| `mcp/shell-wrapper-reverse-shell` | critical | MCP server 的 shell 内联命令含 `netcat -e`/`bash -i`/`python socket`——反弹 shell |
| `mcp/curl-pipe-sh` | critical | MCP server args（非 shell -c 上下文）中含 `curl \| sh` |

### MCP 供应链与配置风险

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `mcp/unpinned-package` | medium | MCP server 使用无版本号的 `npx`/`uvx`/`bunx` 命令——供应链风险 |
| `mcp/command-remote-url` | critical | MCP server 的 `command` 字段是 HTTP/HTTPS URL——直接执行远程资源 |
| `mcp/command-temp-dir` | medium | MCP server 可执行文件路径在可全写的临时目录（`/tmp`、`/dev/shm`）——TOCTOU/二进制植入风险 |

### MCP 凭据暴露

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `mcp/env-literal-openai-key` | high | MCP env 硬编码 OpenAI/Anthropic API key（`sk-…`） |
| `mcp/env-literal-github-token` | high | MCP env 硬编码 GitHub PAT（`ghp_…`） |
| `mcp/env-literal-aws-key` | high | MCP env 硬编码 AWS Access Key ID（`AKIA…`） |
| `mcp/env-literal-secret-key` | high | MCP env key 名含 `_TOKEN`/`_SECRET`/`_KEY`/`_PASSWORD` 且值为字面量 |
| `mcp/env-preload-hijack` | critical/medium | MCP env 设置 `LD_PRELOAD`/`DYLD_INSERT_LIBRARIES`——将共享库注入子进程（字面量=critical，变量引用=medium） |
| `mcp/header-literal-secret` | high | MCP server `headers` 中鉴权字段（`Authorization`、`X-API-Key` 等）含字面量密钥 |
| `mcp/url-embedded-credential` | high | MCP server URL 含内嵌凭据（`user:pass@host`） |
| `mcp/env-secret-to-remote` | medium | 远程 MCP server 的 env 含疑似字面凭据——会随每次请求传至远端 |

### MCP 元数据注入

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `mcp/metadata-prompt-injection` | high | MCP server 名称/描述中含提示注入短语——可污染 AI assistant 上下文 |
| `mcp/metadata-invisible-chars` | high | MCP server 名称/描述中含不可见/混淆 Unicode 字符——疑似隐藏指令 |

### MCP 远程传输风险

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `mcp/remote-http-plaintext` | high | MCP server 使用明文 `http://` 连接远程主机——凭据和数据暴露于中间人攻击 |
| `mcp/remote-untrusted-host` | medium | MCP server 通过 `https://` 连接原始 IPv4 地址——通常缺乏证书绑定 |

### MCP 权限与自动批准

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `mcp/auto-approve-wildcard` | high | `autoApprove`/`alwaysAllow` 为 `true` 或含 `"*"`——所有工具调用无需用户确认 |
| `mcp/auto-approve-broad` | medium | `autoApprove`/`alwaysAllow` 列表含 5 个或更多工具——大规模无人值守执行风险 |
| `mcp/broad-filesystem-scope` | high | MCP server args 含根/家目录路径（`/`、`~`、`$HOME`、`C:\`）——agent 可读写整个文件系统 |
| `mcp/dangerous-permission-flag` | medium | MCP server args 含 `--allow-all`/`--no-sandbox`/`--dangerously-*`/`--unsafe-*` 等危险标志 |

### MCP 凭据路径访问

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `mcp/credential-path-access` | medium | MCP server command/args/env 中配置了凭据路径（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube` 等）——agent 可静默读取并外传凭据 |

### MCP 杂项

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `mcp/invalid-json` | low | MCP 配置文件不是合法 JSON，无法解析审计 |

---

## Settings / Hooks / 权限（settings）

`audit --configs` 对 `.claude/settings.json`、`.gemini/settings.json` 等 agent 配置文件执行的检查。

### 恶意 Hook 命令

Hook 在 agent 事件（如每次工具调用前后）自动执行；被植入反弹 shell 或外传命令后危害极大。

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `settings/hook-reverse-shell-dev-tcp` | critical | Hook 命令含 `/dev/tcp/` 反弹 shell 模式 |
| `settings/hook-curl-pipe-sh` | critical | Hook 命令下载并管道到 shell（`curl \| sh`） |
| `settings/hook-wget-pipe-sh` | critical | Hook 命令下载并管道到 shell（`wget \| sh`） |
| `settings/hook-exfiltration-curl-body` | critical | Hook 命令用 `curl -d/-F` 向远程 URL 发送数据（外传） |
| `settings/hook-rm-rf-root` | critical | Hook 命令含 `rm -rf /` 或 `rm -rf ~`（破坏性清除） |
| `settings/hook-mkfs` | critical | Hook 命令含磁盘覆写操作（`mkfs`/`dd … of=/dev/sd*`） |
| `settings/hook-netcat-exec` | critical | Hook 命令含 `nc -e` / `ncat --exec`（netcat 反弹 shell） |
| `settings/hook-python-socket-reverse` | critical | Hook 命令含 Python socket 反弹 shell |

### 过宽权限

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `settings/permission-wildcard-star` | high | 权限条目为裸通配 `*`——允许任何工具或命令 |
| `settings/permission-bash-wildcard` | high | 权限条目为 `Bash(*)`——无限制 shell 执行 |
| `settings/permission-write-root` | high | 权限授予根/家目录的 Write 访问（`Write(/)`、`Write(~/**)`）——可覆写系统任意文件 |
| `settings/permission-read-root` | high | 权限授予根/家目录的 Read 访问（`Read(/)`、`Read(~/**)`）——可读取系统任意文件 |

### 硬编码密钥

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `settings/literal-openai-key` | high | Settings 中嵌入 OpenAI/Anthropic API key 字面量（`sk-…`） |
| `settings/literal-github-pat` | high | Settings 中嵌入 GitHub PAT 字面量（`ghp_…`） |
| `settings/literal-aws-access-key` | high | Settings 中嵌入 AWS Access Key ID 字面量（`AKIA…`） |
| `settings/env-secret-literal` | high | Settings 中 `*_TOKEN`/`*_SECRET`/`*_KEY`/`*_PASSWORD` 等字段含字面量（非变量引用） |

### 自动批准 / 跳过确认

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `settings/auto-approve-enabled` | high | `dangerouslySkipPermissions: true`、`autoApprove: true` 或 `confirmations: "never"` 等——禁用人工确认环节 |

### 杂项

| ruleId | 严重度 | 抓什么 |
|--------|--------|--------|
| `settings/unparseable` | low | Settings 文件不是合法 JSON，无法解析审计 |

---

## 统计总览

| 类别 | ruleId 数 |
|------|-----------|
| reverse-shell | 3 |
| clickfix | 3 |
| staged | 2 |
| exfiltration | 6 |
| credential-theft | 3 |
| supply-chain | 3 |
| persistence | 4 |
| global-tamper | 2 |
| destructive | 4 |
| obfuscation | 6 |
| prompt-injection | 4 |
| mcp（所有子类） | 27 |
| settings（所有子类） | 14 |
| **合计** | **81** |

---

> 本文件由 `tests/rules-doc.test.ts` 同步检查——若在代码中新增 ruleId 但未更新本文件，该测试会报错。
