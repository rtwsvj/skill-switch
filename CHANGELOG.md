# 更新日志 / Changelog

本项目的所有重要变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/),
版本遵循语义化版本。条目按**用户能感知的价值**书写,而非内部实现编号。

## [Unreleased]

### 新增 Added
- **`packs` 命令 — 从对话用法「发现」套餐**:`skill-switch packs suggest` 只读你和 Claude Code 的本机对话记录(只数 skill 名 + 次数,**绝不读对话正文、绝不出本机**),用同一次对话里的共现强度找出"老搭子",建议把常一起用的 skill 组成套餐(只建议、不擅自落地);`packs save <id>` 把某条建议固化成可携带的 `pack.json`(`source=discovered`,可分享/跨机复用);`packs show <file>` 查看套餐内容。建议理由带真实数字(如"这3个 skill 至少在 4 次对话里一起出现,平均共现强度 1.00")。手动精选包与用法发现包统一为一个 `PackManifest` 模型。纯静态,无 spawn/网络/新依赖。
- **`ci` 命令 — 一键接入 CI**:`skill-switch ci` 在仓库内生成 `.github/workflows/skill-switch.yml`,立即可用的 GitHub Actions 工作流;`--format sarif`(默认,上传 code-scanning,包含 `security-events: write` 权限)或 `--format github`(PR 内联注解,无需额外权限);`--pin <ref>` 固定 action 版本(默认 `v0.7.0`);`--baseline` 同时对当前仓库运行 audit、写入 `.skill-switch-baseline.json` 并在工作流 `args` 里自动注入 `--baseline` 参数,让 CI 从第一天起只对新 finding 失败;`--out <path>` 指定输出路径;`--force` 覆盖已存在文件;已存在时不 `--force` 则友好报错 exit 1;`--json` 输出机器可读摘要(含写入文件列表与基线计数)。无网络/无 spawn/无新依赖,仅写 cwd 下的文件。
- **`audit --configs --write-config-baseline <file>` / `--config-baseline <file>` — 统一配置漂移检测**:把当前发现的 MCP server 身份（command/args/url/env key 名/header key 名）以及各 settings 文件的安全结构（hooks 命令、permissions allow/deny、auto-approve key 集合）统一做 sha256 快照;后续 `--config-baseline` 与快照对比——MCP server command/args/url 变化 → `mcp/server-config-changed`（high）；新出现 MCP server → `mcp/server-added`（medium）；settings 文件 hooks/permissions/auto-approve 变化 → `settings/config-changed`（high）；新出现 settings 文件 → `settings/config-added`（medium）；移除不产生 finding。secret VALUE 永不进入基线文件（MCP 仅存 env/header KEY 名；settings 仅存 hook 命令字符串、权限条目字符串和 auto-approve key 名，均不含 token/secret literal），secret 安全有测试断言。基线文件统一格式：`{ version: 1, servers: { "<relPath>::server::<name>": "<sha256>", "<relPath>::settings": "<sha256>" } }`。与 `--policy` suppress、`--baseline`、`--format`（json/sarif/github）完整组合；须配合 `--configs` 使用，单独使用产生友好错误。纯静态，无 spawn/网络/新依赖。

## [0.7.0] — 2026-06-25

v0.7「让审计在真实 CI 里留得下来」——把刚上线的 GitHub Action 从"试一次"变成"团队长期留用"。三件直击安全工具的采用卡点:加进已有仓库不被一墙历史报错劝退(baseline)、findings 直接标在 PR diff 上(`--format github`)、看得清到底查什么(规则目录)。纯增量,CLI/审计行为与 v0.6.x 一致。

### 新增 Added
- **规则目录 `docs/rules.md`**:列出 audit 可 emit 的全部 ruleId(80+ 条),按威胁类别分组,含严重度与一句话说明;`tests/rules-doc.test.ts` 同步检查——新增 ruleId 若未更新文档测试即报错(已验证真能防过期)。
- **`audit --format github`**:直接输出 GitHub Actions 工作流注解命令,无需 `security-events: write` 权限或 code-scanning 设置,即可把每条 finding **内联显示在 PR diff** 对应行上。critical/high → `::error`、medium/low → `::warning`、已抑制/已基线化 → `::notice`,末尾附汇总行。退出码与其它格式一致(格式只改 stdout,不改阻断决策);可与 `--baseline`/`--policy`/`--configs` 组合。GitHub Action 新增 `format: github` 选项。
- **`audit` 基线模式**(让审计在已有仓库的 CI 里能落地):`--write-baseline <file>` 把当前所有 finding 存成基线;`--baseline <file>` 之后只对**新增** finding 失败(基线内的仍在输出里、标 `baselined`,但不计入退出码)。指纹基于 `ruleId + 相对路径 + 规范化 excerpt`(**不含行号**,故插入/移动代码行不会让既有 finding 误判为新增)。与 `--policy`/`suppress`、`--format`(json 加 `baselined` 字段、sarif 走 `suppressions`)、`--configs` 组合;基线文件缺失/损坏 → 友好报错。无基线标志时行为、输出、退出码与旧版逐字节一致。

