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
      for (const { rule, pattern } of compiled) {
        if (!pattern.test(lineForMatch)) continue;
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
