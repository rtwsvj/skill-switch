# 更新日志 / Changelog

本项目的所有重要变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/),
版本遵循语义化版本。条目按**用户能感知的价值**书写,而非内部实现编号。

## [Unreleased]

> 本轮:11 路并行的「开源对标」实现(见 [docs/oss-comparison.md](docs/oss-comparison.md))。第二波再上 5 项获批新依赖(下方「质量&GUI 增强」)。第三波全部落地:RE2 线性正则引擎、GUI shadcn 重设计基建、bun compile 并列打包路径。第四波「集众家之所长」(见 [docs/best-of-breed-plan.md](docs/best-of-breed-plan.md)):安全深度(二进制魔数伪装 / taint 数据流 / 跨-skill 协同 / OWASP Agentic+ATLAS 映射)+ apm.yml 互操作 + GUI Markdown 渲染 + registry 注册表只读接入(见 [docs/registry-integration-plan.md](docs/registry-integration-plan.md));全部自研重写、零复制竞品代码。

### 新增 Added
- **二进制魔数伪装检测(第四波·安全深度)**:`masquerade/binary-magic-bytes`(critical)+ `masquerade/binary-lossy-head`(high)——识别声明为文本却以 PE/ELF/Mach-O/PDF/ZIP/JAR/gzip/7z/RAR/Wasm 等可执行/归档魔数开头的伪装文件;只看文件起始,正文提及魔数名不误报。魔数表从公开格式规范自写。
- **taint 数据流多步攻击链(第四波·安全深度)**:`exfiltration/taint-source-to-sink`(high)——单文件内识别"读敏感源(环境变量/凭据文件/历史/浏览器·钱包数据)→ 近距离外发(curl 上传/nc//dev/tcp/外渗端点/base64 管道/scp 等)"的跨行数据外渗链;仅命令上下文计数,散文零误报。
- **跨-skill 协同攻击检测(第四波·安全深度)**:`analyzeCrossSkillCollusion`——识别多个 skill 经共享 dropzone 路径 / 共享外部端点(high)或全局配置蔓延(medium)联合构成的凭据外泄与提权链;需具体共享线索、能力横跨两个 skill 才报,重精确低误报;接入 audit home 全格式输出与退出码,补齐已有跨-MCP-server 检测。
- **OWASP Agentic Top10 + MITRE ATLAS 映射(第四波·安全深度)**:规则类目新增 MITRE ATLAS 技法(`atlas:AML.Txxxx`)与 OWASP Agentic Top10(`owasp-agentic:Txx`)标签,additive 并入 SARIF rule properties.tags,与既有 OWASP LLM 标签并存;不影响 severity 或阻断逻辑。
- **`apm-import <apm.yml>` — 与 microsoft/apm 互操作(第四波,只读)**:默认 dry-run 预览将纳管的 skill,`--apply` 才写入声明;只挑 skill 类原语映射到 skill-switch 治理模型,明确跳过 prompts/agents/hooks 等非 skill 原语。绝不执行 apm.yml 中的命令/脚本、绝不联网,纯本地文件解析。定位:互操作而非硬刚,做 APM 生态里"最强安全+治理"那一环。
- **GUI 技能描述 Markdown 安全渲染(第四波)**:技能详情的描述用 `react-markdown` + `rehype-sanitize`(默认 schema、禁 raw HTML、外链 `noopener`)渲染为富文本,杜绝描述内 XSS/钓鱼链接;样式走设计系统 token、明暗自适应。
- **`registry` 命令 — 注册表只读接入(第四波·C 线)**:从官方 **MCP Registry**(`registry.modelcontextprotocol.io`)、GitHub `marketplace.json` 市场、**SkillsMP**(可选)**只读搜索**(`registry search`)并**经安全审计后安装**(`registry install`)skill / MCP server。纯 opt-in(仅运行该命令才联网)、仅 HTTPS、零遥测(`credentials:'omit'`、不带指纹)、零新依赖(Node 内置 fetch)、限时限大小;安装复用既有「解析→克隆→审计→拦截」管线,DANGER 默认拦截需 `--force` 留痕放行,绝不执行远端内容。SkillsMP 是唯一需鉴权的源:严格 opt-in + 用户自带 `SKILLSMP_TOKEN` 环境变量,token 只发往 skillsmp.com、只进请求头(不进 URL/日志)、skill-switch 绝不存储;未设 token 则该源自动跳过。不抓无公开 API 的聚合站 HTML。