## [0.6.1] — 2026-06-25

分发与定位:CLI 正式发布到公共 npm,新增可复用 GitHub Action,README 重定位为安全审计。CLI/审计行为与 v0.6.0 一致。

### 新增 Added
- **发布到公共 npm**:`npx @rtwsvj/skill-switch audit` 即可在任意项目/CI 里运行,无需装桌面 App(命令名仍是 `skill-switch`)。
- **可复用 GitHub Action**(`action.yml`):composite action,`setup-node → npx @rtwsvj/skill-switch audit --format sarif → 上传 GitHub code-scanning → 命中阻断级问题即 fail`,8 个可配输入(`path`/`args`/`version`/`format`/`upload-sarif`/`fail-on-findings` 等)。用法见 `docs/github-action.md`。

### 变更 Changed
- README(中/英)重定位:第一屏从「skill 治理台」改为「AI agent skills 与 MCP 配置的安全审计器」,突出 audit / SARIF / 策略 / 修复 的差异化;npm 包 `description` 同步。

## [0.6.0] — 2026-06-25

v0.6 在 v0.5「团队与 CI 集成」基础上深化审计:更多静态 MCP 凭据暴露检查、修复建议可被 CI 程序化消费,并以端到端 CLI 集成测试锁定全部审计行为。纯增量,无破坏性变更。

### 新增 Added
- **`audit --fix --format json` 机器可读修复报告**:同时传 `--fix` 与 `--format json` 时,JSON 报告追加顶层 `guidedFix` 字段——每条含 `kind`(`fixable`/`manual`/`skipped-config`)、`applied`、`backupPath`、`diff`(unified diff)及汇总计数,便于 CI 流水线消费修复建议。`--apply` 的写盘副作用与 human 格式完全复用 `runGuidedFix`(备份/幂等不变)。无 `--fix` 时 JSON 逐字节同旧;`--format sarif` 不受 `--fix` 影响。
- **静态 MCP 远程凭据暴露检查**:`audit --configs` 在结构化 MCP 分析上再加三项静态检查(零进程/零网络/零依赖)——`headers` 里硬编码密钥(`mcp/header-literal-secret`)、`url` 内嵌 `user:pass@` 凭据(`mcp/url-embedded-credential`)、把字面密钥 env 传给远程 server(`mcp/env-secret-to-remote`)。变量引用(`${X}`)、`Content-Type` 之类非鉴权头、无 userinfo 的 URL 等近似情形零误报;输出中密钥值一律脱敏。纯增量,现有规则与行为不变。

### 质量 Internal
- 新增**端到端 CLI 集成测试**,以真实子进程驱动 `audit` 锁定 SARIF / 策略文件 / 引导式修复 / 配置发现 / 静态 MCP 等 v0.5–v0.6 全部审计行为(测试总数增至 1555)。

## [0.5.0] — 2026-06-23

v0.5「团队与 CI 集成」——把 `audit` 从单机安全体检升级为可接入团队工作流与 CI 流水线的安全门禁:机器可读输出、项目级可调策略、受控引导式修复,以及更广的 agent 配置覆盖与静态运行时 MCP 能力审计。全部为**纯增量**——无 `audit` 标志时行为、输出、退出码与 v0.4 逐字节一致。

