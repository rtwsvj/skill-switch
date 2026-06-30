# 集众家之所长:提升方案 / Best-of-Breed Plan

> 本文是 skill-switch 吸收竞品已验证能力的执行契约。**结论先行:不复制任何竞品代码**——
> 所需能力要么是**公开事实**(文件格式魔数)、要么是**公开标准**(OWASP Agentic Top10 / MITRE ATLAS),
> 要么是**算法/格式**(taint 数据流、apm.yml 模式),全部**自研重写**。这比拼贴 Rust/Python/Swift
> 外语代码质量更高、可过本仓库测试门禁,且**零许可证纠葛、无需 clone 竞品、不新增 THIRD_PARTY_NOTICES**。
>
> 配套尽调见 [docs/competitive-landscape.md](competitive-landscape.md);开源对标路线图见 [docs/oss-comparison.md](oss-comparison.md)。

## 一、为什么不"直接复制竞品代码拼凑"

| 障碍 | 说明 |
|---|---|
| **语言不符** | agent-skills-guard 引擎是 Rust+Python、Cisco 是 Python+YARA、CodexSkillManager 是 Swift——整段粘不进本仓库的 TypeScript。 |
| **质量/一致性** | 拼贴外语代码会破坏架构一致性、引入维护债、过不了本仓库 lint/typecheck/测试门禁。 |
| **许可证** | 即便 MIT/Apache 也需署名+保留 NOTICE;copyleft 会传染。重写则无此负担。 |
| **真正可复用的只有"数据/规格"** | 魔数表、规则模式、OWASP/ATLAS 分类——这些是**公开事实或公开标准**,本就可自由重写,无需复制源码。 |

**许可证态度(回应"考虑许可证"诉求):** 候选竞品许可证已查清(guard=MIT、Cisco=Apache-2.0、skillguard=MIT、apm=MIT、opcode/shadcn=MIT;CodexSkillManager=Swift 不复用)。
**无 GPL/AGPL 卷入。** 本方案选择"全部重写",从根上规避复制与署名问题。GUI 的 shadcn/ui(MIT)已通过上游 npm 包正常引入(W4),非复制竞品源码。

## 二、吸收线总表

| 线 | 吸收自(已验证价值) | 拿什么 | 怎么拿 | 许可证影响 | 难度 |
|---|---|---|---|---|---|
| **A1 二进制魔数伪装检测** | agent-skills-guard(14 签名) | PE/ELF/Mach-O/PDF/ZIP/gzip… 魔数表 + 伪装检测(声明 `.txt`/`.md` 实为可执行) | 自研:魔数是**公开格式事实** | 无 | 低 |
| **A2 OWASP Agentic / MITRE ATLAS 映射** | LLMSecurity/skillguard、Cisco | 规则→OWASP Agentic Top10 + MITRE ATLAS 技法 id 映射,SARIF/报告输出 | 自研:引用**公开标准目录**;扩展现有 `sarif.ts` 的 OWASP-LLM 标签 | 无 | 低 |
| **A3 taint / 数据流多步攻击链** | agent-skills-guard、Cisco | untrusted source → 危险 sink 的跨步关联(读密钥→外发) | 自研:重写数据流思路为 `AuditFileRule` | 无 | 中高 |
| **A4 跨-skill 协同攻击** | agent-skills-guard | 多 skill 联合攻击(A 读敏感、B 外发),补全已有跨-server(mcp-audit) | 自研:新 `cross-skill.ts` 跨文件分析 | 无 | 中 |
| **D apm.yml 互操作** | microsoft/apm | 读 `apm.yml`/`apm.lock.yaml`,映射到 skill-switch 治理模型(只读、互操作而非硬刚) | 自研:格式不受版权约束,写 TS 解析器 | 无 | 中 |
| **B SKILL.md Markdown 渲染** | CodexSkillManager | GUI 技能详情把 description/SKILL.md 渲染为 Markdown | 自研(React);**需 markdown 依赖** | 无(npm 包) | 低 |
| **C registry/市场接入** | ccpi、APM marketplace、Clawdhub/SkillsMP/官方 MCP Registry | `add`/`packs` 从注册表只读搜索+装(opt-in) | 自研;**需新网络出口 + 可能新依赖** | 无 | 中高 |

## 三、本批并行实施(A1-A4 + D):零冲突文件归属契约

均为**纯自研 TS、不装新依赖、不联网、新增检测=强化安全**,直接做。各 agent 只产自有文件;共享文件(`rules/index.ts`、`src/cli/program.ts`、报告流、CHANGELOG/README)由编排者整合时统一接线。

| 线 | 自有文件(agent 独占) | 集成点(编排者接线) |
|---|---|---|
| **A1** | `rules/binary-masquerade.ts`(`AuditFileRule[]`)+ `tests/binary-masquerade.test.ts` | `rules/index.ts` 的 `allFileRules` |
| **A2** | `src/core/audit/atlas-map.ts` + 改 `src/core/audit/sarif.ts`(独占)+ `tests/owasp-atlas.test.ts` | 无(sarif 仅 A2 改) |
| **A3** | `rules/taint.ts`(`AuditFileRule[]`)+ `tests/taint.test.ts` | `rules/index.ts` 的 `allFileRules` |
| **A4** | `src/core/audit/cross-skill.ts` + `tests/cross-skill.test.ts` | 报告流挂载点 |
| **D** | `src/core/apm-interop.ts` + `src/cli/commands/apm-import.ts` + `tests/apm-interop.test.ts` | `src/cli/program.ts` 注册命令 |

**硬约束(全 agent):** 提交前 `pnpm test && lint && typecheck` 全绿才提交(`&&` 卡死);新文件**禁止顶层 `import.meta.url`**(崩 SEA,需用时放函数内);`AuditFileRule.evaluate` 须无状态、受行截断保护、低误报;findings 只增不改既有行为。

## 四、待你批准的依赖/网络门控(B、C)

这两线落在"装依赖 / 新网络出口需明确批准"的常设红线上,**未擅自动手**:

- **B(Markdown 渲染)**:建议 `react-markdown` + `rehype-sanitize`(渲染时强制净化,杜绝 XSS;安全工具不能渲染未净化 HTML)。或零依赖手写极简渲染器(更保守、功能有限)。→ **请选:react-markdown+sanitize / 零依赖手写 / 暂不做**。
- **C(registry 接入)**:需要 skill-switch 主动连外部服务(Clawdhub / SkillsMP / 官方 MCP Registry 等),引入新网络端点 + 可能的 SDK 依赖,且涉及供应链信任。建议**单独设计 + 逐端点批准**,不纳入本批 sweep。→ **请选:现在设计 C / 暂缓 C**。

## 五、来源与许可证记录

| 竞品 | 许可证 | 本方案使用方式 |
|---|---|---|
| bruc3van/agent-skills-guard | MIT | 仅借鉴"检测哪些威胁"的思路;魔数表自研(公开事实);**不复制源码** |
| cisco-ai-defense/skill-scanner | Apache-2.0 | 仅借鉴 taxonomy/数据流思路;**不复制源码、不跑 YARA** |
| LLMSecurity/skillguard | MIT | OWASP/ATLAS 映射自写(引用公开标准);**不复制其 markdown** |
| microsoft/apm | MIT | 仅读其**公开格式** apm.yml(格式不受版权约束);解析器自研 |
| winfunc/opcode · shadcn/ui | MIT | shadcn 经 npm 上游正常引入(W4);**非复制竞品源码** |
| Dimillian/CodexSkillManager | (Swift) | 仅借鉴"渲染 SKILL.md"交互思路;React 重写 |
