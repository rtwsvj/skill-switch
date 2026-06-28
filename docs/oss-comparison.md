# 开源对标报告

> 本文档是 11 个功能领域 × 开源同类工具的尽调结果,形成两类建议:
>
> - **该新增** — 同类工具已有、skill-switch 缺失的能力,值得引入。
> - **该替换/借鉴** — 已有实现可以借鉴外部设计或替换底层组件,以降低维护成本或补强质量。
>
> 每条建议标注**优先级**(`S` 极高 / `H` 高 / `M` 中 / `L` 低)和工作量估计(`极低工` / `低工` / `中工` / `高工`)。末尾「总优先级表」汇总全领域。
>
> **主要参考工具:**
> [gitleaks](https://github.com/gitleaks/gitleaks) ·
> [semgrep](https://github.com/semgrep/semgrep) ·
> [garak](https://github.com/NVIDIA/garak) ·
> [mcp-scan](https://github.com/invariantlabs-ai/mcp-scan) ·
> [Trivy](https://github.com/aquasecurity/trivy) ·
> [cargo-vet](https://github.com/mozilla/cargo-vet) ·
> [OSV.dev](https://osv.dev) ·
> [mise](https://github.com/jdx/mise) ·
> [TruffleHog](https://github.com/trufflesecurity/trufflehog) ·
> [Stryker](https://stryker-mutator.io) ·
> [re2](https://github.com/uhop/node-re2) ·
> [tauri-plugin-updater](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/updater) ·
> [TanStack Query](https://tanstack.com/query)

---

## A. 检测规则与引擎

**对标工具:** [gitleaks](https://github.com/gitleaks/gitleaks)(密钥规则)、[OpenGrep/Semgrep](https://github.com/opengrep/opengrep)(规则框架)、[detect-secrets](https://github.com/Yelp/detect-secrets)

### 该新增

| 优先级 | 工作量 | 建议 | 说明 |
|---|---|---|---|
| **S** | 中工 | **代码块感知降级** | Markdown ` ``` ` 围栏内命中降一档/打 `in-code-block` 标签。skill 大量含攻击示例代码块,是当前最大误报源;不加工具会把教学文档当威胁。 |
| **H** | 中工 | **逐规则 true/false-positive fixture 测试** | 仿 OpenGrep `ok:`/`ruleid:` 注解,每条规则配 fixture,CI 验证不漏不误。当前只有文档同步检查。 |
| **H** | 低工 | **密钥规则补 Shannon 熵 + keywords 预筛** | 命中后计算熵值区分真密钥 vs UUID/示例字符串,借鉴 gitleaks/Betterleaks 做法,纯逻辑零依赖。 |
| **M** | 低工 | **内置示例密钥词库**(`AKIAIOSFODNN7EXAMPLE` 等) | 避免已知示例密钥误报。 |
| **M** | 低工 | **typosquat 列表外部化** | 现仅 5 个硬编码词 → `data/typosquat.json` + 定期同步;可借鉴 Trivy 外部 DB 机制。 |

### 该替换/借鉴

- 正则引擎 vs ast-grep/opengrep:**skill 是 Markdown,AST 不适用**,不值得换;未来扫用户源码时再评。
- 硬编码密钥正则 → 借 gitleaks `keywords` 预筛 + entropy(纯逻辑,零依赖)。
- baseline 设计已优于 gitleaks(含行号)/semgrep,不必动;可补 `--verify` 调 API 验密钥是否仍存活。

**本领域 Top 3:** 代码块感知降级 → 逐规则 fixture 精度测试 → 密钥熵预筛

---

## B. AI 技能威胁 + 提示注入

**对标工具:** [garak](https://github.com/NVIDIA/garak)(对抗提示语料)、[mcp-scan](https://github.com/invariantlabs-ai/mcp-scan)([SkillJect 研究](https://arxiv.org/abs/2402.09268))、[SkillSieve](https://arxiv.org/abs/2504.09056)

### 该新增

| 优先级 | 工作量 | 建议 | 说明 |
|---|---|---|---|
| **S** | 极低工 | **Unicode TR39 完整 confusables 替换 18 字符表** | 当前 `HOMOGLYPH_MAP` 仅 18 个 Cyrillic 字符;TR39 `confusables.txt` 覆盖 9000+ 混淆字符对(含 Variation Selector,已在野出现)。构建时生成映射表,引擎不动。参考: [unicode.org/reports/tr39](https://www.unicode.org/reports/tr39/)。 |
| **H** | 中工 | **跨文件关联(SkillJect 式前载诱导)** | 扫 `SKILL.md` 中 `run:`/`hooks:` 引用的 .sh/.py 脚本并纳入主审计,合并 finding。 |
| **M** | 中工 | **从 garak 语料定期同步注入变体** | garak 是运行时工具,但 `PromptInject` 语料集可移植为静态规则,补充当前 11 条 mcp/注入 regex 的覆盖面。 |
| **M** | 低工 | **文档声明"静态审计 ≠ 运行时防护"** | 参见本文件末及 `docs/auditing-ai-agent-skills.md` 新增节。学术上静态扫描对恶意 skill 准确率上限约 61.5%([SkillSieve 2025](https://arxiv.org/abs/2504.09056)),诚实声明反增信任。 |
| **L** | 高工 | **可选 `--semantic` 本地 LLM 二次分类** | 严格 opt-in,仅本地模型,不破零遥测。作为远期降误报选项。 |

### 该替换/借鉴

- mcp/注入 11 条 regex → 从 garak `PromptInject` 语料定期同步变体。
- 单文件扫描 → 借鉴 SkillSieve 分层(regex → LLM 语义 → 沙箱);**静态上限 ~61.5% 是行业天花板,非工具失败**。
- mcp-scan Tool Pinning 思路:连 server 取工具描述 hash,补抓 command 不变但偷改描述的 rug-pull(参见领域 E)。

**本领域 Top 3:** Unicode TR39 完整 confusables → garak 语料同步 → 文档分层声明

---

## C. 审计输出 + CI/PR 集成

**对标工具:** [semgrep](https://github.com/semgrep/semgrep)(diff-aware baseline-commit)、[reviewdog](https://github.com/reviewdog/reviewdog)(PR 内联评论)、[Trivy](https://github.com/aquasecurity/trivy)(.trivyignore)

### 该新增

| 优先级 | 工作量 | 建议 | 说明 |
|---|---|---|---|
| **H** | 低工 | **SARIF `partialFingerprints`** | 当前 `sarif.ts` 不输出此字段;GitHub code-scanning 靠它去重,缺了同一 finding 每次 push 都产生新 alert。复用现有 `fingerprintFinding`。同时在 suppression 加 `status:'accepted'`。 |
| **H** | 低工 | **`--format codeclimate`** | GitLab MR widget 唯一原生格式(5 字段),fingerprint 直接复用,打开 GitLab 用户群。 |
| **H** | 中工 | **diff-aware 审计 `--diff-from <commit>`** | 只报 PR 改动行的新 finding,对标 `semgrep --baseline-commit`,是 CI 集成中最受好评的功能。 |
| **M** | 中工 | **reviewdog/rdjson 格式 + PR Review API 内联评论** | `::error` 注解只在 Checks tab;rdjson → reviewdog 能进 Files changed diff 行,更贴近开发者视角。 |
| **M** | 低工 | **`.skill-switch-ignore` 文件** | 类 `.trivyignore.yaml`,支持 path/glob/expiry 过期自动恢复。 |

### 该替换/借鉴

- 手写 SARIF(~157 行)→ 评估 [`node-sarif-builder`](https://github.com/Microsoft/node-sarif-builder):自动补 `partialFingerprints`/`helpUri`/`tags`,但需评活跃度再决定。
- pre-commit hook 用 `language:node` 而非 `system+npx`(借鉴 gitleaks 官方 hook repo 设计)。
- 基线行漂移容忍设计**已优于** gitleaks/semgrep(不含行号),保留。

**本领域 Top 3:** SARIF partialFingerprints → `--format codeclimate` → diff-aware + reviewdog

---

## D. 供应链溯源 + vet/审批 + 漂移

**对标工具:** [cargo-vet](https://github.com/mozilla/cargo-vet)(可共享审批)、[OSV.dev](https://osv.dev)(已知 CVE 数据库)、[sigstore/SLSA](https://slsa.dev)、[socket.dev](https://socket.dev)

### 该新增

| 优先级 | 工作量 | 建议 | 说明 |
|---|---|---|---|
| **H** | 中工 | **接入 OSV.dev Batch API** | 对 skill 内 `package.json`/`requirements.txt`/`Cargo.toml` 查已知 CVE(`POST /v1/querybatch`,零 CLI 依赖),finding ruleId=`osv/<CVE>`。补静态行为规则的 CVE 盲区。API 文档: [osv.dev/docs](https://google.github.io/osv.dev/api/)。 |
| **H** | 中工 | **cargo-vet 式可共享审批** | `drift-approvals` 发布为 URL,团队 import 直接信任(direct-only,不传递),`imports.lock` 锁版本 + 内容哈希防篡改。团队场景 ROI 最高。参考: [mozilla/cargo-vet](https://github.com/mozilla/cargo-vet)。 |
| **M** | 低工 | **审批 criteria 分级** | `safe-to-run` / `safe-to-deploy` 两级,CI 生产环境更严。 |
| **M** | 低工 | **漂移叙述借 CHANGELOG/commit messages 语义摘要** | 调 GitHub compare API 获取上游 commit 消息,辅助人工判断是否升级。 |
| **L** | 中工 | **SLSA/sigstore 可验证溯源** | `lock --verify-provenance` 下载 attest bundle 校验,当前覆盖率低,opt-in。 |

### 该替换/借鉴

- `countLineDelta` → 借鉴 difftastic 语法感知 diff:纯空格/注释重排不算漂移。
- `drift-approvals` 机制 → cargo-vet imports 设计(自研重实现,不引 cargo-vet 二进制)。

**本领域 Top 3:** OSV.dev CVE 盲区 → cargo-vet 式共享审批 → criteria 分级 + 漂移叙述

---

## E. 配置 + MCP 安全扫描

**对标工具:** [mcp-scan](https://github.com/invariantlabs-ai/mcp-scan)(tool 描述 hash 钉扎、影子化检测)、[Checkov](https://github.com/bridgecrewio/checkov)(策略插件)、[TruffleHog](https://github.com/trufflesecurity/trufflehog)(secret 检测)、[OPA/Conftest](https://www.conftest.dev)

### 该新增

| 优先级 | 工作量 | 建议 | 说明 |
|---|---|---|---|
| **S** | 中工 | **跨 server 同名 tool 影子化静态检测** | 全量 `mcpServers` 收集 `(server, tool)` 找重名 → `mcp/tool-name-collision`。CSA 确认是 2025 最危险向量([MCP Security Notifications](https://modelcontextprotocol.io/specification/2025-06-18/security)),与 mcp-scan 当前差距最大,且零依赖可实现。 |
| **H** | 中工 | **运行时 tool 描述 hash 钉扎(rug-pull 闭环)** | 现基线只签 `command/args/url`,不签 tool 描述(rug-pull 核心载体)。`--pin-tools` 可选项:spawn server 拉描述 SHA256 写入基线。 |
| **M** | 低工 | **OWASP MCP Top 10 映射** | ruleId → MCP01-10 标注 + 合规报告输出。参考: [owasp.org/www-project-top-10-for-large-language-model-applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)。 |
| **M** | 中工 | **Shadow MCP 检测** | 扫 `KNOWN_CONFIGS` 之外路径(含 Claude Desktop `~/Library/Application Support`,当前因路径含空格被跳过——改用 `path.join` 规避)。 |
| **L** | 高工 | **CycloneDX AI-BOM 生成** | 从配置提取 `npx` 包列表生成 AI-BOM,便于合规审计。 |

### 该替换/借鉴

- 注入短语 11 regex → 评估 mcp-scan 语义/LLM 分类(opt-in `--deep`,涉及隐私顾虑)。
- 自写 secret 3 regex → TruffleHog 800+ detectors(opt-in 外部 CLI 调用)。
- `KNOWN_CONFIGS` 静态列表 → 考虑插件式 JSON 让社区 PR 新 agent(对标 Checkov runner)。

**当前覆盖 11 条路径,缺:** Claude Desktop(macOS 高频)、Continue YAML、Codex TOML。

**本领域 Top 3:** tool 影子化静态检测 → tool 描述 hash 钉扎 → OWASP MCP Top10 映射

---

## F. 治理模型(声明/锁/同步/快照)

**对标工具:** [Terraform](https://github.com/hashicorp/terraform)(`plan -out` artifact)、[mise](https://github.com/jdx/mise)(profiles/层叠)、[chezmoi](https://github.com/twpayne/chezmoi)(source/dest 分离)、[Nix](https://nixos.org)(generation 生命周期)

### 该新增

| 优先级 | 工作量 | 建议 | 说明 |
|---|---|---|---|
| **H** | 中工 | **plan artifact 持久化(Terraform 式)** | 现 `sync --dry-run` 不持久化,apply 重算存在 TOCTOU。`sync plan --out plan.json` + `sync apply --plan`(校验声明 sha256)。CI/团队合规场景价值高。 |
| **H** | 中工 | **声明 profile/分组** | `skills.json` 顶层 `profiles: {work, ci, …}`,`sync --profile ci` 只装该组。一份声明管多机/CI 场景。对标 [mise profiles](https://mise.jdx.dev/profiles.html)。 |
| **M** | 低工 | **`doctor --fix` / 漂移自修复** | 现只报不修。按 drift kind 映射:missing→install,content-drift→reinstall,extra-locked→remove。 |
| **M** | 中工 | **`drift upgrade <skill>`** | upstream-ahead 一键升级到上游 HEAD + 重审 + 更新 lock(对标 `mise upgrade`)。 |
| **M** | 低工 | **快照生命周期 + prune** | `restore prune --keep-last N --older-than 30d`,防 backups 无限膨胀。对标 Nix `expire-generations`。 |
| **L** | 低工 | **`import --apply`(chezmoi 式 bootstrap)** | 新机一条命令完成初始化。 |

### 该替换/借鉴

- tar.gz+epochMs 快照 → 远期评估 [restic](https://github.com/restic/restic) content-addressed 后端:去重 + SHA256 自证 + 加密。代价:新增依赖、非人类可读。

> 注:Brewfile.lock 社区有争议(官方不打算锁版本);mise.lock 仍实验性;home-manager generation 只能编号不能命名。

**本领域 Top 3:** plan artifact 持久化 → 声明 profile/分组 → 快照 prune + 远期 restic

---

## G. 套餐 + 用法挖掘 + 推荐

**对标工具:** [Homebrew Bundle](https://github.com/Homebrew/homebrew-bundle)(远程 URL)、[atuin](https://github.com/atuinsh/atuin)/[mcfly](https://github.com/cantino/mcfly)(frecency)、[devcontainer](https://containers.dev)(OCI 引用)、[ccusage](https://github.com/ryoppippi/ccusage)(transcript 解析)

### 该新增

| 优先级 | 工作量 | 建议 | 说明 |
|---|---|---|---|
| **H** | 低工 | **共现指标加 Lift** | 现 `strength=sessionsTogether/min` 是单指标,无法区分"高频必然共现"vs"真关联"。加 `lift=P(A∩B)/(P(A)P(B))` + confidence,~15 行纯函数零依赖。`suggest` 过滤改 `lift >= 1.5 AND strength >= 0.4`。 |
| **H** | 中工 | **多 Agent transcript 支持** | 现仅解析 Claude Code JSONL;漏 Codex/Cursor/Gemini/Aider。`transcripts.ts` 已 plugin-ready,加 `agentAdapters` 注册表。 |
| **M** | 中工 | **套餐分享 URI + 社区注册** | 加 `github:owner/repo/pack.json` URI(借 Homebrew Bundle 远程 URL 和 devcontainer OCI 思路),演化出 `packs search` 社区 index。 |
| **L** | 低工 | **Frecency 排序** | recency 衰减,借鉴 atuin/mcfly;跨机用法同步(导出 JSON 合并,不建服务器,保零遥测)。 |

### 该替换/借鉴

- strength 单指标 → 关联规则三元(support + confidence + lift),30 年工程实践。
- `pack-lock commit='unknown'` 兜底 → 强制精确 SHA(取不到报警而非静默)。

**本领域 Top 3:** 共现 Lift 指标 → 多 Agent transcript → Pack 分享 URI

---

## H. MCP server 实现

**对标工具:** [MCP 官方 SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[MCP Registry](https://registry.modelcontextprotocol.io)

### 该新增

| 优先级 | 工作量 | 建议 | 说明 |
|---|---|---|---|
| **S** | 极低工 | **协议版本升至 2025-06-18** | 改一个常量。主流客户端(Cursor/Claude Code)已跑新版,旧版可能产生协商摩擦。规范: [MCP spec 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18)。 |
| **H** | 极低工 | **工具注解 `readOnlyHint:true` / `destructiveHint:false`** | 5 个工具本都只读;无注解客户端默认当"破坏性" → 额外确认弹窗。加注解即可自动批准。 |
| **H** | 中工 | **resources 暴露规则目录/审计报告** | `skill-switch://rules` + `report/last`,让 agent 直接把规则知识库当上下文,差异化于普通 CLI 包装型 server。 |
| **M** | 低工 | **MCP Registry 上架** | `package.json` 加 `mcpName` + `server.json` + mcp-publisher,曝光翻倍,仅配置工作。 |
| **L** | 高工 | **Streamable HTTP 传输** | 远程/CI 场景,需引入 SDK,远期再议。 |

### 该替换/借鉴

- 手写 stdio framing → 官方 `@modelcontextprotocol/sdk` StdioServerTransport:自动处理分帧/并发 id 路由。**但违零依赖原则**。
- **决策点:2026-07-28 RC 已移除 initialize 握手 + stateless 化**——届时手写改动量大,建议那时统一引官方 SDK,只换传输层,工具定义不动。

**本领域 Top 3:** 协议版本升级 + 工具注解 → resources 暴露 → MCP Registry 上架

---

## I. CLI 人机工程 + 分发

**对标工具:** [Commander.js 15](https://github.com/tj/commander.js)(内置补全)、[Homebrew](https://brew.sh)(tap)、[tauri-action](https://github.com/tauri-apps/tauri-action)(跨平台 CI)、[bun compile](https://bun.sh/docs/bundler/executables)

### 该新增

| 优先级 | 工作量 | 建议 | 说明 |
|---|---|---|---|
| **H** | 极低工 | **Shell 自动补全** | Commander 15 已内置 `program.enableAutocomplete()`,一行即可。25+ 命令无补全是最大摩擦点。 |
| **H** | 中工 | **Homebrew tap** | macOS 用户习惯 `brew`,安全工具尤其比 `npm -g` 更受信任。一个 `Formula.rb` + Release asset。 |
| **H** | 中工 | **跨平台分发** | Tauri 已支持 deb/AppImage/rpm/NSIS/MSI;用 [tauri-apps/tauri-action](https://github.com/tauri-apps/tauri-action) 替手写 `release.mjs`,matrix 构建 macOS/Linux/Windows + 签名 + 上传 Release。 |
| **M** | 低工 | **Commander 原生 helpGroup** | 替手写 `QUICK_START` 文字块,25+ 命令结构化分组。 |
| **M** | 低工 | **拼写纠错** | Commander `suggestSimilarCommand()` 已内置,一行启用。 |

### 该替换/借鉴

- **Node SEA + postject(实验性,fuse marker 脆弱)→ 评估 `bun build --compile`:**真静态单文件 + 交叉编译 Linux/Windows,无 postject/fuse 搜索,产物小 20–40%。风险:需将 `isSea()` 分支改 `process.isBun`。
- 或评估 `deno compile`(交叉编译 + 权限隔离)。

**本领域 Top 3:** Commander 补全(1 小时)→ tauri-action 跨平台 + Homebrew tap → bun compile 替 Node SEA

---

## J. 桌面 GUI + i18n

**对标工具:** [tauri-plugin-updater](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/updater)、[TanStack Query](https://tanstack.com/query)、[i18next-cli](https://github.com/i18next/i18next-cli)

### 该新增

| 优先级 | 工作量 | 建议 | 说明 |
|---|---|---|---|
| **H** | 中工 | **tauri-plugin-updater 自动更新** | 安全工具尤需及时更新(规则库/漏洞修复)。GitHub Releases 静态 JSON 作 update server,零运维。 |
| **H** | 中工 | **TanStack Query 替手写 sections 状态机** | `App.tsx` ~60 行 loading/error/retry 手写。`useQuery{staleTime:5min, retry:1, refetchOnWindowFocus:false}` 是 Tauri IPC 推荐配置;`invalidateQueries` 替全量 `onRefresh`。 |
| **H** | 低工 | **i18next-cli CI 漏译检测 + 类型生成** | i18next-parser 2026-02 已归档;i18next-cli extract `--ci` 漏译即 CI 失败;types 让 `t('missing.key')` 编译期报错,堵死硬编码中文坑。 |
| **H** | 低工 | **修数据层硬编码中文错误** | `gui/src/data/run-with-timeout.ts:40/44/48` + `tauri.ts:86/94` 的中文错误字符串通过 `notice.detail` 显示给用户,英文模式下泄漏。改为结构化 error code + `t()`。 |
| **M** | 中工 | **Windows/Linux sidecar 二进制** | 现仅 aarch64-darwin,跟随领域 I 跨平台分发推进。 |

### 该替换/借鉴

- ⚠ 窗口标题硬编码 `"skill-switch Governance"`(暴露内部模型,违大白话,且英文)→ 改 `"skill-switch"` 或 `setTitle(t())`。
- i18next-parser → i18next-cli(前者已归档)。
- 纯 `useState`(DashboardShell 537 行 20+ useState)→ 待状态规模再涨才上 Zustand,当前不必须。

**本领域 Top 3:** 修硬编码中文错误 + 窗口标题 → TanStack Query 替状态机 → i18next-cli + tauri-plugin-updater

---

## K. 测试 + 安全加固 + 质量门禁

**对标工具:** [eslint-plugin-redos](https://github.com/nicolo-ribaudo/eslint-plugin-redos)、[node-re2](https://github.com/uhop/node-re2)、[StrykerJS](https://stryker-mutator.io)、[@fast-check/vitest](https://fast-check.dev)、[semgrep SAST](https://semgrep.dev)

### 该新增

| 优先级 | 工作量 | 建议 | 说明 |
|---|---|---|---|
| **H** | 低工 | **eslint-plugin-redos lint 阶段阻断 evil 正则** | biome 不支持 ReDoS 检测;对 `rules/**/*.ts` 单跑 eslint + redos 插件,写规则时就拦(比 1000ms 预算测试更早)。 |
| **H** | 极低工 | **CI coverage 阈值门禁** | `@vitest/coverage-v8` 已装,`test:coverage` 已有;只差 `vitest.config` 加 `thresholds: {lines:80, branches:75}` + CI 一步。当前最大质量门禁盲区。 |
| **H** | 中工 | **StrykerJS 变异测试** | 2000+ 测试但未验证能否 kill 突变体;优先针对 `audit/engine.ts` + `rules/**`。 |
| **M** | 中工 | **Semgrep SAST 扫自身代码** | 查 path-traversal/prototype-pollution;安全产品被投毒 = 信誉崩。 |
| **M** | 中工 | **渐进引入 re2** | 路径:① `recheck` 静态判定正则 ReDoS 易损性 ② 重写 2 处 lookaround(`base64-payload.ts:35`、`prompt-injection.ts:34`)③ 能通过 re2 编译的走 re2,余走 RegExp + 截断兜底。参考: [uhop/node-re2](https://github.com/uhop/node-re2)。 |

### 该替换/借鉴

- 手写 perf 预算测试 → [recheck](https://github.com/nicolo-ribaudo/recheck) 静态判定正则是否 ReDoS 易损(写规则时就测,更早更准)。
- `fc.assert` 手动 → `@fast-check/vitest` 官方集成(`test.prop`,自动 shrinking)。

**本领域 Top 3:** eslint-plugin-redos → CI coverage thresholds → 渐进 re2

---

## 总优先级表

### 一类:高 ROI 低工(建议近期落地)

| # | 领域 | 建议 | 工作量 |
|---|---|---|---|
| 1 | H | 协议版本升至 2025-06-18 + 工具注解 `readOnlyHint` | 极低工 |
| 2 | B | Unicode TR39 完整 confusables 替换 18 字符表 | 极低工 |
| 3 | K | CI coverage thresholds(`lines:80, branches:75`) | 极低工 |
| 4 | I | Commander 15 内置 Shell 补全(`enableAutocomplete()`) | 极低工 |
| 5 | K | eslint-plugin-redos lint 阶段阻断 evil 正则 | 低工 |
| 6 | C | SARIF `partialFingerprints` + suppression.status | 低工 |
| 7 | C | `--format codeclimate`(GitLab MR widget) | 低工 |
| 8 | J | 修 `run-with-timeout.ts` / `tauri.ts` 硬编码中文错误 | 低工 |
| 9 | J | i18next-cli CI 漏译检测 + 类型生成 | 低工 |
| 10 | G | 共现指标加 Lift + confidence(~15 行纯函数) | 低工 |
| 11 | A | 密钥规则补 Shannon 熵 + keywords 预筛 | 低工 |

### 二类:中工高战略价值(排进 v0.5–v0.6)

| # | 领域 | 建议 | 工作量 |
|---|---|---|---|
| 1 | E | 跨 server tool 影子化静态检测(`mcp/tool-name-collision`) | 中工 |
| 2 | A | 代码块感知降级(Markdown ``` 内命中降一档) | 中工 |
| 3 | F | plan artifact 持久化(Terraform 式,防 TOCTOU) | 中工 |
| 4 | F | 声明 profile/分组(mise 层叠,一份声明管多场景) | 中工 |
| 5 | D | 接入 OSV.dev Batch API 补 CVE 盲区 | 中工 |
| 6 | D | cargo-vet 式可共享审批(团队场景最高 ROI) | 中工 |
| 7 | C | diff-aware 审计 `--diff-from <commit>` | 中工 |
| 8 | G | 多 Agent transcript 支持(plugin 架构已就绪) | 中工 |
| 9 | K | StrykerJS 变异测试(engine.ts + rules/) | 中工 |
| 10 | H | resources 暴露规则目录/审计报告(差异化) | 中工 |
| 11 | J | TanStack Query 替手写 sections 状态机 | 中工 |
| 12 | E | 运行时 tool 描述 hash 钉扎(rug-pull 闭环) | 中工 |

### 三类:替换/架构演进(按需评估,有迁移成本)

| # | 领域 | 建议 | 说明 |
|---|---|---|---|
| 1 | I | `bun build --compile` 替 Node SEA + postject | 根治 fuse 脆弱 + 跨平台,需改 `isSea()` 分支 |
| 2 | K | 渐进引 re2(先 recheck 测 + 重写 2 处 lookaround) | 根治 ReDoS,lookaround 不兼容需先重写 |
| 3 | I | tauri-action 替 release.mjs + Linux/Windows matrix | 同一份 CI 覆盖三平台 |
| 4 | H | 引 `@modelcontextprotocol/sdk` 替手写 stdio framing | 建议 2026-07-28 RC 稳定后统一引入 |
| 5 | F | restic content-addressed 快照后端 | 去重 + 加密,新增依赖,远期再议 |
| 6 | J | tauri-plugin-updater 自动更新 | 安全工具优先,中工 |
| 7 | H | MCP Registry 上架(`server.json` + mcp-publisher) | 仅配置,曝光翻倍 |
| 8 | B | 从 garak 语料定期同步注入变体 | 差异化,中期 |

---

*最后更新: 2026-06-28 · 分支 `auto/p3-D11-docs`*
