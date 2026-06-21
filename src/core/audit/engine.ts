// 规则引擎骨架:对目标文件内容逐行跑规则,产出 findings + 评分 + 档位。
// 纯函数:文件读取由调用方(S2.5 的 audit CLI)负责,引擎只看内容。
import { scoreFindings, verdictForScore, type Verdict } from './score.ts';
import type { AuditFileRule, AuditFileTarget, AuditFinding, AuditRule } from './types.ts';

export interface AuditTarget extends AuditFileTarget {}

export interface AuditReport {
  findings: AuditFinding[];
  score: number;
  verdict: Verdict;
}

const EXCERPT_LIMIT = 200;
export const MAX_AUDIT_MATCH_LINE_LENGTH = 2 * 1024;

// ── 同形字归一化 ──────────────────────────────────────────────────────────
// 覆盖语料中出现的关键 Cyrillic 同形字:с(U+0441)→c 等。
// NFKC 先处理全宽字符(如 ．→.)再做同形字替换。
// 仅用于规则匹配;原文保留用于 excerpt。
const HOMOGLYPH_MAP: ReadonlyMap<string, string> = new Map<string, string>([
  ['с', 'c'], // с → c (Cyrillic)
  ['е', 'e'], // е → e (Cyrillic)
  ['о', 'o'], // о → o (Cyrillic)
  ['а', 'a'], // а → a (Cyrillic)
  ['р', 'p'], // р → p (Cyrillic)
  ['х', 'x'], // х → x (Cyrillic)
  ['і', 'i'], // і → i (Cyrillic)
  ['А', 'A'], // А → A (Cyrillic)
  ['В', 'B'], // В → B (Cyrillic)
  ['С', 'C'], // С → C (Cyrillic)
  ['Е', 'E'], // Е → E (Cyrillic)
  ['М', 'M'], // М → M (Cyrillic)
  ['О', 'O'], // О → O (Cyrillic)
  ['Р', 'P'], // Р → P (Cyrillic)
  ['Т', 'T'], // Т → T (Cyrillic)
  ['Х', 'X'], // Х → X (Cyrillic)
]);

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

export function runRules(rules: AuditRule[], targets: AuditTarget[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const compiled = rules.map((rule) => ({ rule, pattern: statelessPattern(rule.pattern) }));

  for (const target of targets) {
    const lines = target.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineForMatch = matchableLine(line);
      const lineNormalized = normalizeForMatch(lineForMatch);
      // 先在原始行上匹配;若原始行无命中则在归一化行上再试一次。
      // 归一化只改变同形字/全宽字符,不会把良性内容变成恶意内容。
      for (const { rule, pattern } of compiled) {
        if (!pattern.test(lineForMatch) && !pattern.test(lineNormalized)) continue;
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          file: target.file,
          line: i + 1,
          excerpt: excerpt(lineForMatch),
          message: rule.message,
        });
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
