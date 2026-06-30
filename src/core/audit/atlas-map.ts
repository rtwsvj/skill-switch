// 规则类目 → 公开威胁分类法映射(纯标注,additive)。
//
// 本文件提供两张自写映射表,把 skill-switch 的规则类目对应到两套**公开标准**:
//
//  1. MITRE ATLAS(Adversarial Threat Landscape for AI Systems)
//     技法编号形如 AML.Txxxx。来源:https://atlas.mitre.org/
//     ATLAS 矩阵按 ATT&CK 风格的战术/技法组织 AI 系统攻防知识。
//
//  2. OWASP Agentic Security Initiative —— "Agentic AI Threats and Mitigations"
//     威胁分类法,编号形如 T1..T15(注意:这是 **Agentic** 威胁目录,
//     与 OWASP **LLM** Top10 完全不同,后者已在 sarif.ts 的
//     RULE_CATEGORY_OWASP_TAGS 中单独映射)。
//     来源:https://genai.owasp.org/initiatives/#agenticsecurity
//
// 设计原则(与 sarif.ts 中 RULE_CATEGORY_OWASP_TAGS 保持一致):
//   - key = 规则类目前缀(ruleId 的第一段,如 'exfiltration/curl-body' → 'exfiltration');
//   - value = 标签数组,前缀 'atlas:' / 'owasp-agentic:';
//   - 纯 additive:仅写入 SARIF rule properties.tags,不影响 severity、不改阻断逻辑;
//   - 全部引用公开标准的编号与命名,**未复制任何第三方项目的描述文本**;
//   - 覆盖现有全部规则类目,并为本批新类目预留:binary-masquerade / taint / cross-skill。
//
// 各映射条目旁的注释解释“为何该类目对应该技法”,均为本项目自写的对应理由。

// ── MITRE ATLAS 技法编号(仅列本文件引用到的,便于审阅)────────────────────────
// 全量矩阵见 https://atlas.mitre.org/matrices/ATLAS
//   AML.T0010  ML Supply Chain Compromise
//   AML.T0011  User Execution(.000 Malicious Package / .001 Unsafe ML Artifacts)
//   AML.T0012  Valid Accounts
//   AML.T0020  Poison Training Data
//   AML.T0024  Exfiltration via ML Inference API
//   AML.T0025  Exfiltration via Cyber Means
//   AML.T0029  Denial of ML Service
//   AML.T0031  Erode ML Model Integrity
//   AML.T0048  External Harms
//   AML.T0051  LLM Prompt Injection(.000 Direct / .001 Indirect)
//   AML.T0053  LLM Plugin Compromise
//   AML.T0054  LLM Jailbreak
//   AML.T0055  Unsecured Credentials
//   AML.T0057  LLM Data Leakage

/**
 * 规则类目 → MITRE ATLAS 技法 id 标签。
 * 标签前缀 'atlas:'。出处:https://atlas.mitre.org/
 */
