// JUnit XML 序列化器 — 纯函数,无副作用,方便单元测试。
// 输出格式:JUnit 4 兼容 XML,Jenkins/GitLab/CircleCI/GitHub Actions 均支持。
//
// 结构设计:
//   <testsuites>
//     <testsuite name="skill-switch-audit" tests="N" failures="F" errors="0" ...>
//       <testcase name="<ruleId>  <file>:<line>" classname="<file>">
//         <!-- 阻断级别 finding → <failure> -->
//         <failure message="<message>" type="<severity>"><![CDATA[<详细信息>]]></failure>
//         <!-- 非阻断 finding(suppressed/baselined/severity未到阻断阈值) → <system-out> -->
//         <system-out><![CDATA[...]]></system-out>
//       </testcase>
//       <!-- 无 finding 的审计单元 → testcase 不含任何子元素 (passed) -->
//     </testsuite>
//   </testsuites>
//
// 每条 finding 对应一个 <testcase>。
// blocking=true 的 finding 写入 <failure>;非阻断 finding 写入 <system-out>。
// suppressed/baselined 的 finding 默认写入 <system-out>(不触发 CI 红灯)。
// 当 findings 为空时,产出一个虚拟 <testcase name="(no findings)"> 表示通过。

import type { AuditFinding, Severity } from './types.ts';

// ── 类型 ──────────────────────────────────────────────────────────────────────

/**
 * toJunitDocument 的可选配置。
 * 所有字段均有合理默认值,无需传入即可使用。
 */
export interface JunitOptions {
  /** testsuite/@name 属性值。默认 'skill-switch-audit' */
  suiteName?: string;
  /** 阻断严重度集合:命中的 finding 写入 <failure>。默认 {'critical','high'} */
  blockingSeverities?: ReadonlySet<Severity>;
  /** 被策略文件抑制的 ruleId;命中的 finding 视为非阻断 */
  suppressedRuleIds?: ReadonlySet<string>;
  /** 已基线化的指纹集合;命中的 finding 视为非阻断 */
  baselinedFingerprints?: ReadonlySet<string>;
  /** finding 指纹计算函数(可注入,便于测试) */
  fingerprintFn?: (f: AuditFinding) => string;
}

// ── XML 转义辅助 ──────────────────────────────────────────────────────────────

/** 转义 XML 属性值中的特殊字符 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;');
}

/** CDATA 段内的 ]]> 序列需分割处理 */
function cdata(s: string): string {
  // CDATA 内不能含 ']]>';替换为 ']]]]><![CDATA[>'
  return `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

// ── 核心序列化函数 ────────────────────────────────────────────────────────────

/**
 * 将 audit finding 列表序列化为 JUnit XML 字符串。
 *
 * @param findings   audit 引擎产出的 finding 列表(可为空数组)
 * @param options    可选配置(套件名、阻断集合、抑制/基线注入)
 * @returns          JUnit 4 兼容 XML 字符串(含 XML 声明)
 */
export function toJunitDocument(
  findings: AuditFinding[],
  options: JunitOptions = {},
): string {
  const {
    suiteName = 'skill-switch-audit',
    blockingSeverities = new Set<Severity>(['critical', 'high']),
    suppressedRuleIds = new Set<string>(),
    baselinedFingerprints = new Set<string>(),
    fingerprintFn,
  } = options;

  const needsBaseline = baselinedFingerprints.size > 0 && fingerprintFn !== undefined;

  /**
   * finding 是否被视为"阻断"(→ <failure>):
   *   1. 严重度在 blockingSeverities 内
   *   2. 且 ruleId 未被策略抑制
   *   3. 且指纹未基线化
   */
  function isBlocking(f: AuditFinding): boolean {
    if (!blockingSeverities.has(f.severity)) return false;
    if (suppressedRuleIds.has(f.ruleId)) return false;
    if (needsBaseline && fingerprintFn!(f) && baselinedFingerprints.has(fingerprintFn!(f))) return false;
    return true;
  }

  // 构建 testcase 列表
  const testcases: string[] = [];

  if (findings.length === 0) {
    // 无 finding → 单个通过测试用例
    testcases.push(`    <testcase name="${escapeAttr('(no findings)')}" classname="skill-switch-audit" time="0"/>`);
  } else {
    for (const f of findings) {
      const caseName = escapeAttr(`${f.ruleId}  ${f.file}:${f.line}`);
      const classname = escapeAttr(f.file);
      const blocking = isBlocking(f);

      const isSuppressed = suppressedRuleIds.has(f.ruleId);
      const isBaselined = needsBaseline && fingerprintFn!(f) ? baselinedFingerprints.has(fingerprintFn!(f)) : false;

      // 详细正文(CDATA):包含规则 ID、位置、摘要、消息、状态标注
      const statusTag = isSuppressed ? ' [suppressed]' : isBaselined ? ' [baselined]' : '';
      const detail = [
        `ruleId:   ${f.ruleId}`,
        `severity: ${f.severity}${statusTag}`,
        `file:     ${f.file}:${f.line}`,
        `message:  ${f.message}`,
        `excerpt:  ${f.excerpt.trim()}`,
      ].join('\n');

      if (blocking) {
        const lines = [
          `    <testcase name="${caseName}" classname="${classname}" time="0">`,
          `      <failure message="${escapeAttr(f.message)}" type="${escapeAttr(f.severity)}">`,
          `        ${cdata(detail)}`,
          `      </failure>`,
          `    </testcase>`,
        ];
        testcases.push(lines.join('\n'));
      } else {
        const lines = [
          `    <testcase name="${caseName}" classname="${classname}" time="0">`,
          `      <system-out>`,
          `        ${cdata(detail)}`,
          `      </system-out>`,
          `    </testcase>`,
        ];
        testcases.push(lines.join('\n'));
      }
    }
  }

  const totalTests = findings.length === 0 ? 1 : findings.length;
  const failureCount = findings.filter(isBlocking).length;

  const now = new Date().toISOString();
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites>`,
    `  <testsuite name="${escapeAttr(suiteName)}" tests="${totalTests}" failures="${failureCount}" errors="0" timestamp="${now}">`,
    ...testcases,
    `  </testsuite>`,
    `</testsuites>`,
  ];

  return `${lines.join('\n')}\n`;
}