### 新增 Added
- **`audit --format sarif`**:输出 SARIF 2.1.0,可直接接入 GitHub code-scanning(团队/CI 集成的地基)。`--format` 取 `human`(默认)/`json`/`sarif`;`--json` 保持原样作 `--format json` 的别名,行为与退出码不变。
- **`audit --configs` 覆盖更多 agent**:新增 Windsurf(`~/.codeium/windsurf/mcp_config.json`)与 Zed AI(`~/.config/zed/settings.json`)的配置发现(Cline/Continue/Claude Desktop 因路径不规范或格式已废弃,暂未纳入)。
- **`.skill-switch-policy.json` 策略文件**:项目级可调审计阻断策略。`failOn` 设阻断的严重度下限;`suppress[]` 按 `ruleId` 抑制 finding(仍出现在输出里、但不计入退出码,SARIF 写 `suppressions` 字段便于 GitHub code-scanning 显示为 suppressed);`--policy <path>` 指定路径、`--no-policy` 忽略。无策略文件时行为、输出、退出码与旧版逐字节一致。
- **`audit --fix` / `--fix --apply` 受控引导式修复**:`--fix` 打印每条可修复 finding 的 unified-diff 预览(dry-run,不写盘);`--fix --apply` 实际修改文件,并先写 `<file>.skill-switch.bak` 备份(已存在则保留,不覆盖)。修复策略:注释化目标行并插入 `# [skill-switch] 已隔离可疑命令,请人工复核` 注解,操作幂等且可逆。无修复器的规则报 "需手动修复 (no safe auto-fix)"。`--configs` 发现的 config 文件永远只读。无 `--fix` 时行为、输出、退出码与旧版逐字节一致。
- **运行时 MCP 审计 · 静态能力检查**:`audit --configs` 在已有结构化 MCP 分析上新增六项静态检查(零进程 / 零网络 / 零依赖)——明文 `http://` 远程传输(`mcp/remote-http-plaintext`)、裸 IP 的 https 主机(`mcp/remote-untrusted-host`)、`autoApprove`/`alwaysAllow` 全量批准(`mcp/auto-approve-wildcard`)、批量自动批准 ≥5(`mcp/auto-approve-broad`)、根/家目录范围参数(`mcp/broad-filesystem-scope`)、危险权限标志如 `--no-sandbox`/`--allow-all`(`mcp/dangerous-permission-flag`)。loopback URL、空/少量 autoApprove、正常子路径等近似情形零误报;纯增量,现有规则与行为不变。

## [0.4.0] — 2026-06-22

自 v0.1.0 以来的全部成果一次发布。三个产品批次:**v0.2「安全网」**(让普通人也能安全、可回滚地管理技能)+ **v0.3「秩序」**(跨 agent 一致性与更深的安全)+ **v0.4「命令与深度审计」**(新命令 + 把审计扩展到混淆载荷与 agent 配置);外加一轮**自治维护强化**(更多检测精度、数据安全硬化、性能与稳定性、真 bug 修复——详见下方「自治维护强化」分组)。macOS 分发需 Developer ID 签名(见 [docs/release/signing.md](docs/release/signing.md))。

### 新增 Added
- **「历史」页**:把每次改动前的自动备份做成时间线,一键还原到任意时间点——误删误改的「后悔药」。
- **「安全」中心**:每个技能的安全评分 + 风险点;并列出「绕过了安全检查」的技能(谁、何时、为什么)。
- **首次启动引导卡**:第一次打开用大白话告诉你三件事——技能页看/停用·删除、安全页看风险、历史页一键还原。
- **「导入已有技能」**:一键把各 AI 工具里已存在、但还没纳入管理的技能收编进来。
- **健康中心(高级视图)**:跨 agent 的「声明 × 锁 × 磁盘」一致性可视化,按漂移类型分组、高亮、给出该怎么办。
- **操作历史**:备份记录读成大白话操作日志(「停用『X』前的备份」等)。
- **隐私页脚**:常驻「零遥测 · 本机运行 · 不上传 · 可离线」承诺。
- **(v0.4)`init` 命令**:扫描各工具已装的 skill,一键草拟初始 `skills.json`(已存在则不覆盖,`--force` 覆盖、`--dry-run` 只看草稿)。
- **(v0.4)`export` / `import` 命令**:把声明 + 锁打包成可携带的 `.ssp` 档案,跨机迁移你的技能配置(`import` 不覆盖现有、需 `--force`,且只写声明、提示你再 `sync`)。
- **(v0.4)`skills.json` JSON Schema**:发布 `docs/schema/` 下的正式 schema,`lint` 现在会校验声明文件结构并报出具体错误(缺字段 / 类型错 / 未知 mode 等)。
- **(v0.4)`lint` 规范检查**:对 SKILL.md frontmatter 的可选字段(version / tags / triggers)做温和的规范提示。

### 改进 Changed
- **所有危险操作先确认**,并用大白话说明「这一步会改什么」「能不能撤」(改动前自动备份)。
- **停用 ≠ 删除**:文案与视觉明确区分——停用只是关掉、文件保留、随时再启用;删除才动磁盘(且先备份)。
- **装东西被拦时讲清「为什么」**(列出触发的风险点),确需安装须填写理由(留痕)。
- **首屏更快**:audit/统计改为后台懒加载,不阻塞首屏;各区块有独立「加载中/失败/上次刷新」状态。
- **可达性**:确认弹窗支持 `Esc` 取消;技能列表为空时给「下一步去哪」的引导。