export const RULE_CATEGORY_ATLAS_TAGS: ReadonlyMap<string, string[]> = new Map([
  // 提示注入 → LLM Prompt Injection;skill 文档内嵌注入属间接注入(.001)
  ['prompt-injection', ['atlas:AML.T0051', 'atlas:AML.T0051.001']],
  // 混淆载荷(base64 / 不可见字符 / ANSI 注入)→ 用编码绕过审查的间接提示注入,
  // 兼具越狱(Jailbreak)特征
  ['obfuscation', ['atlas:AML.T0051.001', 'atlas:AML.T0054']],
  // 数据外渗 → 经网络手段外泄(Cyber Means)+ 模型数据泄漏
  ['exfiltration', ['atlas:AML.T0025', 'atlas:AML.T0057']],
  // 凭据窃取 → 读取未受保护凭据;窃取后即等于持有有效账号
  ['credential-theft', ['atlas:AML.T0055', 'atlas:AML.T0012']],
  // 供应链 → ML 供应链妥协 + 恶意依赖包触发的用户执行
  ['supply-chain', ['atlas:AML.T0010', 'atlas:AML.T0011.000']],
  // 反弹 shell → 经网络手段外联(外泄/控制通道)+ 造成外部危害
  ['reverse-shell', ['atlas:AML.T0025', 'atlas:AML.T0048']],
  // ClickFix(诱导用户在终端粘贴执行)→ 典型的用户执行被滥用
  ['clickfix', ['atlas:AML.T0011', 'atlas:AML.T0048']],
  // 分阶段下载/预置(先拉取再执行)→ 链式用户执行 + 供应链拉取
  ['staged', ['atlas:AML.T0011', 'atlas:AML.T0010']],
  // 破坏性命令 → 对宿主系统造成的外部危害
  ['destructive', ['atlas:AML.T0048']],
  // 持久化 → 建立可复用立足点;以有效账号/凭据维持驻留
  ['persistence', ['atlas:AML.T0012', 'atlas:AML.T0048']],
  // 全局配置篡改(改 agent 全局行为)→ 侵蚀模型/系统完整性 + 外部危害
  ['global-tamper', ['atlas:AML.T0031', 'atlas:AML.T0048']],
  // MCP 配置(新增/改写工具或服务端)→ LLM 插件/工具被妥协 + 供应链
  ['mcp', ['atlas:AML.T0053', 'atlas:AML.T0010']],
  // Settings 篡改(改 agent 运行配置)→ 侵蚀完整性 + 借配置维持驻留
  ['settings', ['atlas:AML.T0031', 'atlas:AML.T0012']],

  // ── 本批新类目预留(给出合理映射)─────────────────────────────────────────
  // 二进制伪装(可执行体伪装成无害文件)→ 不安全 ML 工件触发的用户执行 + 供应链
  ['binary-masquerade', ['atlas:AML.T0011.001', 'atlas:AML.T0010']],
  // 污点传播(不可信输入流向危险 sink)→ 间接提示注入借数据流落地为外部危害
  ['taint', ['atlas:AML.T0051.001', 'atlas:AML.T0048']],
  // 跨 skill(一个 skill 影响/污染另一个)→ 借供应链与插件链条侵蚀完整性
  ['cross-skill', ['atlas:AML.T0010', 'atlas:AML.T0031']],
]);

/**
 * 规则类目 → OWASP Agentic Top10(Agentic Security Initiative)威胁码标签。
 * 标签前缀 'owasp-agentic:'。出处:https://genai.owasp.org/initiatives/#agenticsecurity
 *
 * Agentic 威胁码参考(T1..T15):
 *   T1  Memory Poisoning            记忆投毒
 *   T2  Tool Misuse                 工具滥用
 *   T3  Privilege Compromise        权限蔓延 / 越权
 *   T4  Resource Overload           资源耗尽
 *   T5  Cascading Hallucination     级联幻觉 / 级联失控
 *   T6  Intent Breaking & Goal Manipulation  意图篡改 / 目标操纵
 *   T7  Misaligned & Deceptive Behaviors     失准与欺骗行为
 *   T8  Repudiation & Untraceability         抵赖 / 不可追溯
 *   T9  Identity Spoofing & Impersonation     身份伪造 / 冒充
 *   T10 Overwhelming Human-in-the-Loop        压垮人工复核环节
 *   T11 Unexpected RCE and Code Attacks       意外的代码执行 / RCE
 *   T12 Agent Communication Poisoning         智能体通信投毒
 *   T13 Rogue Agents in Multi-Agent Systems   多智能体中的失控/恶意体
 *   T14 Human Attacks on Multi-Agent Systems  针对多智能体系统的人为攻击
 *   T15 Human Manipulation                    对人的操纵
 */
