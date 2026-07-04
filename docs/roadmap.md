# Roadmap

> 本页是公开路线图,诚实反映项目现状与方向;内容随版本迭代更新。

**愿景 / Vision:** 成为跨 AI 编程工具的最小可信 skill 治理层——让任何人都能放心安装、开关、审计、回滚来自不同来源的 skill,而不必信任每个 skill 的作者。

---

## 已发布 / Shipped

按版本聚合,每条都对应 [CHANGELOG](../CHANGELOG.md) 里的实际条目。

### v0.4.0(2026-06-22)— 安全网 · 秩序 · 命令与深度审计

单机场景已成熟。三方对账(声明×锁×磁盘)、深度安全审计引擎(注入/混淆/反弹 shell/外渗/供应链/凭据路径)、数据安全三件套(install/sync/restore 全有或全无 + 快照)、`audit --configs`(Claude/Gemini/Cursor/VS Code)、`doctor` 配置安全面、init/export/import/watch 命令、JSON Schema 校验、`diff --format unified`、Tauri GUI(四语 + 大白话)。ReDoS 加固、端到端集成测试、1340+ 测试、CI 全绿。详见 [CHANGELOG](../CHANGELOG.md)。

> 早期 roadmap 的「近期稳定与加固」「中期功能」绝大部分已在 v0.1.0→v0.4.0 落地(覆盖率基线、退出码契约测试、init/export/import、Schema 校验、diff unified、watch、base64/同形字/Trojan-Source 审计、更多 agent 覆盖)。

### v0.5.0(2026-06-23)— 团队与 CI 集成

`audit --format sarif`(GitHub code-scanning)、项目级 `.skill-switch-policy.json` 策略文件、`audit --fix` 受控引导式修复、`audit --configs` 覆盖 Windsurf / Zed AI、静态运行时 MCP 能力检查(明文 `http://`、`autoApprove` 全量/批量、宽文件作用域、`--no-sandbox` 等)。详见 [CHANGELOG](../CHANGELOG.md)。

### v0.6.0 / v0.6.1(2026-06-25)— 静态 MCP 凭据 + 分发落地

`audit --fix --format json` 机器可读修复报告;静态 MCP 远程凭据暴露检查(`mcp/header-literal-secret`、`mcp/url-embedded-credential`、`mcp/env-secret-to-remote`);CLI 正式发布到公共 npm `@rtwsvj/skill-switch`,可复用 GitHub Action(`action.yml`)。详见 [CHANGELOG](../CHANGELOG.md)。

### v0.7.0(2026-06-25)— 让审计在真实 CI 里留得下来

`docs/rules.md` 全量规则目录(80+ 条,`tests/rules-doc.test.ts` 守门);`audit --format github` 直出 PR 内联注解(无需 `security-events: write`);`--write-baseline` / `--baseline` 让审计能在已有仓库的 CI 里第一天就落地(指纹基于 `ruleId + 相对路径 + 规范化 excerpt`,不含行号)。详见 [CHANGELOG](../CHANGELOG.md)。

### v0.8.0(2026-06-27)— 治理交互与 CI 适配

`add` 一键安装(粘链接/指令→解析→克隆→审计→安装,**绝不执行粘贴的命令**)、`explain <ruleId>` 讲清规则、`status` 一眼看清现状、`drift --review` cargo-vet 式逐条审批、`diff` 叙述化摘要、`packs suggest` 从对话用法发现套餐 + `packs save/install/extends` + 3 个内置 starter 套餐;`ci` 生成 `.github/workflows/skill-switch.yml`(`--format sarif|github`、`--baseline`、`--pre-commit`);`audit --format junit` + `--exit-code <n>` + `--min-severity <level>` + 行内 `# skill-switch:suppress[ruleId]`;`audit --configs --write-config-baseline` 统一配置漂移检测;`mcp` 命令把 skill-switch 跑成 MCP server(只读 JSON-RPC,5 个工具),GUI 升级主从布局 + 状态徽章 + 撤销 toast。详见 [CHANGELOG](../CHANGELOG.md)。

### v0.9.0(2026-07-01)— 集众家之所长 + 11 路并行开源对标

