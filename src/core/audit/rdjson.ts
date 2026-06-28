// reviewdog Diagnostic Format (rdjson) 序列化器 — 纯函数,无副作用,方便单元测试。
// 规格参考:https://github.com/reviewdog/reviewdog/blob/master/proto/rdf/reviewdog.proto
//
// 输出:JSON 对象包含 diagnostics 数组:
//   {
//     "diagnostics": [
//       {
//         "message":   "<message>",
//         "location": {
//           "path":  "<相对文件路径>",
//           "range": {
//             "start": { "line": <1-based 行号>, "column": 1 }
//           }
//         },
//         "severity": "ERROR" | "WARNING" | "INFO",
//         "code": {
//           "value": "<ruleId>",
//           "url":   "https://github.com/rtwsvj/skill-switch/wiki/rules#<ruleId>"
//         }
//       }
//     ]
//   }
//
// skill-switch severity → reviewdog severity 映射:
//   critical/high → ERROR
//   medium        → WARNING
//   low           → INFO

import type { AuditFinding, Severity } from './types.ts';

// ── reviewdog severity 映射 ───────────────────────────────────────────────────

/** skill-switch severity → reviewdog Diagnostic severity */
export function severityToRdJson(severity: Severity | string): 'ERROR' | 'WARNING' | 'INFO' {
  if (severity === 'critical' || severity === 'high') return 'ERROR';
  if (severity === 'medium') return 'WARNING';
  return 'INFO'; // low 及未知值
}

// ── reviewdog Diagnostic 类型 ─────────────────────────────────────────────────

export interface RdJsonPosition {
  line: number;
  column: number;
}

export interface RdJsonRange {
  start: RdJsonPosition;
}

export interface RdJsonLocation {
  path: string;
  range: RdJsonRange;
}

export interface RdJsonCode {
  value: string;
  url: string;
}

export interface RdJsonDiagnostic {
  message: string;
  location: RdJsonLocation;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  code: RdJsonCode;
}

export interface RdJsonDocument {
  diagnostics: RdJsonDiagnostic[];
}

// ── 规则 URL 生成 ─────────────────────────────────────────────────────────────

/** ruleId → Wiki 链接(将 / 替换为 - 以兼容 URL 片段) */
function ruleUrl(ruleId: string): string {
  const anchor = ruleId.replace(/\//g, '-');
  return `https://github.com/rtwsvj/skill-switch/wiki/rules#${anchor}`;
}

// ── 核心序列化函数 ────────────────────────────────────────────────────────────

/**
 * 将 audit finding 列表序列化为 reviewdog Diagnostic Format 文档。
 *
 * @param findings   audit 引擎产出的 finding 列表(可为空数组)
 * @returns          RdJsonDocument(diagnostics 为空列表时同样合法)
 */
export function toRdJsonDocument(findings: AuditFinding[]): RdJsonDocument {
  return {
    diagnostics: findings.map((f) => ({
      message: f.message,
      location: {
        path: f.file,
        range: {
          start: {
            line: f.line,
            column: 1,
          },
        },
      },
      severity: severityToRdJson(f.severity),
      code: {
        value: f.ruleId,
        url: ruleUrl(f.ruleId),
      },
    })),
  };
}