export const RULE_CATEGORY_AGENTIC_TAGS: ReadonlyMap<string, string[]> = new Map([
  // 提示注入 → 意图篡改/目标操纵 + 工具滥用(注入常意在驱使工具越界)
  ['prompt-injection', ['owasp-agentic:T6', 'owasp-agentic:T2']],
  // 混淆载荷 → 借编码绕过审查的意图篡改 + 失准/欺骗行为
  ['obfuscation', ['owasp-agentic:T6', 'owasp-agentic:T7']],
  // 数据外渗 → 工具被滥用以外传数据 + 越权访问
  ['exfiltration', ['owasp-agentic:T2', 'owasp-agentic:T3']],
  // 凭据窃取 → 凭据落地后导致越权 + 身份伪造/冒充
  ['credential-theft', ['owasp-agentic:T3', 'owasp-agentic:T9']],
  // 供应链 → 引入失控/恶意组件(等价于引入 rogue agent)+ 记忆/上下文投毒
  ['supply-chain', ['owasp-agentic:T13', 'owasp-agentic:T1']],
  // 反弹 shell → 危险工具被滥用 + 意外的代码执行/RCE
  ['reverse-shell', ['owasp-agentic:T2', 'owasp-agentic:T11']],
  // ClickFix → 操纵人执行命令(对人操纵)+ 压垮人工复核
  ['clickfix', ['owasp-agentic:T15', 'owasp-agentic:T10']],
  // 分阶段下载/执行 → 工具滥用拉取载荷 + 意外的代码执行
  ['staged', ['owasp-agentic:T2', 'owasp-agentic:T11']],
  // 破坏性命令 → 工具被滥用造成破坏 + 意外的代码执行
  ['destructive', ['owasp-agentic:T2', 'owasp-agentic:T11']],
  // 持久化 → 越权维持驻留 + 抵赖/不可追溯(隐蔽长存)
  ['persistence', ['owasp-agentic:T3', 'owasp-agentic:T8']],
  // 全局配置篡改 → 改全局即长期意图篡改 + 记忆/上下文投毒
  ['global-tamper', ['owasp-agentic:T6', 'owasp-agentic:T1']],
  // MCP 配置 → 工具滥用/新增危险工具 + 智能体通信投毒(MCP 通道)
  ['mcp', ['owasp-agentic:T2', 'owasp-agentic:T12']],
  // Settings 篡改 → 改运行配置即意图篡改 + 越权
  ['settings', ['owasp-agentic:T6', 'owasp-agentic:T3']],

  // ── 本批新类目预留(给出合理映射)─────────────────────────────────────────
  // 二进制伪装 → 借伪装绕过审查的失准/欺骗行为 + 意外的代码执行
  ['binary-masquerade', ['owasp-agentic:T7', 'owasp-agentic:T11']],
  // 污点传播 → 不可信输入经数据流操纵意图 + 工具滥用落地
  ['taint', ['owasp-agentic:T6', 'owasp-agentic:T2']],
  // 跨 skill → 一个 skill 污染另一个,属智能体通信投毒 + 多体中的失控/恶意体
  ['cross-skill', ['owasp-agentic:T12', 'owasp-agentic:T13']],
]);

/** 取规则 ID 的类目前缀(第一段),与 sarif.ts 内的拆分方式一致。 */
function categoryOf(ruleId: string): string {
  return ruleId.split('/')[0] ?? '';
}

/**
 * 根据 ruleId 获取 MITRE ATLAS 标签列表(无匹配返回空数组)。
 */
export function atlasTagsForRule(ruleId: string): string[] {
  return RULE_CATEGORY_ATLAS_TAGS.get(categoryOf(ruleId)) ?? [];
}

/**
 * 根据 ruleId 获取 OWASP Agentic 标签列表(无匹配返回空数组)。
 */
export function agenticTagsForRule(ruleId: string): string[] {
  return RULE_CATEGORY_AGENTIC_TAGS.get(categoryOf(ruleId)) ?? [];
}
