// 从 audit.ts 机械拆出(2026-07-16),行为零变化。
// 人类可读格式化:findings 行渲染、致命三要素摘要、audit 报告/home 表、引导式修复输出。
//
// 原 audit.ts 相关说明:
// v0.5-1:新增 --format sarif 输出 SARIF 2.1.0 文档(GitHub code-scanning 可用)。
//   --json 旧标志保留,行为完全不变;--format json 与其等价。
import type { AuditReport } from '../../core/audit/engine.ts';
import { fingerprintFinding } from '../../core/audit/baseline.ts';
import type { GuidedFixSummary } from '../../core/audit/guided-fix.ts';
import type { AuditFinding } from '../../core/audit/types.ts';
import type { AuditCoverage, AuditHomeReport } from '../../core/audit/service.ts';
import { sanitizeOutputText } from '../../core/security/output-safety.ts';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

/**
 * 将 findings 列表按严重度排序后格式化为缩进文本行。
 * 供 formatAuditReport 和 formatAuditHomeTable 共用,避免重复实现渲染逻辑。
 * baselinedFingerprints 非空时,已基线化的 finding 追加"（基线已接受）"标注。
 */
function formatFindingLines(
  findings: AuditFinding[],
  baselinedFingerprints: ReadonlySet<string> = new Set(),
): string[] {
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const needsBaseline = baselinedFingerprints.size > 0;
  const lines: string[] = [];
  for (const f of sorted) {
    const baselineTag = needsBaseline && baselinedFingerprints.has(fingerprintFinding(f))
      ? '  （基线已接受）'
      : '';
    lines.push(
      `  [${f.severity.toUpperCase()}] ${sanitizeOutputText(f.ruleId)}  ${sanitizeOutputText(f.file)}:${f.line}${baselineTag}`,
    );
    lines.push(`    ${sanitizeOutputText(f.message)}`);
    lines.push(`    > ${sanitizeOutputText(f.excerpt.trim())}`);
  }
  return lines;
}

// ── 致命三要素人类可读摘要 ───────────────────────────────────────────────────
//
// 仅在 human 格式下、且至少有一条 `agentic/lethal-trifecta` finding 时,
// 在输出末尾追加一行提示。该 finding 已是 medium(advisory)且 report-only,
// 摘要只是把它的存在直观化,不改退出码、不改 --json / SARIF 结构。
// 路径模式按 finding 计数;home 模式按受影响 skill 计数。

const LETHAL_TRIFECTA_RULE_ID = 'agentic/lethal-trifecta';

/** path 模式:按本报告 findings 内 trifecta 数生成单行摘要,无则返回 null。 */
function lethalTrifectaSummaryForFindings(findings: AuditFinding[]): string | null {
  const count = findings.filter((f) => f.ruleId === LETHAL_TRIFECTA_RULE_ID).length;
  if (count === 0) return null;
  return `⚠ 致命三要素:此 skill 同时具备三种能力(读私有数据 + 摄入不可信内容 + 对外发送),一段被投毒的内容就可能诱导它把你的数据带出去。建议移除其中任一能力(架构边界隔离)。`;
}

/** home 模式:按受影响 skill 数生成单行摘要,无则返回 null。 */
function lethalTrifectaSummaryForHome(report: AuditHomeReport): string | null {
  const affected = report.skills.filter((s) =>
    s.findings.some((f) => f.ruleId === LETHAL_TRIFECTA_RULE_ID),
  ).length;
  if (affected === 0) return null;
  return `⚠ 致命三要素:${affected} 个 skill 同时具备三种能力(读私有数据 + 摄入不可信内容 + 对外发送),建议移除其中任一能力(架构边界隔离)。`;
}

export function formatAuditReport(
  path: string,
  report: AuditReport & { coverage?: AuditCoverage },
  baselinedFingerprints: ReadonlySet<string> = new Set(),
): string {
  const lines: string[] = [
    `audit: ${sanitizeOutputText(path)}`,
    `score: ${report.score}/100  verdict: ${report.verdict}`,
  ];
  if (report.coverage) {
    const coverage = report.coverage;
    const status = coverage.complete ? 'complete' : 'INCOMPLETE (blocks by default)';
    const reasons = coverage.complete ? '' : `  reasons: ${coverage.incompleteReasons.join(', ')}`;
    lines.push(
      `coverage: ${status}  scanned: ${coverage.scannedFiles}/${coverage.visitedFiles} files  bytes: ${coverage.scannedBytes}${reasons}`,
    );
  }
  if (report.findings.length === 0) {
    lines.push('findings: none');
    return lines.join('\n');
  }
  lines.push(`findings: ${report.findings.length}`, '');
  lines.push(...formatFindingLines(report.findings, baselinedFingerprints));
  const trifecta = lethalTrifectaSummaryForFindings(report.findings);
  if (trifecta !== null) lines.push('', trifecta);
  return lines.join('\n');
}


