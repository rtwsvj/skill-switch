// 规则引擎骨架:对目标文件内容逐行跑规则,产出 findings + 评分 + 档位。
// 纯函数:文件读取由调用方(S2.5 的 audit CLI)负责,引擎只看内容。
import { scoreFindings, verdictForScore, type Verdict } from './score.ts';
import type { AuditFileRule, AuditFileTarget, AuditFinding, AuditRule } from './types.ts';
import { CONFUSABLES_MAP } from './confusables-data.ts';

export interface AuditTarget extends AuditFileTarget {}

export interface AuditReport {
  findings: AuditFinding[];
  score: number;
  verdict: Verdict;
}

const EXCERPT_LIMIT = 200;
export const MAX_AUDIT_MATCH_LINE_LENGTH = 2 * 1024;

// ── 同形字归一化 ──────────────────────────────────────────────────────────
// 使用 confusables-data.ts 中的扩展映射表(覆盖 Cyrillic 全集 + 希腊字母 +
// 全角 ASCII + 常见 Latin lookalike,共数百条)。
// NFKC 先处理全宽字符(如 ．→.)再做同形字替换。
// 仅用于规则匹配;原文保留用于 excerpt。
// 向后兼容:HOMOGLYPH_MAP 为 CONFUSABLES_MAP 的别名(内部使用,不 export)。
const HOMOGLYPH_MAP: ReadonlyMap<string, string> = CONFUSABLES_MAP;

/** 判断字符串是否含非 ASCII 字符(codePoint > 127)。 */
function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if ((s.codePointAt(i) ?? 0) > 127) return true;
  }
  return false;
}

/**
 * NFKC 归一化后再做同形字映射。
 * 输入必须已截断到 MAX_AUDIT_MATCH_LINE_LENGTH 以内。
 */
export function normalizeForMatch(line: string): string {
  const nfkc = line.normalize('NFKC');
  // 快速路径:若不含非 ASCII 字符则无需逐字扫描
  if (!hasNonAscii(nfkc)) return nfkc;
  let out = '';
  for (const ch of nfkc) {
    out += HOMOGLYPH_MAP.get(ch) ?? ch;
  }
  return out;
}

/** 剥离 g/y 标志:有状态的 lastIndex 会让同一规则跨行漏报。 */
function statelessPattern(pattern: RegExp): RegExp {
  const flags = pattern.flags.replace(/[gy]/g, '');
  return flags === pattern.flags ? pattern : new RegExp(pattern.source, flags);
}

function matchableLine(line: string): string {
  return line.length > MAX_AUDIT_MATCH_LINE_LENGTH
    ? line.slice(0, MAX_AUDIT_MATCH_LINE_LENGTH)
    : line;
}

function matchableContent(content: string): string {
  if (content.length <= MAX_AUDIT_MATCH_LINE_LENGTH) return content;
  return content.split('\n').map(matchableLine).join('\n');
}

// ── Markdown 围栏代码块检测 ───────────────────────────────────────────────────
// 构建一个布尔数组:lines[i] 所在行是否在 ``` 围栏代码块内(true)。
// 规则:连续三个反引号(可选语言标识符)开始围栏,相同数量的反引号关闭围栏。
// 只处理 ``` 风格(不处理 ~~~ 或缩进块),与 GitHub Markdown 行为一致。
// 标注行为:围栏开始行本身也标为 inCodeBlock,与 VSCode/GH 渲染一致。
// 此函数为纯函数,无副作用。
function buildCodeBlockMap(lines: string[]): boolean[] {
  const map: boolean[] = new Array(lines.length).fill(false);
  let inBlock = false;
  let fenceChar = '';   // 当前围栏使用的字符('`')
  let fenceLen = 0;     // 当前围栏的反引号数量(>= 3)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();

    if (!inBlock) {
      // 检测开始围栏:行首(可有 0-3 空格缩进)跟着 3 个或以上的 `
      const m = /^(`{3,})/.exec(trimmed);
      if (m) {
        inBlock = true;
        fenceChar = '`';
        fenceLen = m[1]!.length;
        map[i] = true; // 围栏开始行本身也标注
      }
    } else {
      // 在围栏内:检测关闭围栏(同字符、同数量或更多、行尾无其他内容)
      map[i] = true;
      const closeRe = new RegExp(`^${fenceChar}{${fenceLen},}\\s*$`);
      if (closeRe.test(trimmed)) {
        inBlock = false;
        fenceChar = '';
        fenceLen = 0;
      }
    }
  }
  return map;
}

export function runRules(rules: AuditRule[], targets: AuditTarget[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const compiled = rules.map((rule) => ({ rule, pattern: statelessPattern(rule.pattern) }));

  for (const target of targets) {
    const lines = target.content.split('\n');
    // 构建代码块映射(additive:仅用于给 finding 添加 inCodeBlock 标注)
    const codeBlockMap = buildCodeBlockMap(lines);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineForMatch = matchableLine(line);
      const lineNormalized = normalizeForMatch(lineForMatch);
      // 先在原始行上匹配;若原始行无命中则在归一化行上再试一次。
      // 归一化只改变同形字/全宽字符,不会把良性内容变成恶意内容。
      for (const { rule, pattern } of compiled) {
        if (!pattern.test(lineForMatch) && !pattern.test(lineNormalized)) continue;
        const finding: AuditFinding = {
          ruleId: rule.id,
          severity: rule.severity,
          file: target.file,
          line: i + 1,
          excerpt: excerpt(lineForMatch),
          message: rule.message,
        };
        // additive 标注:仅在 true 时才写 inCodeBlock 字段,保持输出最小化
        if (codeBlockMap[i]) {
          finding.inCodeBlock = true;
        }
        findings.push(finding);
      }
    }
  }
  return findings;
}

function excerpt(text: string): string {
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text;
}

export function runFileRules(fileRules: AuditFileRule[], targets: AuditTarget[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const target of targets) {
    const targetForMatch: AuditFileTarget = {
      ...target,
      content: matchableContent(target.content),
    };
    for (const rule of fileRules) {
      const match = rule.evaluate(targetForMatch);
      if (!match) continue;
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        file: target.file,
        line: match.line,
        excerpt: excerpt(match.excerpt),
        message: rule.message,
      });
    }
  }
  return findings;
}

export function auditContents(rules: AuditRule[], targets: AuditTarget[], fileRules: AuditFileRule[] = []): AuditReport {
  const findings = [...runRules(rules, targets), ...runFileRules(fileRules, targets)];
  const score = scoreFindings(findings);
  return { findings, score, verdict: verdictForScore(score) };
}
