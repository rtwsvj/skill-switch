# 竞品全景与差异化 / Competitive Landscape

> 本文是 skill-switch 的竞品尽调 + 战略定位。结论先行:**安全扫描正在被大厂商品化、可复现管理被 microsoft/apm 抢跑、市场/registry 已成熟** —— skill-switch 不能靠"最强扫描器"或"最全管理器"取胜,**护城河是几样独有能力的组合**:CI 级安全输出(SARIF/Action)+ 桌面 GUI + MCP server(审计即工具)+ 快照/一键回滚 + 对话用法挖掘套餐 + 零遥测本地优先。
>
> 数据基于各项目公开 README / 文档(2026-06),README 可能夸大,以实际能力为准。

## 一、竞品分类全景

### 1) 跨 agent 可复现管理(最强威胁)
- **[microsoft/apm](https://github.com/microsoft/apm)** —— Agent Package Manager。`apm.yml` + `apm.lock.yaml`(声明+锁,整合性哈希)、`apm install` 跨机可复现、传递依赖解析;支持 Copilot/Claude/Cursor/OpenCode/Codex/Gemini/Windsurf/Kiro 共 8 客户端;`apm audit`(扫描+漂移检测)、`apm pack`(可携带包)、`apm-policy.yml` 组织级策略、内容扫描(隐藏 unicode)、市场。**≈80% 撞 skill-switch 的治理+套餐,且微软背书、原语更广(prompts/agents/hooks/plugins)。CLI-only,无 GUI、无 MCP server、安全审计较浅、无快照回滚。**
- **[mode-io/skill-manager](https://github.com/mode-io/skill-manager)** —— TS,跨 Codex/Claude/Cursor/OpenCode/OpenClaw 单地管理。

### 2) 安全扫描(正在商品化 —— 大厂下场)
- **[Cisco skill-scanner](https://github.com/cisco-ai-defense/skill-scanner)** —— YAML+YARA 模式 + LLM-as-judge + 行为数据流分析。
- **[NVIDIA SkillSpector](https://github.com/nvidia/skillspector)** —— 漏洞/恶意/风险检测。
- **[Snyk agent-scan](https://github.com/snyk/agent-scan)** —— 扫 AI agent / MCP server / skills。
- **[NMitchem/SkillScan](https://github.com/NMitchem/SkillScan)** —— 三段式:静态 + LLM 行为预测 + **Docker 沙盒执行**。
- **[LLMSecurity/skillguard](https://github.com/LLMSecurity/skillguard)** —— 对标 **OWASP Agentic Top 10 & MITRE ATLAS**。
- **[bruc3van/agent-skills-guard](https://github.com/bruc3van/agent-skills-guard)** —— Tauri2+React+Rust(同栈、中英双语),安全扫描**比我们深**:多步攻击链 taint、跨 skill 协同攻击、二进制魔数伪装(14 签名)、声明↔实现一致性;一键装/批量更新/跨 agent 同步/精选市场/CLI 工具管理。**无 governance/MCP/packs/CLI/CI 输出。**
- 商业:[Mondoo](https://mondoo.com/ai-agent-security)。
- **启示**:静态/行为扫描有大厂资源碾压,且学术结论是静态检测准确率有上限(~60%)。skill-switch 的扫描要"够用 + 差异化输出(SARIF/CI)",不追求"最强引擎"。

### 3) 桌面 GUI / 工具箱(质感标杆)
- **[winfunc/opcode](https://github.com/winfunc/opcode)** —— Tauri2 + React18 + **Tailwind v4 + shadcn/ui** + 明暗主题 + 用量图表 + 时间线/checkpoint。**GUI 质感标杆**(但偏 session/agent 管理,非 skill 安全)。
- **[Dimillian/CodexSkillManager](https://github.com/Dimillian/CodexSkillManager)** —— 原生 SwiftUI(macOS 26+),浏览/导入/**渲染 SKILL.md**/删除 + 接 Clawdhub 市场。无安全/治理/CLI。**精致的 skill 浏览器**。

### 4) 市场 / Registry / 包管理(已成熟,我们的明显短板)
- 目录:[claudemarketplaces.com](https://claudemarketplaces.com/)(21.6k skill)、[SkillsMP](https://skillsmp.com/)、[agentskill.club](https://www.agentskill.club/)、Clawdhub。
- 包管理:[tonsofskills + ccpi CLI](https://github.com/jeremylongshore/claude-code-plugins-plus-skills)、microsoft/apm。
- MCP:[官方 MCP Registry](https://github.com/modelcontextprotocol/registry)、[GitHub MCP Registry](https://github.blog/ai-and-ml/generative-ai/how-to-find-install-and-manage-mcp-servers-with-the-github-mcp-registry/)。

## 二、skill-switch 的差异化(护城河)
结构性独有、竞品各缺一块、**合起来无人有**:
1. **CI 级 / 无头 / 标准输出**:SARIF(code-scanning)、JUnit、codeclimate、rdjson、`--diff-from`、GitHub Action —— 桌面 GUI 竞品进不了 CI。**最硬的点。**
2. **治理层**:声明×锁×磁盘三方对账、`doctor`/`doctor --fix`、`sync plan/apply`、`drift --review`(cargo-vet 式审批)、装前快照 + 一键回滚、`restore prune`、export/import。(APM 有声明+锁但无快照回滚、无 GUI。)
3. **MCP server**:把审计做成 agent 能实时调的只读工具(scan/status/audit/packs_suggest/stats + resources/prompts)。竞品都没有。
4. **套餐 from 用法挖掘**:从本机对话共现(lift/confidence)建议 skill 组合。竞品的 pack 都是手动 bundle。
5. **零遥测 / 本地优先 / 装前必审、绝不执行粘贴命令**:原则性立场 + `add` 的安全姿态。

## 三、要补的(竞品已证明价值)
### 安全深度(对标 agent-skills-guard / Cisco / APM)
- taint / 数据流多步攻击链;二进制魔数伪装检测;跨 **skill** 协同攻击(补全已有的跨-server);OWASP Agentic / MITRE ATLAS 映射(接现有 OWASP 标签做全);可选**本地** LLM 行为判定层(严格 opt-in、不破零遥测)。详见 [docs/oss-comparison.md](oss-comparison.md)。

### GUI 重设计(对标 opcode / CodexSkillManager)
- 现状:1254 行手写 CSS、无设计系统、无暗色 → 引入 **shadcn/ui + Tailwind** 设计系统、明暗主题、SKILL.md Markdown 渲染、卡片化/图表化。(进行中)

### 生态 / Registry(别从零造,接现有)
- 让 `add`/`packs` 能从 Clawdhub / SkillsMP / claudemarketplaces / 官方 MCP Registry 搜索+安装(对标 ccpi / APM marketplace)。

## 四、战略建议
- **定位**:做"**工程师 / CI 级的 skill 安全 + 治理层**",不是"消费级 skill 商店"。把 CLI+CI+MCP+治理+零遥测打透。
- **互操作而非硬刚 APM**:考虑读 `apm.yml` / 与官方 MCP Registry 互通,做 APM 生态里"最强的安全+治理+本地 GUI"那一环。
- **GUI 必须不丑**:这是留存与口碑的门面(已开工重设计)。
- **补两个真缺口**:安全深度(taint/跨-skill/二进制伪装)+ registry 接入。