### 变更 Changed
- **GUI 各屏迁移到 shadcn 设计系统**:继 W4 基建后,「安全」(审计 + 配置安全)、「历史/撤销」、「使用」统计、「安装维护 + 一键装」各屏全部从手写 CSS 迁到 shadcn(Card/Table/Badge/Button/Input + 设计 token),卡片化、语义色 Badge(good/warn/danger)、明暗主题自适应,与总览统一;数据流 / props / 安全文案 / 无障碍语义(toast a11y)一律不变,四语言 i18n 齐全。
- **测试稳定性**:全局 `testTimeout` 提到 30s——大量 CLI 集成测试每例 spawn tsx 冷启动子进程,满负载并发下曾偶发 5s 超时误红(隔离重跑皆过);w3-re2 病态输入墙钟预算 50ms→500ms(吸收 GC/JIT 抖动,真 ReDoS 秒级仍判失败)。
- **审计引擎 → RE2 线性正则(第三波)**:`compileMatcher` 用 RE2(线性时间、无回溯)匹配审计规则,从根上消除 ReDoS;`prompt-injection/zero-width-chars` 去 lookbehind/lookahead、`base64-payload` rm-rf 去 lookahead(均附 `test()` 语义等价证明,findings 不变);4 条 `{0,2048}` 超量词规则回退原生 RegExp + 行截断保护;编译结果 WeakMap 缓存。corpus/评分/verdict 行为零改变。
- **GUI 重设计基建(第三波)**:引入 `shadcn/ui + Tailwind` 设计系统(Button/Card/Badge/Tabs/Dialog/Input/Select/Tooltip/Skeleton/Table)+ 明暗主题(跟随系统、localStorage 持久化、Header 一键切换)+ Overview 卡片化(指标卡 + lucide 图标 + 骨架占位);CSS 变量走 shadcn 标准 token + 语义色 `--good/--warn/--danger`;为后续各屏迁移提供设计系统契约。四语言 i18n 100%(新增主题切换/对话框关闭文案)。
- **bun compile 并列打包路径(第三波,实验性)**:新增 `gui/scripts/bundle-cli-bun.mjs`(`pnpm bundle:cli:bun`),用 `bun build --compile` 产出单文件 CLI(产物命名/路径与现有 SEA 路径一致),wrapper 入口绕过 `node:sea` 禁区;实测冷启动 ~71ms vs tsx ~765ms(约 10x)。bun 为 devDependency(不随应用发),测试用 `it.skipIf(!bunAvailable)` 守卫(无 bun 环境不红);现有 `bundle:cli`(SEA)/`src/**`/Tauri sidecar 完全保留。
- **质量门禁(第二波)**:`recheck` ReDoS 静态守卫——遍历全部审计规则正则,写规则时即拦下会回溯灾难的 evil 正则(测试门禁,无需 eslint);`stryker` 变异测试配置(`pnpm mutate`,收敛到 audit engine/score,衡量测试有效性);`i18next-cli` GUI 漏译检测进 CI(`pnpm --dir gui i18n:check`,漏译即失败,当前四语言 100%)。
- **GUI 数据层 → TanStack Query(第二波)**:App 手写的 sections 加载状态机替换为 `@tanstack/react-query`(`staleTime` 5min / `retry` 1 / 不随窗口聚焦重取,贴合 Tauri 本地 IPC);写操作后精细 `invalidateQueries`(toggle/remove/install/sync 后不重跑 stats),取代全量刷新;DashboardShell 对外接口不变。
- **GUI 自动更新(第二波)**:接入 `tauri-plugin-updater` + `tauri-plugin-process`,`UpdateChecker` 横幅组件(有更新提示版本+一键更新+重启,非 Tauri 运行时优雅 no-op),四语言 `update.*` 文案;更新源指向 GitHub Releases 的 `latest.json`,发布前需 `tauri signer generate` 填真实 pubkey(已占位+注释)。
- **审计引擎/SARIF 增强**:SARIF result 加 `partialFingerprints`(GitHub code-scanning 跨 run 去重)+ `suppression.status="accepted"` + rule `helpUri`;Unicode 同形字表 18 → **140+**(Cyrillic 全集 / 希腊 / 全角 / Latin lookalike);Markdown 围栏代码块内的 finding 加 `inCodeBlock` 标注(additive,不改 severity);SARIF rule 加 OWASP LLM Top10 标签。
- **审计输出 & CI 适配**:`audit --format codeclimate`(GitLab Code Quality)、`--format rdjson`(reviewdog PR 内联)、`--diff-from <commit>`(只报 PR 改动文件的 finding)、`.skill-switch-ignore`(.gitignore 风格忽略);`ci --format codeclimate|rdjson` 生成对应工作流。
- **MCP/配置安全**:`mcp/tool-name-collision` 跨文件同名 server 影子化检测(2025 高危向量);密钥检测加 Shannon 熵 + 示例白名单降误报;Claude Desktop(`~/Library/Application Support/Claude/…` 等)路径纳入深扫。
- **供应链 & 漂移**:`drift --osv`(opt-in,POST OSV.dev querybatch 查 skill 依赖的已知 CVE,默认关、仅 flag 时联网)、审批 `--criteria safe-to-run|safe-to-deploy` 分级、`drift --upstream-summary`(本地 git log 拼上游新增 commit 摘要)。
- **套餐 & 用法挖掘**:共现分析加 `lift`/`confidence` 关联规则指标(过滤"高频 skill 与谁都共现"的假关联);transcript adapter 架构 + 内置 **Codex CLI** 解析器(`~/.codex/sessions/`);内置套餐改 readdir 自动发现。
- **MCP server 深化**:协议升级 `2025-06-18`;5 个只读工具加 `readOnlyHint` 注解(客户端可免确认弹窗);实现 `resources`(规则知识库 / 最近审计报告)、`prompts`(3 条审计模板)、audit 工具 `outputSchema`;新增 `server.json` + `package.json` `mcpName`(MCP Registry 上架)。
- **`completion` 命令 + CLI 分发**:`skill-switch completion [bash|zsh|fish]` 输出 shell 自动补全;`--help` 用 Commander 原生 helpGroup 分组;新增 `release.yml`(tauri-action 跨平台构建 DMG/AppImage/deb/MSI)+ Homebrew Formula + Scoop manifest + [docs/distribution.md](docs/distribution.md)。
- **GUI 无障碍加固**:撤销 toast 升为有名 landmark + 关闭后焦点恢复;技能列表行 `aria-current` + 键盘 Enter/Space 选中;写操作按钮带技能名 `aria-label`。
- **质量门禁**:CI 加 coverage 阈值门禁(保守下限,防倒退);audit/doctor/add 的 golden snapshot 扩面;零依赖安全自检(查自身 shell 注入/path traversal 等)。
- **文档**:[docs/oss-comparison.md](docs/oss-comparison.md)(11 领域 × 开源对标的产品路线图,带来源 URL);[docs/auditing-ai-agent-skills.md](docs/auditing-ai-agent-skills.md) 加「静态装前审计 ≠ 运行时防护」诚实定位节(指向 garak/mcp-scan 等互补工具)。
- **GUI i18n 修复**:数据层超时/取消/JSON 错误改结构化 `LocalizedCommandError`(英文兜底 + UI 按语言渲染),窗口标题 `skill-switch Governance` → `skill-switch`,英文/日/西模式不再泄漏中文。
- **`sync --out <file>` / `sync --plan <file>` — plan artifact 持久化(对标 Terraform plan -out)**:`sync --out <file>` 把 planSync 结果 + 声明文件 sha256 摘要 + 时间戳序列化写盘;`sync --plan <file>` 读回后先校验声明 sha256 未变(变了则拒绝并提示重 plan),校验通过再执行——保证"看到的 plan"和"实际执行的 plan"完全一致。现有 `sync` / `sync --dry-run` 行为零改变。
- **`doctor --fix` — 漂移自修复(对标 chezmoi apply)**:doctor 已产结构化 finding,`--fix` 按 kind 映射:`content-drift` → 从声明 source 重铺(copy/symlink);`extra-locked` → removeLockEntries 清孤儿锁条目;`missing`/`stale-lock` → 提示手动跑 sync/install。写操作前自动先快照受影响的 agent 目录。无 `--fix` 时只报告,行为不变。
- **`restore prune` — 快照生命周期清理(对标 Nix expire-generations)**:`restore prune --keep-last <N>` 保留最近 N 个快照删除其余;`--older-than <Nd>` 删除 N 天前的快照;两者可组合;`--dry-run` 只列将删不执行。基于 listSnapshots 的 epochMs 排序,.tar.gz 与 .json sidecar 一并删除。
- **`import --apply` — 一条命令 bootstrap(对标 chezmoi init --apply)**:import 后追加 `--apply` 即直接执行 applySync,快照 + 同步一气呵成;无 `--apply` 时行为不变,仍只写声明/锁文件并提示手动 sync。

