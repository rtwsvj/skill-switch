# Roadmap

> 本页是公开路线图,诚实反映项目现状与方向;内容随版本迭代更新。

**愿景 / Vision:** 成为跨 AI 编程工具的最小可信 skill 治理层——让任何人都能放心安装、开关、审计、回滚来自不同来源的 skill,而不必信任每个 skill 的作者。

---

## 已发布 / Shipped

### v0.4.0(2026-06-22)— 安全网 · 秩序 · 命令与深度审计
单机场景已成熟。三方对账(声明×锁×磁盘)、深度安全审计引擎(注入/混淆/反弹shell/外渗/供应链/凭据路径)、数据安全三件套(install/sync/restore 全有或全无 + 快照)、`audit --configs`(Claude/Gemini/Cursor/VS Code)、`doctor` 配置安全面、init/export/import/watch 命令、JSON Schema 校验、`diff --format unified`、Tauri GUI(四语 + 大白话)。ReDoS 加固、端到端集成测试、1340+ 测试、CI 全绿。详见 [CHANGELOG](../CHANGELOG.md)。

> 早期 roadmap 的「近期稳定与加固」「中期功能」绝大部分已在 v0.1.0→v0.4.0 落地(覆盖率基线、退出码契约测试、init/export/import、Schema 校验、diff unified、watch、base64/同形字/Trojan-Source 审计、更多 agent 覆盖)。

---

## v0.5 计划 / Next — 「从单机到团队:把治理带进协作与流水线」

主题:产品对个人已扎实,v0.5 的杠杆在于**让治理进入团队与流水线**,并补强可操作性与运行时能力。按**稳定优先**分三阶段推进(低风险先行),每项有明确完成标准。

### 阶段 1(低风险打底)

#### A. 团队 / CI 集成
让 skill-switch 能在 CI 里把关一个仓库/团队的 agent 配置与技能。
- **GitHub Action**:复用 `audit`(技能 + `--configs`),对发现做注解,按可配阈值在 critical/high 时 fail。
- **机读输出**:`audit --format sarif`(接 GitHub code-scanning)+ 稳定的 `--format json` schema。
- **策略文件** `.skill-switch-policy.json`:按项目设严重度阈值、规则白名单/抑制(须带理由)、路径包含/排除。
- **完成标准**:可用的 Action + 示例 workflow;SARIF 经 GitHub code-scanning 验证;policy 被 audit 正确读取;测试 + 文档齐全;现有 exit-code 语义不变。

#### B. 更多 agent 覆盖
线性放大核心价值,仅纳入**有规范路径**的工具,不臆测。
- 调研并接入:Windsurf、Cline、Continue、Zed AI 等的配置/技能路径(逐个核实规范位置与格式)。
- **完成标准**:每个新 agent 有 fixture 测试(发现 + 审计);无臆测路径;文档与 recall 语料同步;对既有不误报。

### 阶段 2(受控状态改动 — 倚仗已有的「全有或全无 + 快照」能力)

#### D. 修复引导 + 受控 `fix`
把「发现问题」变成「能修问题」,但只做安全、可逆的补救。
- `doctor`/`audit` 每类发现给出**具体下一步**提示。
- `skill-switch fix [--dry-run]`:仅应用**安全可逆**的补救——重锁内容漂移(重审后)、清孤儿锁、按 store 重建缺失的已声明技能;**始终先快照、全有或全无、默认 dry-run 预览**;**绝不自动「修」安全发现**(需人判断)。
- **完成标准**:opt-in;默认 dry-run;改动前必快照;只覆盖安全补救类;拒绝「修复」安全发现;端到端测试;文档。

### 阶段 3(旗舰 · 谨慎)

#### C. 运行时 MCP 审计
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
| **Linux / Windows 桌面包 + Homebrew** | Linux 需 `.deb`/`.AppImage` 打包;Windows 需 EV Code Signing 证书(凭据步骤);CLI 的 Homebrew tap 较易,可先做。 |
| **npm 发布 CLI** | 当前 `private: true` + 依赖 Node SEA 打包;需先解决依赖隔离。 |

---

## 如何反馈 / How to contribute

发现问题或有功能建议:请在 [GitHub Issues](https://github.com/rtwsvj/skill-switch/issues) 提 issue,说明使用场景和期望行为。
