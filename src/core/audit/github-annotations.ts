// GitHub Actions 工作流注解序列化器 — 纯函数,无副作用,方便单元测试。
// 规格参考:https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions
//
// 映射规则:
//   critical/high → ::error  (阻断级,与退出码阻断逻辑一致)
//   medium/low    → ::warning (建议级)
//   已抑制 suppressed 或已基线化 baselined → ::notice  (不阻断,仅告知)
//
// 转义规则(GitHub Actions 规范):
//   消息体(:: 后面的部分)需转义 % → %25, \r → %0D, \n → %0A。
//   属性值(file=/ title= 等 key=value 部分)额外转义 , → %2C, : → %3A。

import type { AuditFinding, Severity } from './types.ts';

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** 阻断级严重度集合(与 audit.ts 中的 BLOCKING_SEVERITIES 保持一致)。 */
const BLOCKING_SEVERITIES = new Set<Severity>(['critical', 'high']);

// ── 转义函数 ─────────────────────────────────────────────────────────────────

/**
 * 转义消息体(:: 后面的纯文本部分)。
 * 只需转义 % → %25、\r → %0D、\n → %0A。
 */
export function escapeAnnotationData(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

/**
 * 转义属性值(file=/ title=/ line= 等 key=value 中的 value 部分)。
 * 在 escapeAnnotationData 的基础上额外转义 , → %2C 和 : → %3A。
 */
export function escapeAnnotationProperty(value: string): string {
  return escapeAnnotationData(value)
    .replace(/,/g, '%2C')
    .replace(/:/g, '%3A');
}

// ── 单条注解生成 ─────────────────────────────────────────────────────────────

/**
 * 将单条 AuditFinding 序列化为一行 GitHub Actions 工作流注解命令。
 *
 * @param finding              待序列化的 finding
 * @param suppressed           是否被策略文件抑制
 * @param baselined            是否已基线化
 * @returns 一行注解字符串(不含末尾换行符)
 */
export function findingToAnnotation(
  finding: AuditFinding,
  suppressed: boolean,
  baselined: boolean,
): string {
  // 已抑制或已基线化 → ::notice(不阻断)
  // 其余按严重度:critical/high → ::error;medium/low → ::warning
  let level: 'error' | 'warning' | 'notice';
  if (suppressed || baselined) {
    level = 'notice';
  } else if (BLOCKING_SEVERITIES.has(finding.severity)) {
    level = 'error';
  } else {
    level = 'warning';
  }

  const file = escapeAnnotationProperty(finding.file);
  const line = String(finding.line); // 行号纯数字,无需转义
  const title = escapeAnnotationProperty(`skill-switch ${finding.ruleId}`);
  const message = escapeAnnotationData(finding.message);

  // 格式:  ::<level> file=<file>,line=<line>,title=<title>::<message>
  return `::${level} file=${file},line=${line},title=${title}::${message}`;
}

// ── 摘要行 ───────────────────────────────────────────────────────────────────

/**
 * 生成一行汇总 ::notice 注解,列出阻断数/建议数/基线数。
 * 固定以 ::notice:: 格式输出,不会触发 CI 失败。
 */
export function buildSummaryAnnotation(
  blockingCount: number,
  advisoryCount: number,
  baselinedCount: number,
): string {
  return `::notice::skill-switch: ${blockingCount} blocking, ${advisoryCount} advisory, ${baselinedCount} baselined`;
}

// ── 顶层序列化 ───────────────────────────────────────────────────────────────

/**
 * 将 findings 列表(可附带 suppressed/baselined 字段)序列化为多行 GitHub 注解字符串。
 * 末尾追加一行汇总 ::notice::。
 *
 * @param findings              finding 列表,可附带 suppressed?: boolean 和 baselined?: boolean
 * @returns 所有注解行以 \n 连接的完整字符串(末尾无多余换行符)
 */
export function toGithubAnnotations(
  findings: Array<AuditFinding & { suppressed?: boolean; baselined?: boolean }>,
): string {
  let blockingCount = 0;
  let advisoryCount = 0;
  let baselinedCount = 0;

  const lines: string[] = [];

  for (const f of findings) {
    const suppressed = f.suppressed ?? false;
    const baselined = f.baselined ?? false;
    lines.push(findingToAnnotation(f, suppressed, baselined));

    if (suppressed || baselined) {
      baselinedCount += 1;
    } else if (BLOCKING_SEVERITIES.has(f.severity)) {
      blockingCount += 1;
    } else {
      advisoryCount += 1;
    }
  }

  lines.push(buildSummaryAnnotation(blockingCount, advisoryCount, baselinedCount));
  return lines.join('\n');
}