`registry` 命令只读搜索官方 MCP Registry / GitHub `marketplace.json` / SkillsMP(可选)并经审计后安装;`apm-import <apm.yml>` 与 microsoft/apm 互操作(只读);二进制魔数伪装检测、`taint` 跨行数据外渗链、`analyzeCrossSkillCollusion` 跨-skill 协同攻击、OWASP Agentic Top10 + MITRE ATLAS 映射;GUI 技能描述 Markdown 安全渲染、GUI 各屏迁到 shadcn 设计系统(明暗自适应 + 语义色 Badge)、TanStack Query 替手写状态机、GUI 自动更新(`tauri-plugin-updater`;该 GUI 已随后续退役,见下方 Unreleased);审计引擎迁 RE2 线性正则;`bundle:cli:bun` 与 SEA 并列打包路径;`audit --format codeclimate|rdjson`、`audit --diff-from <commit>`、`.skill-switch-ignore`;`mcp/tool-name-collision` 跨文件同名 server 影子化检测 + Claude Desktop 路径深扫;`drift --osv`(opt-in,POST OSV.dev)、`drift --upstream-summary`;`packs` 加 `lift` / `confidence` 关联规则指标 + Codex CLI transcript adapter;MCP `resources` / `prompts` / `outputSchema` + 协议升级 `2025-06-18` + 5 个只读工具加 `readOnlyHint`;`completion` shell 补全;`sync --out <file>` / `sync --plan <file>`(对标 Terraform plan -out)、`doctor --fix`(对标 chezmoi apply)、`restore prune`(对标 Nix expire-generations)、`import --apply`(对标 chezmoi init --apply);`recheck` ReDoS 静态守卫、`stryker` 变异测试、`i18next-cli` GUI 漏译检测进 CI;coverage 阈值门禁。详见 [CHANGELOG](../CHANGELOG.md)。

### [Unreleased] — 退役 Tauri GUI,SwiftUI 成为唯一桌面前端

桌面 App 从 Tauri v2 + React 迁到原生 **SwiftUI**(macos/,里程碑 1–5:总览 / 技能 / 安全 / 维护 / 历史 / 使用 六屏 + 写操作确认弹窗 + 自动快照 + zh-CN / en / ja / es 四语言应用内切换 + 跟随系统明暗主题);`gui/` 整个目录(`gui/src-tauri/` 的 Rust 壳、`gui/src/` 的 React、Tauri 配置、React 单元测试、bundling 脚本)随此版本一并退役,只保留过 README 引用的 5 张截图迁至 `assets/screenshots/`。CLI 打包脚本迁至 `scripts/`(原 `gui/scripts/bundle-cli.mjs`);`release.yml` 改为 `macos-14` runner 跑原生产物 zip(签名 + 公证仍由维护者本地跑 `macos/sign-notarize.sh`,Apple 凭据不进 CI);`.app` 内置 CLI 路径从 `Contents/MacOS/skill-switch-cli` 改为 `Contents/Resources/skill-switch-cli`。Linux / Windows 用户继续走 npm CLI(`npx @rtwsvj/skill-switch`),桌面 App 只发 macOS。详见 [CHANGELOG](../CHANGELOG.md)。

---

## 进行中 / In Progress — 下一个旗舰

### 运行时 MCP 审计(mcp-scan)(2026-07)

闭合调研里唯一需运行时的缺口(rug-pull 检测),但谨慎对待联网与连 server 的新攻击面。

- opt-in `skill-switch mcp-scan [--server <name>]`:连配置里的 MCP server(stdio/http),取**实时**工具清单,复用静态引擎审计工具描述,并把 `{name, description, inputSchema}` 哈希进 lock;再扫时检测 rug-pull(清单较基线变更)。
- **强 opt-in**(绝不自动连接)、逐 server 显式同意、超时、**绝不执行工具**、以 diff 呈现而非直接拦截。
- **完成标准**:仅 opt-in;受控连接(超时、不执行工具);rug-pull 基线进 lock;用 mock MCP server 测试;威胁模型文档;明确「这会连接一个服务器」的提示。

---

## 远期 / Long-term — 已知较难

| 方向 | 难点 |
|---|---|
| **闭合剩余 2 个审计漏判** | `javascript-string-concat-endpoint`(需 JS 常量折叠)、`cross-line-token-and-endpoint-split`(需跨行污点分析)——高误报风险,需真正的数据流分析,非小改。 |
| **语义审计沙箱** | 在隔离环境执行 skill 观察副作用,需解决沙箱逃逸、跨平台执行、误报率。 |
| **Linux / Windows 桌面包 + Homebrew tap** | Linux 需 `.deb`/`.AppImage` 打包;Windows 需 EV Code Signing 证书(凭据步骤);Homebrew Formula 已随仓库提供(`packaging/`)但 tap 仓库未建;Linux/Windows 桌面 App 需独立立项(本项目目前只发 macOS 桌面 App + 跨平台 CLI)。 |

---

## 如何反馈 / How to contribute

发现问题或有功能建议:请在 [GitHub Issues](https://github.com/rtwsvj/skill-switch/issues) 提 issue,说明使用场景和期望行为。
