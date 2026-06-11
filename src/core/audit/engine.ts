// 规则引擎骨架:对目标文件内容逐行跑规则,产出 findings + 评分 + 档位。
// 纯函数:文件读取由调用方(S2.5 的 audit CLI)负责,引擎只看内容。
import { scoreFindings, verdictForScore, type Verdict } from './score.ts';
import type { AuditFinding, AuditRule } from './types.ts';

export interface AuditTarget {
  /** 展示用文件路径(相对 skill 根) */
  file: string;
  content: string;
}

export interface AuditReport {
  findings: AuditFinding[];
  score: number;
  verdict: Verdict;
}

const EXCERPT_LIMIT = 200;

/** 剥离 g/y 标志:有状态的 lastIndex 会让同一规则跨行漏报。 */
function statelessPattern(pattern: RegExp): RegExp {
  const flags = pattern.flags.replace(/[gy]/g, '');
  return flags === pattern.flags ? pattern : new RegExp(pattern.source, flags);
}

export function runRules(rules: AuditRule[], targets: AuditTarget[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const compiled = rules.map((rule) => ({ rule, pattern: statelessPattern(rule.pattern) }));

  for (const target of targets) {
    const lines = target.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const { rule, pattern } of compiled) {
        if (!pattern.test(line)) continue;
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          file: target.file,
          line: i + 1,
          excerpt: line.length > EXCERPT_LIMIT ? `${line.slice(0, EXCERPT_LIMIT)}…` : line,
          message: rule.message,
        });
      }
    }
  }
  return findings;
}

export function auditContents(rules: AuditRule[], targets: AuditTarget[]): AuditReport {
  const findings = runRules(rules, targets);
  const score = scoreFindings(findings);
  return { findings, score, verdict: verdictForScore(score) };
}