export function formatAuditHomeTable(
  report: AuditHomeReport,
  baselinedFingerprints: ReadonlySet<string> = new Set(),
): string {
  const parts: string[] = [`audit home: ${sanitizeOutputText(report.home)}`];

  if (report.skills.length === 0) {
    parts.push('未发现任何 skill。');
  } else {
    const header = ['NAME', 'DIR', 'SCORE', 'VERDICT', 'COVERAGE', 'BLOCK'];
    const rows = report.skills.map((skill) => [
      sanitizeOutputText(skill.name),
      sanitizeOutputText(skill.dir),
      String(skill.score),
      skill.verdict,
      skill.coverage.complete ? 'complete' : 'INCOMPLETE',
      skill.blocked ? 'yes' : 'no',
    ]);
    const widths = header.map((h, col) => Math.max(h.length, ...rows.map((row) => row[col]!.length)));
    const renderRow = (row: string[]) => row.map((cell, col) => cell.padEnd(widths[col]!)).join('  ').trimEnd();
    parts.push(renderRow(header), ...rows.map(renderRow));

    const incompleteSkills = report.skills.filter((skill) => !skill.coverage.complete);
    if (incompleteSkills.length > 0) {
      parts.push('', '--- incomplete audit coverage ---');
      for (const skill of incompleteSkills) {
        parts.push(
          `${sanitizeOutputText(skill.name)}: ${skill.coverage.incompleteReasons.join(', ')}`,
        );
      }
    }
  }

  if (report.configs !== undefined) {
    parts.push('', '--- config files ---');
    if (report.configs.length === 0) {
      parts.push('no agent config files found');
    } else {
      for (const cfg of report.configs) {
        if (cfg.findings.length === 0) {
          parts.push(`${sanitizeOutputText(cfg.relPath)}: ok`);
        } else {
          parts.push(`${sanitizeOutputText(cfg.relPath)}: ${cfg.findings.length} finding(s)`);
          parts.push(...formatFindingLines(cfg.findings, baselinedFingerprints));
        }
      }
    }
  }

  if (report.crossSkillFindings && report.crossSkillFindings.length > 0) {
    parts.push('', '--- cross-skill collusion(跨-skill 协同攻击)---');
    parts.push(`${report.crossSkillFindings.length} finding(s)`);
    parts.push(...formatFindingLines(report.crossSkillFindings, baselinedFingerprints));
  }

  // 致命三要素人类可读摘要(末尾追加,仅在有命中时出现)。结构纯 additive,
  // 不影响 --json / SARIF,不影响退出码。
  const trifecta = lethalTrifectaSummaryForHome(report);
  if (trifecta !== null) parts.push('', trifecta);

  return parts.join('\n');
}

// ── 引导式修复输出格式化 ──────────────────────────────────────────────────────

/**
 * 把 GuidedFixSummary 格式化为人类可读的文本块。
 * dry-run 时展示 diff 预览;apply 时显示已写盘的文件与备份路径。
 */
export function formatGuidedFixOutput(summary: GuidedFixSummary, apply: boolean): string {
  const lines: string[] = [];

  if (apply) {
    lines.push(`[guided-fix] 模式:apply(实际写盘)`);
  } else {
    lines.push(`[guided-fix] 模式:dry-run(预览;加 --apply 才写盘)`);
  }

  for (const r of summary.results) {
    const safeRelFile = sanitizeOutputText(r.relFile);
    const safeRuleId = sanitizeOutputText(r.finding.ruleId);
    const safeMessage = sanitizeOutputText(r.finding.message);
    if (r.kind === 'skipped-config') {
      lines.push(`  跳过(配置文件,只读): ${safeRelFile}:${r.finding.line}  [${safeRuleId}]`);
      continue;
    }
    if (r.kind === 'manual') {
      lines.push(`  需手动修复 (no safe auto-fix): ${safeRelFile}:${r.finding.line}  [${safeRuleId}]`);
      lines.push(`    ${safeMessage}`);
      lines.push(`    > ${sanitizeOutputText(r.finding.excerpt.trim())}`);
      continue;
    }
    // fixable
    if (r.diffPreview === '') {
      lines.push(`  已处理(幂等,无变化): ${safeRelFile}:${r.finding.line}  [${safeRuleId}]`);
      continue;
    }
    if (apply) {
      lines.push(`  已修复: ${safeRelFile}:${r.finding.line}  [${safeRuleId}]`);
      if (r.backupPath) {
        const created = r.backupCreated ? '(新建)' : '(已存在,保留原备份)';
        lines.push(`    备份: ${sanitizeOutputText(r.backupPath)} ${created}`);
      }
    } else {
      lines.push(`  可自动修复: ${safeRelFile}:${r.finding.line}  [${safeRuleId}]`);
    }
    lines.push(`    ${safeMessage}`);
    // diff 预览缩进 4 格
    for (const dl of r.diffPreview.split('\n')) {
      lines.push(`    ${sanitizeOutputText(dl)}`);
    }
  }

  lines.push('');
  if (apply) {
    lines.push(`已修改 ${summary.filesModified} 个文件,修复 ${summary.fixableCount} 条 finding,${summary.manualCount} 条需手动复核。`);
  } else {
    lines.push(`可自动修复: ${summary.fixableCount} 条;需手动复核: ${summary.manualCount} 条;config 文件跳过: ${summary.configSkipCount} 条。`);
  }
  if (summary.configSkipCount > 0) {
    lines.push(`注意:--configs 发现的 ${summary.configSkipCount} 条 config finding 永远不会被 --fix 修改(只读保护)。`);
  }

  return lines.join('\n');
}

