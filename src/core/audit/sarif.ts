// SARIF 2.1.0 序列化器 — 纯函数,无副作用,方便单元测试。
// 规格参考:https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
// 只生成 GitHub code-scanning 要求的最小合法文档,不过度工程化。
// v0.5-3:新增 suppressedRuleIds 参数;被抑制的 finding 在 SARIF result 中写入
//         suppressions 数组,让 GitHub code-scanning 将其显示为 suppressed。
// p3-D1:
//   - 每个 result 加 partialFingerprints.skillSwitch/v1(指纹去重,GitHub code-scanning 靠此去重)
//   - suppression 对象补 status: "accepted"(SARIF §3.35.4 合规)
//   - rule descriptor 补 helpUri(指向 docs/rules.md 锚点或仓库 URL)
//   - rule descriptor properties.tags 加 OWASP LLM/MCP Top10 标签(additive)
// A2:
//   - properties.tags 再 additive 并入 MITRE ATLAS(atlas:)与 OWASP Agentic Top10
//     (owasp-agentic:)标签,与既有 OWASP LLM(owasp:LLMxx)标签并存;
//     映射表见 ./atlas-map.ts。不改 severity、不改阻断/抑制逻辑。

import type { AuditFinding, Severity } from './types.ts';
import { fingerprintFinding } from './baseline.ts';
// A2:MITRE ATLAS + OWASP Agentic Top10 标签(additive,与 OWASP LLM 标签并存)
import { atlasTagsForRule, agenticTagsForRule } from './atlas-map.ts';

// ── SARIF level 映射 ─────────────────────────────────────────────────────────
// critical/high → error;medium → warning;low/info → note
// 参考 GitHub SARIF 文档:error/warning/note 三级即可。
export function severityToSarifLevel(severity: Severity | string): 'error' | 'warning' | 'note' {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'note'; // low / 其他未知值都归入 note
}

// ── OWASP LLM/MCP Top10 映射 ─────────────────────────────────────────────────
// 规则类目 → OWASP LLM Top10 2025 标签
// 参考:https://owasp.org/www-project-top-10-for-large-language-model-applications/
// additive:仅在 SARIF rule properties.tags 中附加,不影响 severity 或阻断逻辑。
const RULE_CATEGORY_OWASP_TAGS: ReadonlyMap<string, string[]> = new Map([
  // 提示注入 → LLM01 (Prompt Injection)
  ['prompt-injection', ['owasp:LLM01']],
  // 不安全输出 / 混淆载荷 → LLM02 (Sensitive Information Disclosure) + LLM08 (Excessive Agency)
  ['obfuscation', ['owasp:LLM02', 'owasp:LLM08']],
  // 数据外传 / 凭据窃取 → LLM02 (Sensitive Information Disclosure)
  ['exfiltration', ['owasp:LLM02']],
  ['credential-theft', ['owasp:LLM02']],
  // 供应链攻击 → LLM03 (Supply Chain)
  ['supply-chain', ['owasp:LLM03']],
  // 数据中毒/反弹 shell / 点击劫持 / 远程执行 → LLM04 (Data and Model Poisoning) + LLM08
  ['reverse-shell', ['owasp:LLM04', 'owasp:LLM08']],
  ['clickfix', ['owasp:LLM04', 'owasp:LLM08']],
  ['staged', ['owasp:LLM04', 'owasp:LLM08']],
  // 破坏性命令 → LLM08 (Excessive Agency)
  ['destructive', ['owasp:LLM08']],
  // 持久化 → LLM08 (Excessive Agency)
  ['persistence', ['owasp:LLM08']],
  // Agent 配置篡改 → LLM08 (Excessive Agency) + LLM09 (Misinformation)
  ['global-tamper', ['owasp:LLM08', 'owasp:LLM09']],
  // MCP 配置 → LLM06 (Excessive Agency via MCP) + LLM03 (Supply Chain)
  ['mcp', ['owasp:LLM06', 'owasp:LLM03']],
  // Settings 篡改 → LLM08 (Excessive Agency)
  ['settings', ['owasp:LLM08']],
]);

// docs/rules.md 的仓库基础 URL(用于生成 helpUri)
// 使用具体路径让 GitHub code-scanning 可直接跳转到规则说明
const RULES_DOC_BASE_URL =
  'https://github.com/anthropics/skill-switch/blob/main/docs/rules.md';

/**
 * 根据 ruleId 生成 helpUri。
 * 格式:docs/rules.md#<ruleId 中的类目> 或者完整 docs URL + anchor。
 * anchor 规则:ruleId 的 '/' 替换为 '-',取类目前缀作为锚点区块。
 */
function ruleHelpUri(ruleId: string): string {
  // 取类目(第一段,如 "exfiltration/curl-body" → "exfiltration")
  const category = ruleId.split('/')[0] ?? ruleId;
  // docs/rules.md 中每个 ## 标题即类目对应章节,anchor 为小写
  // GitHub Markdown 锚点:中文字符被移除,空格变 -,特殊字符被移除
  // 为保证稳健,提供仓库 URL + anchor hint
  return `${RULES_DOC_BASE_URL}#${category}`;
}

/**
 * 根据 ruleId 获取 OWASP 标签列表。
 * 取规则 ID 的类目前缀匹配 RULE_CATEGORY_OWASP_TAGS。
 */
function owaspTagsForRule(ruleId: string): string[] {
  const category = ruleId.split('/')[0] ?? '';
  return RULE_CATEGORY_OWASP_TAGS.get(category) ?? [];
}

