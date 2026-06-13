// 文件级跨行外渗规则。源:batch-4 F13 设计约束 + ags SECURITY.md › Data Exfiltration。
// 匹配"先读高置信敏感路径,后续另一行外传"的分阶段模式;裸 `.pem`/`.key` 不算高置信。
import type { AuditFileRule, AuditFileTarget } from '../src/core/audit/types.ts';

const SECTION = 'batch-4 F13 › staged read-then-exfil';

const HIGH_CONFIDENCE_SENSITIVE_PATH =
  /(?:\bid_(?:rsa|ed25519|ecdsa|dsa)\b|~\/\.aws\/|~\/\.gnupg\/|Library\/Keychains\/|Application Support\/(?:Exodus|Atomic|Electrum|Binance|Phantom)\/|Application Support\/(?:Google\/Chrome|BraveSoftware\/Brave-Browser|Firefox)\/)/i;

const EXFIL_VERB =
  /(?:\b(?:curl|wget|nc|netcat|scp|rsync|fetch|requests\.post|axios\.post|http\.post)\b|\/dev\/tcp|\bbase64\b[^\n]*\|)/i;

function findLine(lines: string[], pattern: RegExp): { line: number; text: string } | null {
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i]!;
    if (pattern.test(text)) return { line: i + 1, text };
  }
  return null;
}

function evaluateStagedExfil(target: AuditFileTarget): { line: number; excerpt: string } | null {
  const lines = target.content.split('\n');
  const sensitive = findLine(lines, HIGH_CONFIDENCE_SENSITIVE_PATH);
  const exfil = findLine(lines, EXFIL_VERB);
  if (!sensitive || !exfil || sensitive.line === exfil.line) return null;

  return {
    line: sensitive.line,
    excerpt: `${sensitive.text.trim()} … ${exfil.text.trim()}`,
  };
}

export const stagedExfilRules: AuditFileRule[] = [
  {
    id: 'exfiltration/staged-read-exfil',
    severity: 'high',
    message: '跨行读取高置信敏感路径并在另一行执行外传动作',
    source: SECTION,
    evaluate: evaluateStagedExfil,
  },
];
