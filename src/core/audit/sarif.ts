// SARIF 2.1.0 序列化器 — 纯函数,无副作用,方便单元测试。
// 规格参考:https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
// 只生成 GitHub code-scanning 要求的最小合法文档,不过度工程化。

import type { AuditFinding, Severity } from './types.ts';

// ── SARIF level 映射 ─────────────────────────────────────────────────────────
// critical/high → error;medium → warning;low/info → note
// 参考 GitHub SARIF 文档:error/warning/note 三级即可。
export function severityToSarifLevel(severity: Severity | string): 'error' | 'warning' | 'note' {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'note'; // low / 其他未知值都归入 note
}

// ── SARIF 最小类型定义(仅用于本模块内部,不对外暴露完整规格) ────────────────

interface SarifArtifactLocation {
  uri: string;
  uriBaseId?: string;
}

interface SarifRegion {
  startLine: number;
}

interface SarifPhysicalLocation {
  artifactLocation: SarifArtifactLocation;
  region: SarifRegion;
}

interface SarifLocation {
  physicalLocation: SarifPhysicalLocation;
}

interface SarifMessage {
  text: string;
}

interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: SarifMessage;
  locations: SarifLocation[];
}

interface SarifReportingDescriptor {
  id: string;
  defaultConfiguration: {
    level: 'error' | 'warning' | 'note';
  };
}

interface SarifToolDriver {
  name: string;
  version: string;
  rules: SarifReportingDescriptor[];
}

interface SarifTool {
  driver: SarifToolDriver;
}

interface SarifRun {
  tool: SarifTool;
  results: SarifResult[];
}

export interface SarifDocument {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}

// ── 导出:将 findings 列表序列化为 SARIF 2.1.0 文档 ─────────────────────────
/**
 * @param findings  audit 引擎产出的 finding 列表(可为空数组 → zero-result 合法文档)
 * @param toolVersion  package.json 版本号,由调用方同步读取后传入
 */
export function toSarifDocument(
  findings: AuditFinding[],
  toolVersion: string,
): SarifDocument {
  // 构建 rules[]:从 findings 中去重 ruleId,每条取其第一次出现时的 severity
  const seenRules = new Map<string, 'error' | 'warning' | 'note'>();
  for (const f of findings) {
    if (!seenRules.has(f.ruleId)) {
      seenRules.set(f.ruleId, severityToSarifLevel(f.severity));
    }
  }

  const rules: SarifReportingDescriptor[] = [...seenRules.entries()].map(([id, level]) => ({
    id,
    defaultConfiguration: { level },
  }));

  const results: SarifResult[] = findings.map((f) => ({
    ruleId: f.ruleId,
    level: severityToSarifLevel(f.severity),
    message: { text: f.message },
    locations: [
      {
        physicalLocation: {
          // uri 使用相对路径;GitHub code scanning 会根据 checkout 根解析
          artifactLocation: { uri: f.file, uriBaseId: '%SRCROOT%' },
          region: { startLine: f.line },
        },
      },
    ],
  }));

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'skill-switch',
            version: toolVersion,
            rules,
          },
        },
        results,
      },
    ],
  };
}