// ── SARIF 最小类型定义(仅用于本模块内部,不对外暴露完整规格) ────────────────

interface SarifArtifactLocation {
  uri: string;
  uriBaseId?: string;
}

interface SarifRegion {
  startLine: number;
}

interface SarifPhysicalLocation {
  artifactLocation: SarifArtifactLocation;
  region: SarifRegion;
}

interface SarifLocation {
  physicalLocation: SarifPhysicalLocation;
}

interface SarifMessage {
  text: string;
}

// SARIF 2.1.0 §3.35 suppression 对象:状态 + 来源类型
// p3-D1:补 status: "accepted" 字段(SARIF §3.35.4 合规,GitHub code-scanning 识别)
interface SarifSuppression {
  kind: 'inSource' | 'external';
  status: 'accepted' | 'underReview' | 'rejected';
  justification?: string;
}

interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: SarifMessage;
  locations: SarifLocation[];
  /**
   * p3-D1:partialFingerprints 让 GitHub code-scanning 跨 run 去重 finding。
   * key "skillSwitch/v1" 与 baseline.ts 中的指纹方案版本对应。
   */
  partialFingerprints?: Record<string, string>;
  /** 存在时表示该 result 被抑制;GitHub code-scanning 据此标记为 suppressed */
  suppressions?: SarifSuppression[];
}

interface SarifReportingDescriptor {
  id: string;
  defaultConfiguration: {
    level: 'error' | 'warning' | 'note';
  };
  /** p3-D1:指向 docs/rules.md 中对应规则章节的 URL */
  helpUri?: string;
  /** p3-D1:附加 OWASP LLM/MCP Top10 标签(additive) */
  properties?: {
    tags?: string[];
  };
}

interface SarifToolDriver {
  name: string;
  version: string;
  rules: SarifReportingDescriptor[];
}

interface SarifTool {
  driver: SarifToolDriver;
}

interface SarifRun {
  tool: SarifTool;
  results: SarifResult[];
}

export interface SarifDocument {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}

// ── 导出:将 findings 列表序列化为 SARIF 2.1.0 文档 ─────────────────────────
/**
 * @param findings                audit 引擎产出的 finding 列表(可为空数组 → zero-result 合法文档)
 * @param toolVersion             package.json 版本号,由调用方同步读取后传入
 * @param suppressedRuleIds       被策略文件抑制的 ruleId 集合;命中的 result 写入 suppressions 字段
 * @param baselinedFingerprints   已基线化的指纹集合;命中的 result 同样写入 suppressions 字段
 */
export function toSarifDocument(
  findings: AuditFinding[],
  toolVersion: string,
  suppressedRuleIds: ReadonlySet<string> = new Set(),
  baselinedFingerprints: ReadonlySet<string> = new Set(),
): SarifDocument {
  // 构建 rules[]:从 findings 中去重 ruleId,每条取其第一次出现时的 severity
  const seenRules = new Map<string, 'error' | 'warning' | 'note'>();
  for (const f of findings) {
    if (!seenRules.has(f.ruleId)) {
      seenRules.set(f.ruleId, severityToSarifLevel(f.severity));
    }
  }

  // p3-D1:rule descriptor 补 helpUri + OWASP tags
  const rules: SarifReportingDescriptor[] = [...seenRules.entries()].map(([id, level]) => {
    const descriptor: SarifReportingDescriptor = {
      id,
      defaultConfiguration: { level },
      helpUri: ruleHelpUri(id),
    };
    // additive:OWASP LLM Top10 + MITRE ATLAS(atlas:) + OWASP Agentic Top10(owasp-agentic:)
    // 三套标签并存于 properties.tags,均不影响 severity / 阻断逻辑。
    const tags = [...owaspTagsForRule(id), ...atlasTagsForRule(id), ...agenticTagsForRule(id)];
    if (tags.length > 0) {
      descriptor.properties = { tags };
    }
    return descriptor;
  });

  // fingerprint 仅在 baselinedFingerprints 非空时才计算(零开销 fast-path)。
  const needsBaseline = baselinedFingerprints.size > 0;

  const results: SarifResult[] = findings.map((f) => {
    // p3-D1:计算 partialFingerprints(复用 baseline.ts 的指纹函数,保持一致)
    const fingerprint = fingerprintFinding(f);

    const result: SarifResult = {
      ruleId: f.ruleId,
      level: severityToSarifLevel(f.severity),
      message: { text: f.message },
      locations: [
        {
          physicalLocation: {
            // uri 使用相对路径;GitHub code scanning 会根据 checkout 根解析
            artifactLocation: { uri: f.file, uriBaseId: '%SRCROOT%' },
            region: { startLine: f.line },
          },
        },
      ],
      // p3-D1:partialFingerprints 供 GitHub code-scanning 跨 run 去重
      partialFingerprints: { 'skillSwitch/v1': fingerprint },
    };
    // 被策略文件抑制的 finding → 写入 suppressions 数组(SARIF §3.27.24)
    // 已基线化的 finding → 同样写入 suppressions(kind:'external')
    // p3-D1:补 status: "accepted"(SARIF §3.35.4)
    const isSuppressed = suppressedRuleIds.has(f.ruleId);
    const isBaselined = needsBaseline && baselinedFingerprints.has(fingerprint);
    if (isSuppressed || isBaselined) {
      result.suppressions = [{ kind: 'external', status: 'accepted' }];
    }
    return result;
  });

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'skill-switch',
            version: toolVersion,
            rules,
          },
        },
        results,
      },
    ],
  };
}
