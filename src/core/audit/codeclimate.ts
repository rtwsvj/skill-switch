// GitLab Code Quality JSON 序列化器 — 纯函数,无副作用,方便单元测试。
// 规格参考:https://docs.gitlab.com/ee/ci/testing/code_quality.html#implementing-a-custom-tool
//
// 输出:JSON 数组,每条 finding 对应一个对象:
//   {
//     "description":  "<message>",
//     "check_name":   "<ruleId>",
//     "fingerprint":  "<sha256 指纹(复用 baseline 方案)>",
//     "severity":     "blocker" | "critical" | "major" | "minor" | "info",
//     "location": {
//       "path":       "<相对文件路径>",
//       "lines":      { "begin": <1-based 行号> }
//     }
//   }
//
// skill-switch severity → GitLab severity 映射:
//   critical → blocker
//   high     → critical
//   medium   → major
//   low      → minor

import type { AuditFinding, Severity } from './types.ts';
import { fingerprintFinding } from './baseline.ts';

// ── GitLab severity 映射 ──────────────────────────────────────────────────────

/** skill-switch severity → GitLab Code Quality severity */
export function severityToCodeClimate(severity: Severity | string): 'blocker' | 'critical' | 'major' | 'minor' | 'info' {
  if (severity === 'critical') return 'blocker';
  if (severity === 'high') return 'critical';
  if (severity === 'medium') return 'major';
  if (severity === 'low') return 'minor';
  return 'info'; // 未知值兜底
}

// ── GitLab Code Quality 条目类型 ──────────────────────────────────────────────

export interface CodeClimateEntry {
  description: string;
  check_name: string;
  fingerprint: string;
  severity: 'blocker' | 'critical' | 'major' | 'minor' | 'info';
  location: {
    path: string;
    lines: {
      begin: number;
    };
  };
}

// ── 核心序列化函数 ────────────────────────────────────────────────────────────

/**
 * 将 audit finding 列表序列化为 GitLab Code Quality JSON 数组。
 *
 * @param findings   audit 引擎产出的 finding 列表(可为空数组)
 * @returns          CodeClimateEntry 数组(空列表 → 空数组)
 */
export function toCodeClimateEntries(findings: AuditFinding[]): CodeClimateEntry[] {
  return findings.map((f) => ({
    description: f.message,
    check_name: f.ruleId,
    fingerprint: fingerprintFinding(f),
    severity: severityToCodeClimate(f.severity),
    location: {
      path: f.file,
      lines: {
        begin: f.line,
      },
    },
  }));
}