### 安全 Security
- 新增 **prompt injection / 隐藏指令** 检测(覆盖既有指令、对用户隐瞒、零宽字符、CSS 藏字),对齐业界扫描类目。
- `restore` / `uninstall` 路径穿越加固;skill 命名策略加固(控制字符、Windows 保留名等)。
- 强制越过安全检查的安装会**留痕**(可在安全中心查看)。
- GUI 收紧 CSP,阻断远程内容。
- **(v0.4)识破 base64 编码载荷**:`base64 -d | sh` 形态会解码后再扫,揪出藏在编码里的反弹 shell / 外传。
- **(v0.4)识破 Trojan-Source 伪装**:检测用于隐藏指令的双向控制字符(U+202A–202E / U+2066–2069,CVE-2021-42574);对中文/阿拉伯语/希伯来语/emoji 等正常内容不误报。
- **(v0.4)审计扩展到 agent 配置**:`audit --configs` 体检 `.claude/settings.json` 与 MCP 配置,揪出恶意 hook、过宽权限、明文密钥(默认不开,需显式 `--configs`)。

### 修复 Fixed
- 状态文件解析错误不再被静默当空;关键写入改为**原子写**(临时文件→rename)。
- 相对 symlink 正确解析;某个区块加载失败不再让整屏白错误。
- 修复测试配置漏跑部分 GUI 测试的缺口。

### 自治维护强化(更多检测 · 数据安全 · 稳定性)

**新增检测 Added**
- **识破伪装的安装源**:`npm/pip install --registry/--index-url` 指向可疑的非官方包仓库(明文 HTTP、裸 IP 地址、保留域名 `.invalid`/`.test`/`.local`、粘贴板/短链域名)会被标记;企业内网的 HTTPS 私有仓库**不误报**。
- **揪出「翻你密钥目录」的 MCP 配置**:被配置成可访问 `~/.ssh`、`~/.aws`、`~/.gnupg`、`.netrc`、`~/.config/gh` 等凭据路径的 MCP server 会被标记(可能被用来悄悄读取/外传凭据)。
- **`audit --configs` 体检面更广**:除 `.claude/` 外,现在还覆盖 Gemini CLI(`~/.gemini/settings.json`)、Cursor(`~/.cursor/mcp.json`)、VS Code(`~/.vscode/mcp.json`)与 home 根的 `~/.mcp.json`。

**改进 Changed**
- **`doctor` 一并显示「配置安全」**:日常体检就能看到危险配置发现的摘要,不必另跑 `audit --configs`;纯提示,**不改变 doctor 的退出码**(向后兼容)。
- **`--version` / `-V`**:CLI 现在能报告自身版本号。

**修复 Fixed**
- **emoji 不再被误判为隐藏指令**:含零宽连接符的常见 emoji(🧑‍💻、👨‍👩‍👧‍👦、🏳️‍🌈)与波斯语等文字不再触发「零宽字符」误报;真正用零宽字符把关键词拆开绕过扫描的手法仍会被抓。
- **删了技能目录也能从快照还原**:此前若已手动删除技能目录,`restore` 会失败;现在能正确重建并还原。
- **更稳的数据安全(全有或全无)**:`install` / `sync` / `restore` 遇到损坏的状态文件、损坏快照或缺失目录等异常时,一律在写盘前失败、不留「写了一半」的撕裂状态;破坏性改动前必有可回滚快照。
- **大目录扫描更快**:技能盘点减少每个技能的多余系统调用(约快 23%),同时保持对符号链接共享技能的正确识别。

**稳定性 Stability(内部,面向长期可维护)**
- 审计正则全面通过 ReDoS(灾难性回溯)加固验证;新增端到端生命周期集成测试与 GUI 逻辑层测试;测试总数增至 **1340+**,CI 全绿。

## [0.1.0] — 早期发布(baseline)

- 跨 agent(claude-code / codex / gemini-cli …)技能扫描、安装、启停、同步、移除。
- `skills.json`(声明)× `skills.lock.json`(锁)× 磁盘 三方对账(`doctor`,`--ci` 漂移即退出 1)。
- 安装前安全审计 + 写操作前自动 tar 快照 + `restore`。
- CLI + Tauri 桌面 GUI(四语:简中/English/日本語/Español)。