// ── 引导式修复 JSON 序列化 ────────────────────────────────────────────────────

/**
 * GuidedFixEntry:单条 finding 的机器可读修复信息。
 * 稳定 schema——CI 脚本可依赖此结构。
 */
export interface GuidedFixEntry {
  /** 触发此 finding 的规则 ID */
  ruleId: string;
  /** finding 所在的相对文件路径(相对 audit 根目录) */
  file: string;
  /** finding 所在的行号(1-based) */
  line: number;
  /** 修复分类:'fixable'=有自动修复器;'manual'=需人工处理;'skipped-config'=config 文件,永远只读 */
  kind: 'fixable' | 'manual' | 'skipped-config';
  /** finding 是否被当前策略抑制(当策略激活时由 CI 读取;未传入策略时不含此字段) */
  suppressed?: boolean;
  /** apply 模式且实际写盘后为 true;dry-run 或未修改则为 false */
  applied: boolean;
  /** apply 模式且写盘成功时备份文件的绝对路径 */
  backupPath?: string;
  /** unified diff 预览字符串;幂等(已处理)或无 diff 时为空字符串 */
  diff?: string;
}

/**
 * GuidedFixJsonSection:嵌入 JSON 报告的顶层 guidedFix 对象。
 */
export interface GuidedFixJsonSection {
  /** 干运行还是实际写盘 */
  mode: 'dry-run' | 'apply';
  /** 每条 finding 的修复条目 */
  entries: GuidedFixEntry[];
  /** 合计:有自动修复器的 finding 数(含幂等) */
  fixableCount: number;
  /** 合计:需手动处理的 finding 数 */
  manualCount: number;
  /** 合计:因来自 config 文件而跳过的 finding 数 */
  configSkipCount: number;
  /** apply 模式下实际修改的文件数;dry-run 时恒为 0 */
  filesModified: number;
}

/**
 * 把 GuidedFixSummary 转换为可稳定序列化的 GuidedFixJsonSection。
 * 此函数为纯函数(无副作用),供 path 模式与 home 模式共用。
 */
export function serializeGuidedFix(
  summary: GuidedFixSummary,
  apply: boolean,
): GuidedFixJsonSection {
  const entries: GuidedFixEntry[] = summary.results.map((r) => {
    if (r.kind === 'skipped-config') {
      return {
        ruleId: r.finding.ruleId,
        file: r.relFile,
        line: r.finding.line,
        kind: 'skipped-config' as const,
        applied: false,
      };
    }
    if (r.kind === 'manual') {
      return {
        ruleId: r.finding.ruleId,
        file: r.relFile,
        line: r.finding.line,
        kind: 'manual' as const,
        applied: false,
      };
    }
    // fixable
    const entry: GuidedFixEntry = {
      ruleId: r.finding.ruleId,
      file: r.relFile,
      line: r.finding.line,
      kind: 'fixable' as const,
      applied: apply && r.diffPreview !== '' && r.backupPath !== undefined,
      diff: r.diffPreview,
    };
    if (r.backupPath !== undefined) {
      entry.backupPath = r.backupPath;
    }
    return entry;
  });

  return {
    mode: apply ? 'apply' : 'dry-run',
    entries,
    fixableCount: summary.fixableCount,
    manualCount: summary.manualCount,
    configSkipCount: summary.configSkipCount,
    filesModified: summary.filesModified,
  };
}
