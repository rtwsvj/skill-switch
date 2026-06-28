// audit 模块共享类型。规则的检测类目与评分规格移植自
// agentskill-sh/ags 的 skills/learn/references/SECURITY.md(MIT,见 THIRD_PARTY_NOTICES.md)。
export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface AuditRule {
  /** 规则 ID,约定 `<类目>/<slug>`,如 `exfiltration/curl-pipe-sh` */
  id: string;
  severity: Severity;
  /** 逐行匹配的正则;引擎会剥离 g/y 标志保证无状态 */
  pattern: RegExp;
  /** 给人看的违规说明 */
  message: string;
  /** 规格来源(SECURITY.md 章节名或"自写"+依据) */
  source: string;
}

export interface AuditFileTarget {
  /** 展示用文件路径(相对 skill 根) */
  file: string;
  content: string;
}

export interface AuditFileRule {
  /** 文件级规则 ID,约定 `<类目>/<slug>` */
  id: string;
  severity: Severity;
  /** 给人看的违规说明 */
  message: string;
  /** 规格来源(SECURITY.md 章节名或"自写"+依据) */
  source: string;
  /** 返回 1-based 命中行与摘要;无命中返回 null */
  evaluate(target: AuditFileTarget): { line: number; excerpt: string } | null;
}

export interface AuditFinding {
  ruleId: string;
  severity: Severity;
  file: string;
  /** 1-based 行号 */
  line: number;
  /** 命中行原文(截断到 200 字符) */
  excerpt: string;
  message: string;
  /**
   * 可选:当 finding 落在 Markdown ``` 围栏代码块内时为 true。
   * 纯标注字段,不影响 severity/阻断逻辑;供 UI 灰显或 policy 决策使用。
   * 字段缺省(undefined)与 false 含义相同。
   */
  inCodeBlock?: boolean;
}