## [0.8.0] - 2026-06-27

### 新增 Added
- **`add` 命令 — 一键安装(粘链接/指令即装)**:`skill-switch add "<粘贴内容>"` 把一段 **GitHub 链接 / `git clone` / `npx·npm` 安装指令** 自动解析成 git 来源 → 克隆(只读)→ 逐个审计 → 列出候选 skill + 安全裁决(SAFE/REVIEW/DANGER)→ 安装(单个非危险源直接装,多个用 `--skill`/`--all`/`--yes` 选)。**安全姿态:绝不执行粘贴的命令** —— `curl … | bash`、`bash <(…)`、含 sudo/eval 的片段一律拒绝并解释;npm 包名只**只读**查一次 registry 拿到源码仓库地址再克隆审计(并提示「npm 发布内容可能 ≠ 源码仓库」);危险源(被安全闸门拦下)默认不装,需 `--force --force-reason`。支持 GitHub 子目录链接(`/tree/<ref>/<subdir>`、`/blob/...`)。`--dry-run` 只预览;`--json` 机读。新模块 `src/core/add/`(parse-source/resolve-npm/preview,纯解析零执行 + 复用现有 clone/audit/install 管线)。**GUI 也有同款入口**:「安装与维护」面板顶部一个粘贴框 → 「解析」→ 显示来源 + 可信度提示 + 候选 skill(彩色裁决,危险源禁止勾选)→ 「安装选中」→ 复用确认/快照/撤销 toast(4 语言 i18n)。
- **GUI 技能页体验升级**:主从布局(左列表 / 右详情面板,点行看详情)、每行状态徽章(已启用 / 已停用 / 有改动 / 被安全拦截,颜色对应语义)、写操作后撤销 toast(如"已停用 X — 后悔了?",6 秒自动消失,点「撤销」还原最新备份)。文案保持大白话、任务导向。
- **`explain <ruleId>` 命令 — 看懂审计规则**:`skill-switch explain reverse-shell/netcat-exec` 讲清这条规则**查什么 / 为什么危险 / 怎么修 / 误报怎么抑制**(三种抑制方式);未知 ruleId 给近似匹配并 exit 1;`--json` 机器可读。按风险类目(13 类)映射讲解,覆盖全部 80+ 规则。降低"被拦了看不懂"的门槛。只读。
- **套餐深化(团队/分享/可复现)**:`PackSkillRef.optional?` 可选 skill 标注(`packs install` 时可选 skill 失败只跳过、必需失败才判 `failed`);`packs install --lock` 写出 `*.pack.lock.json` 钉死每个 skill 的精确 commit(已有 lock 时按锁定 commit 装 → 团队可复现);3 个内置 starter 套餐(`security-review`/`tdd-workflow`/`team-onboarding`),`packs list --builtin` 列出、`packs install <内置id>` 直接装;`--dry-run` 标注每个 skill `[必须]`/`[可选]`。
- **`drift --review` — cargo-vet 式逐条漂移审批**:逐条 approve/reject 已知/有意的漂移,审批存 `~/.skill-switch/drift-approvals.json`(按 `<agent>::<name>::<state>` + 内容哈希绑定;内容再被改动则审批自动失效、重新浮现);`--approve-all` 非交互批量审批、`--json` 机读;已审批的漂移不再计入 `drift --ci` 的 exit 1。无审批文件时 `drift`/`--ci` 行为与既有完全一致。
- **`diff` 叙述化摘要("改了啥")**:`diff` 顶部多一行人话摘要——动了几个文件、+N/−M 行,以及**是否新引入安全风险**(复用既有 audit 引擎对比改动前后的 findings,只报新增信号);`--json` 增 `narrative` 字段。内容安全:只输出 ruleId/严重度/计数,绝不回显命中的行文或密钥。
- **MCP 再加两个只读工具**:`skill_switch_packs_suggest`(从共现给套餐建议)和 `skill_switch_stats`(使用统计 + 僵尸 skill),供 agent 直接问"我常一起用哪些 skill / 哪些 skill 白占着"。`tools/list` 现 5 个工具,仍严格只读、内容安全。
- **`mcp` 命令 — 把 skill-switch 跑成 MCP server**:`skill-switch mcp` 在 stdio 上启动一个 [MCP](https://modelcontextprotocol.io) server,让 Cursor / Claude Code / Claude Desktop 等 agent 在对话里**实时调用**它的**只读**审计工具——`skill_switch_scan`(盘点已装 skill)、`skill_switch_status`(现状/健康)、`skill_switch_audit`(80+ 规则安全审计,可审单个 path 或整个 home + 配置)。**零依赖手写 MCP(JSON-RPC 2.0),不引入任何 MCP SDK**;`stdout` 仅承载协议、诊断走 `stderr`;协议版本 `2024-11-05`,支持 `initialize`/`tools/list`/`tools/call`/`ping`。**安全边界:MCP 这条路只读,绝不经此写磁盘**(安装/同步/回滚仍只走显式 CLI/GUI 且先快照)。`mcp --list-tools` 查看暴露的工具。接入方式见 [docs/mcp-server.md](docs/mcp-server.md)。
- **`status` 命令 — 一眼看清现状**:`skill-switch status` 只读汇总磁盘已装/声明/启用/锁定 skill 数、检测到的 agent、健康状态(对齐/无声明/漂移),`--json` 机器可读;`--help` 新增 QUICK START 示例块 + 命令按主题分组(盘点/安全/治理/套餐/其他);`scan` 无结果时给出下一步提示;`sync`/`install` 结束打印操作小结("启用 N、停用 M,已快照;跑 doctor 校验")。全部 additive,只读命令仍只读,退出码/`--json` 结构不变。
- **`packs install` / `packs save --enrich` / `packs list` / `extends` 继承 — 套餐可携带、可重装**:`skill-switch packs install <pack.json> [--agent] [--dry-run]` 按清单逐个复用现有安装管线(审计+快照+锁)把 skill 装到新机或另一个 agent;无来源的 skill 友好跳过并提示 `--enrich`;`packs save --enrich` 从 `skills.lock.json` 回填每个 skill 的 `repo/commit/ref`,让"发现"出来的套餐真正能跨机重装;`packs list [dir]` 列出目录下的套餐;`PackManifest` 新增 `extends?: string[]` 继承(父在前、子同名覆盖、防循环引用),安装/show 时展开。纯静态,无新依赖,清单永不含密钥。
- **`audit` 输出与 CI 适配增强**:新增 `--format junit`(输出 JUnit XML,供 Jenkins/GitLab/CircleCI 直接读取)、`--exit-code <n>`(覆盖阻断退出码,如 `--exit-code 0` 做 report-only)、`--min-severity <level>`(按严重度过滤,影响输出与阻断判定)、以及行内注释抑制 `# skill-switch:suppress[ruleId]`(该行/上一行有注释则该 finding 仍打印但不计入阻断,与 policy/baseline 抑制叠加)。全部 additive——不带任何新标志时,输出与退出码与既有逐字节一致(有回归测试守护)。
- **`ci --pre-commit` — 本地提交门控脚手架**:`skill-switch ci --pre-commit` 在仓库生成 `.pre-commit-config.yaml`(`repo: local` 钩子,提交时跑 `npx @rtwsvj/skill-switch audit --configs`),`--out` 指定路径、`--force` 覆盖、`--json` 机器摘要;与生成 GitHub Actions 工作流的 `ci` 互补,纯 `ci`(不带 `--pre-commit`)行为不变。
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
