// S2.5 audit 子命令:对一个 skill 目录做装前/存量安全体检。纯读。
//
// 阻断策略(严重度下限,见 docs/changes/2026-06-12-S2.4.md):
//   纯按 ags 分数带会把"单条 HIGH 的登录后门"判成 SAFE(90 分)。所以阻断判据是
//   "任意 finding 严重度 ∈ {critical, high}  OR  score < 70" → exit 1。
//   分数带(SAFE/REVIEW/DANGER)仅用于展示。
//
// v0.5-1:新增 --format sarif 输出 SARIF 2.1.0 文档(GitHub code-scanning 可用)。
//   --json 旧标志保留,行为完全不变;--format json 与其等价。
//
// v0.5-3:新增 .skill-switch-policy.json 策略文件支持。
//   --policy <path>   指定策略文件路径(默认从 cwd 查找)
//   --no-policy       忽略策略文件,使用默认行为
//   策略文件可调整 failOn(阻断严重度下限)和 suppress(按 ruleId 抑制 finding)。
//   无策略文件 / --no-policy 时行为与旧版完全一致。
//
// v0.7-1:新增基线模式(baseline mode)。
//   --write-baseline <path>  将当前所有 finding 的指纹写入基线文件,exit 0。
//   --baseline <path>        加载基线;已基线化的 finding 不计入退出码(仍出现在输出中)。
//   两者同时使用时,--write-baseline 优先(写入当前状态)。
import { readFileSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { allFileRules, allRules } from '../../../rules/index.ts';
import { auditContents, type AuditReport, type AuditTarget } from '../../core/audit/engine.ts';
import { auditConfigFiles, flattenConfigFindings, type ConfigFileResult } from '../../core/audit/config-discovery.ts';
import {
  loadPolicyFile,
  PolicyFileError,
  DEFAULT_POLICY,
  type ResolvedPolicy,
} from '../../core/audit/policy.ts';
import {
  buildBaselineFile,
  fingerprintFinding,
  loadBaselineFile,
  writeBaselineFile,
  BaselineFileError,
} from '../../core/audit/baseline.ts';
import { runGuidedFix, type GuidedFixSummary } from '../../core/audit/guided-fix.ts';
import { toGithubAnnotations } from '../../core/audit/github-annotations.ts';
import { toSarifDocument } from '../../core/audit/sarif.ts';
import { DANGER_THRESHOLD } from '../../core/audit/score.ts';
import type { AuditFinding, Severity } from '../../core/audit/types.ts';
import { resolveHomeRoot } from '../../core/paths.ts';
import { scanHome, type SkillRecord } from '../../core/scan.ts';

// 同步读取版本号;SARIF tool.driver.version 要用。失败时回退 'unknown'。
function readVersion(): string {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// 无策略时的默认阻断严重度集合(维持旧版行为)
const BLOCKING_SEVERITIES = new Set(['critical', 'high']);

// severity 排序:critical > high > medium > low(索引越小越严重)
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

// 只读文本扩展;跳过二进制资源。扩到脚本/配置/源码常见可执行文本类型。
const TEXT_EXT = new Set([
  '.md', '.txt', '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.rb', '.go', '.rs', '.java', '.php',
  '.json', '.toml', '.yaml', '.yml', '.cfg', '.conf', '.html', '.xml', '.env', '',
]);
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_AUDIT_FILES = 1000;
export const MAX_AUDIT_WALK_DEPTH = 24;

// .env / .env.* 用 extname 取不到扩展(dotfile),按文件名特判;其余按扩展名。
function isScannableFile(name: string): boolean {
  if (name === '.env' || name.startsWith('.env.')) return true;
  return TEXT_EXT.has(extname(name).toLowerCase());
}

export interface AuditCoverage {
  scannedFiles: number;
  scannedBytes: number;
  skippedFiles: number;
  skippedExtensions: string[];
  tooLargeFiles: number;
  readErrors: number;
  truncated: boolean;
  fileLimitReached: boolean;
  depthLimitReached: boolean;
  maxFiles: number;
  maxDepth: number;
  maxBytesPerFile: number;
}

export function shouldBlock(report: Pick<AuditReport, 'score' | 'findings'>): boolean {
  if (report.score < DANGER_THRESHOLD) return true;
  return report.findings.some((f) => BLOCKING_SEVERITIES.has(f.severity));
}

/**
 * 策略感知版 shouldBlock:
 * - 被抑制的 finding(ruleId 在 policy.suppressedRuleIds 中)不计入阻断决策。
 * - 已基线化的 finding(指纹在 baselinedFingerprints 中)不计入阻断决策。
 * - failOn 决定阻断的严重度下限(severity 索引 <= failOn 索引 → 阻断)。
 * - score 阈值不受策略影响(score 基于所有 findings 计算)。
 * - 传入 DEFAULT_POLICY + 空 baselinedFingerprints 时行为与 shouldBlock() 完全一致。
 */
export function shouldBlockWithPolicy(
  report: Pick<AuditReport, 'score' | 'findings'>,
  policy: ResolvedPolicy,
  baselinedFingerprints: ReadonlySet<string> = new Set(),
): boolean {
  if (report.score < DANGER_THRESHOLD) return true;
  const failOnRank = SEVERITY_RANK[policy.failOn];
  // 只看未被抑制且未基线化的 finding
  return report.findings.some(
    (f) =>
      !policy.suppressedRuleIds.has(f.ruleId) &&
      !baselinedFingerprints.has(fingerprintFinding(f)) &&
      SEVERITY_RANK[f.severity] <= failOnRank,
  );
}

/**
 * 将 finding 列表按策略标注 suppressed 字段并过滤/标记。
 * 返回每条 finding 附带 suppressed: boolean 字段。
 */
export function applyPolicyToFindings(
  findings: AuditFinding[],
  policy: ResolvedPolicy,
): Array<AuditFinding & { suppressed: boolean }> {
  return findings.map((f) => ({
    ...f,
    suppressed: policy.suppressedRuleIds.has(f.ruleId),
  }));
}

/**
 * 将 finding 列表按基线标注 baselined 字段。
 * 返回每条 finding 附带 baselined: boolean 字段。
 * 可与 applyPolicyToFindings 链式组合。
 */
export function applyBaselineToFindings(
  findings: AuditFinding[],
  baselinedFingerprints: ReadonlySet<string>,
): Array<AuditFinding & { baselined: boolean }> {
  return findings.map((f) => ({
    ...f,
    baselined: baselinedFingerprints.has(fingerprintFinding(f)),
  }));
}

/**
 * 将 finding 列表同时按策略和基线标注。
 * 返回附带 suppressed: boolean + baselined: boolean 的 finding 列表。
 */
export function applyPolicyAndBaselineToFindings(
  findings: AuditFinding[],
  policy: ResolvedPolicy,
  baselinedFingerprints: ReadonlySet<string>,
): Array<AuditFinding & { suppressed: boolean; baselined: boolean }> {
  return findings.map((f) => ({
    ...f,
    suppressed: policy.suppressedRuleIds.has(f.ruleId),
    baselined: baselinedFingerprints.has(fingerprintFinding(f)),
  }));
}

/** 默认策略文件在 cwd 的文件名 */
const POLICY_FILE_NAME = '.skill-switch-policy.json';

async function collectTextFiles(root: string): Promise<{ targets: AuditTarget[]; coverage: AuditCoverage }> {
  const targets: AuditTarget[] = [];
  const skippedExt = new Set<string>();
  let scannedBytes = 0;
  let skippedFiles = 0;
  let tooLargeFiles = 0;
  let readErrors = 0;
  let fileLimitReached = false;
  let depthLimitReached = false;

  async function readTarget(full: string, rel: string, size: number): Promise<void> {
    if (size > MAX_FILE_BYTES) {
      tooLargeFiles += 1;
      return;
    }
    try {
      targets.push({ file: rel, content: await readFile(full, 'utf8') });
      scannedBytes += size;
    } catch {
      readErrors += 1;
    }
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (targets.length >= MAX_AUDIT_FILES) {
      fileLimitReached = true;
      return;
    }
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (targets.length >= MAX_AUDIT_FILES) {
        fileLimitReached = true;
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        if (depth >= MAX_AUDIT_WALK_DEPTH) {
          depthLimitReached = true;
          continue;
        }
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (!isScannableFile(entry.name)) {
          skippedFiles += 1;
          skippedExt.add(extname(entry.name).toLowerCase() || '(none)');
          continue;
        }
        const info = await lstat(full);
        await readTarget(full, relative(root, full), info.size);
      }
    }
  }

  const info = await lstat(root);
  if (info.isFile()) {
    await readTarget(root, relative(join(root, '..'), root), info.size);
  } else if (info.isDirectory()) {
    await walk(root, 0);
  }

  return {
    targets,
    coverage: {
      scannedFiles: targets.length,
      scannedBytes,
      skippedFiles,
      skippedExtensions: [...skippedExt].sort(),
      tooLargeFiles,
      readErrors,
      truncated: fileLimitReached || depthLimitReached,
      fileLimitReached,
      depthLimitReached,
      maxFiles: MAX_AUDIT_FILES,
      maxDepth: MAX_AUDIT_WALK_DEPTH,
      maxBytesPerFile: MAX_FILE_BYTES,
    },
  };
}

export async function auditSkillDir(path: string): Promise<AuditReport & { coverage: AuditCoverage }> {
  const { targets, coverage } = await collectTextFiles(path);
  return { ...auditContents(allRules, targets, allFileRules), coverage };
}

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
    lines.push(`  [${f.severity.toUpperCase()}] ${f.ruleId}  ${f.file}:${f.line}${baselineTag}`);
    lines.push(`    ${f.message}`);
    lines.push(`    > ${f.excerpt.trim()}`);
  }
  return lines;
}

export function formatAuditReport(
  path: string,
  report: AuditReport,
  baselinedFingerprints: ReadonlySet<string> = new Set(),
): string {
  const lines: string[] = [`audit: ${path}`, `score: ${report.score}/100  verdict: ${report.verdict}`];
  if (report.findings.length === 0) {
    lines.push('findings: none');
    return lines.join('\n');
  }
  lines.push(`findings: ${report.findings.length}`, '');
  lines.push(...formatFindingLines(report.findings, baselinedFingerprints));
  return lines.join('\n');
}

export interface AuditHomeSkillReport extends AuditReport {
  name: string;
  dirName: string;
  dir: string;
  path: string;
  agents: SkillRecord['agents'];
  relSkillsDir: string;
  blocked: boolean;
  coverage: AuditCoverage;
}

export interface AuditHomeReport {
  home: string;
  total: number;
  skills: AuditHomeSkillReport[];
  /** Config file findings; populated when `includeConfigs` is true. */
  configs?: ConfigFileResult[];
  /** Whether any config finding has blocking severity. */
  configsBlocked?: boolean;
}

export async function auditHome(home: string, options: { includeConfigs?: boolean } = {}): Promise<AuditHomeReport> {
  const records = await scanHome(home);
  const uniqueRecords = new Map<string, SkillRecord>();
  for (const record of records) {
    uniqueRecords.set(dirname(record.path), record);
  }

  const skills: AuditHomeSkillReport[] = [];
  for (const [dir, record] of uniqueRecords) {
    const report = await auditSkillDir(dir);
    skills.push({
      ...report,
      name: record.name ?? record.dirName,
      dirName: record.dirName,
      dir,
      path: dir,
      agents: record.agents,
      relSkillsDir: record.relSkillsDir,
      blocked: shouldBlock(report),
    });
  }

  skills.sort((a, b) => `${a.relSkillsDir}|${a.dirName}`.localeCompare(`${b.relSkillsDir}|${b.dirName}`));

  if (!options.includeConfigs) {
    return { home, total: skills.length, skills };
  }

  const configs = await auditConfigFiles(home);
  const allConfigFindings: AuditFinding[] = flattenConfigFindings(configs);
  const configsBlocked = allConfigFindings.some((f) => BLOCKING_SEVERITIES.has(f.severity));

  return { home, total: skills.length, skills, configs, configsBlocked };
}

function formatAuditHomeTable(
  report: AuditHomeReport,
  baselinedFingerprints: ReadonlySet<string> = new Set(),
): string {
  const parts: string[] = [`audit home: ${report.home}`];

  if (report.skills.length === 0) {
    parts.push('未发现任何 skill。');
  } else {
    const header = ['NAME', 'DIR', 'SCORE', 'VERDICT', 'BLOCK'];
    const rows = report.skills.map((skill) => [
      skill.name,
      skill.dir,
      String(skill.score),
      skill.verdict,
      skill.blocked ? 'yes' : 'no',
    ]);
    const widths = header.map((h, col) => Math.max(h.length, ...rows.map((row) => row[col]!.length)));
    const renderRow = (row: string[]) => row.map((cell, col) => cell.padEnd(widths[col]!)).join('  ').trimEnd();
    parts.push(renderRow(header), ...rows.map(renderRow));
  }

  if (report.configs !== undefined) {
    parts.push('', '--- config files ---');
    if (report.configs.length === 0) {
      parts.push('no agent config files found');
    } else {
      for (const cfg of report.configs) {
        if (cfg.findings.length === 0) {
          parts.push(`${cfg.relPath}: ok`);
        } else {
          parts.push(`${cfg.relPath}: ${cfg.findings.length} finding(s)`);
          parts.push(...formatFindingLines(cfg.findings, baselinedFingerprints));
        }
      }
    }
  }

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
    if (r.kind === 'skipped-config') {
      lines.push(`  跳过(配置文件,只读): ${r.relFile}:${r.finding.line}  [${r.finding.ruleId}]`);
      continue;
    }
    if (r.kind === 'manual') {
      lines.push(`  需手动修复 (no safe auto-fix): ${r.relFile}:${r.finding.line}  [${r.finding.ruleId}]`);
      lines.push(`    ${r.finding.message}`);
      lines.push(`    > ${r.finding.excerpt.trim()}`);
      continue;
    }
    // fixable
    if (r.diffPreview === '') {
      lines.push(`  已处理(幂等,无变化): ${r.relFile}:${r.finding.line}  [${r.finding.ruleId}]`);
      continue;
    }
    if (apply) {
      lines.push(`  已修复: ${r.relFile}:${r.finding.line}  [${r.finding.ruleId}]`);
      if (r.backupPath) {
        const created = r.backupCreated ? '(新建)' : '(已存在,保留原备份)';
        lines.push(`    备份: ${r.backupPath} ${created}`);
      }
    } else {
      lines.push(`  可自动修复: ${r.relFile}:${r.finding.line}  [${r.finding.ruleId}]`);
    }
    lines.push(`    ${r.finding.message}`);
    // diff 预览缩进 4 格
    for (const dl of r.diffPreview.split('\n')) {
      lines.push(`    ${dl}`);
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

// 解析最终输出格式:--format 优先;若无 --format 但有 --json 则等价于 json。
type OutputFormat = 'human' | 'json' | 'sarif' | 'github';

function resolveFormat(options: { format?: string; json?: boolean }): OutputFormat {
  if (options.format === 'sarif') return 'sarif';
  if (options.format === 'github') return 'github';
  if (options.format === 'json' || options.json === true) return 'json';
  return 'human';
}

// ── 策略加载辅助 ─────────────────────────────────────────────────────────────

/**
 * 根据 CLI 选项加载策略。
 * - noPolicy=true → 返回 { policy: DEFAULT_POLICY, policyActive: false }
 * - 文件不存在 → { policy: DEFAULT_POLICY, policyActive: false }
 * - 文件存在且合法 → { policy: 解析结果, policyActive: true }
 * - 文件存在但损坏 → 抛 PolicyFileError
 *
 * policyActive=false 时输出格式与旧版完全一致(不附加 suppressed 字段)。
 */
async function resolvePolicy(opts: {
  noPolicy?: boolean;
  policy?: string;
}): Promise<{ policy: ResolvedPolicy; policyActive: boolean }> {
  if (opts.noPolicy) return { policy: DEFAULT_POLICY, policyActive: false };
  const filePath = opts.policy ?? join(process.cwd(), POLICY_FILE_NAME);
  const loaded = await loadPolicyFile(filePath);
  if (loaded === null) return { policy: DEFAULT_POLICY, policyActive: false };
  return { policy: loaded, policyActive: true };
}

export function registerAuditCommand(program: Command): void {
  program
    .command('audit')
    .description('对 skill 目录或 home 内全部已装 skill 做安全体检(纯读;任意 critical/high 或评分<70 → exit 1)')
    .argument('[path]', 'skill 目录或 SKILL.md 路径;省略时扫描 --home 下全部已装 skill')
    .option('--home [dir]', '启用 home 全量模式;可选覆盖 home 根目录(默认取系统 home)')
    .option('--json', '机器可读 JSON 输出(等价于 --format json;保留向后兼容)')
    .option('--format <fmt>', '输出格式:human(默认)/ json / sarif / github', 'human')
    .option('--configs', '同时审查 home 下的 agent 配置文件(settings.json / MCP 等)')
    .option('--policy <path>', '指定策略文件路径(默认: ./.skill-switch-policy.json)')
    .option('--no-policy', '忽略策略文件,使用默认阻断行为(等同于无策略文件)')
    .option('--fix', '受控引导修复(dry-run):展示每条可修复 finding 的差异预览;不写盘。加 --apply 才实际修改。')
    .option('--apply', '与 --fix 搭配:实际写盘修复,并自动生成 .skill-switch.bak 备份(已存在则不覆盖)。单独使用无效。')
    .option('--write-baseline <path>', '将当前所有 finding 的指纹写入基线文件,exit 0(与 --baseline 同时使用时本标志优先)')
    .option('--baseline <path>', '加载基线文件;已基线化的 finding 不影响退出码(仍出现在输出中)')
    .action(async (
      path: string | undefined,
      options: {
        home?: string | boolean;
        json?: boolean;
        format?: string;
        configs?: boolean;
        policy?: string;
        fix?: boolean;
        apply?: boolean;
        writeBaseline?: string;
        baseline?: string;
        // commander 将 --no-policy 映射为 options.policy === false
        // 但类型里用 noPolicy 更清晰;实际通过 options['policy'] 判断
      },
      command: Command,
    ) => {
      const fmt = resolveFormat(options);

      // 加载策略文件;损坏时打印错误并 exit 1
      let policy: ResolvedPolicy;
      let policyActive: boolean;
      try {
        // commander 的 --no-policy 会把 options.policy 置为 false(boolean)
        const noPolicyFlag = (options as Record<string, unknown>)['policy'] === false;
        ({ policy, policyActive } = await resolvePolicy({
          noPolicy: noPolicyFlag,
          policy: typeof options.policy === 'string' ? options.policy : undefined,
        }));
      } catch (err) {
        if (err instanceof PolicyFileError) {
          process.stderr.write(`audit: 策略文件错误 — ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }

      // 加载基线文件(若指定了 --baseline 且未指定 --write-baseline)
      // --write-baseline 优先:此时跳过基线加载,直接写出当前状态。
      let baselinedFingerprints: ReadonlySet<string> = new Set();
      const writeBaselinePath = options.writeBaseline;
      const baselinePath = options.baseline;
      const baselineActive = baselinePath !== undefined && writeBaselinePath === undefined;

      if (baselineActive) {
        try {
          baselinedFingerprints = await loadBaselineFile(baselinePath!);
        } catch (err) {
          if (err instanceof BaselineFileError) {
            process.stderr.write(`audit: 基线文件错误 — ${err.message}\n`);
            process.exitCode = 1;
            return;
          }
          throw err;
        }
      }

      if (path) {
        const report = await auditSkillDir(path);

        // ── --write-baseline:写出当前 finding 指纹,exit 0 ──────────────────────
        if (writeBaselinePath !== undefined) {
          const allFindings: AuditFinding[] = report.findings;
          const baseline = buildBaselineFile(allFindings);
          try {
            await writeBaselineFile(writeBaselinePath, baseline);
          } catch (err) {
            process.stderr.write(`audit: 无法写入基线文件 ${writeBaselinePath}: ${(err as Error).message}\n`);
            process.exitCode = 1;
            return;
          }
          process.stdout.write(`audit: 已写入基线 ${writeBaselinePath}(${baseline.fingerprints.length} 条 finding)\n`);
          return; // exit 0
        }

        if (fmt === 'sarif') {
          // SARIF 模式:被抑制/已基线化的 finding 写入 suppressions
          // --fix 对 SARIF 输出无影响;机器消费者通过 --format json 取修复信息。
          const doc = toSarifDocument(report.findings, readVersion(), policy.suppressedRuleIds, baselinedFingerprints);
          console.log(JSON.stringify(doc, null, 2));
        } else if (fmt === 'github') {
          // GitHub Actions 注解模式:每条 finding 输出一行工作流注解命令。
          // 被抑制/已基线化的 finding 输出为 ::notice,不触发阻断。
          // --fix 对 github 格式输出无影响(同 sarif)。
          const findings = applyPolicyAndBaselineToFindings(report.findings, policy, baselinedFingerprints);
          console.log(toGithubAnnotations(findings));
        } else if (fmt === 'json') {
          // 无策略且无基线时,输出与旧版完全一致(不含 suppressed/baselined 字段)
          const findings = (policyActive || baselineActive)
            ? applyPolicyAndBaselineToFindings(report.findings, policy, baselinedFingerprints)
            : report.findings;

          // --fix + json:先跑引导修复(dry-run 或 apply),再把摘要嵌入 JSON 对象一次性输出。
          // 无 --fix 时:不含 guidedFix 键,与旧版逐字节一致。
          if (options.fix) {
            const doApply = options.apply === true;
            const summary = await runGuidedFix({
              targetRoot: path,
              skillFindings: report.findings,
              configFindings: [],
              apply: doApply,
            });
            const guidedFix = serializeGuidedFix(summary, doApply);
            console.log(JSON.stringify({ path, ...report, findings, guidedFix }, null, 2));
          } else {
            console.log(JSON.stringify({ path, ...report, findings }, null, 2));
          }
        } else {
          // human 格式:基线化的 finding 用括号标注
          console.log(formatAuditReport(path, report, baselinedFingerprints));
        }
        if (shouldBlockWithPolicy(report, policy, baselinedFingerprints)) process.exitCode = 1;

        // --fix human 格式:打印人类可读差异预览/应用报告(原有行为不变)
        // json 格式已在上方 json 块中处理;sarif 格式 --fix 无输出。
        if (options.fix && fmt === 'human') {
          const doApply = options.apply === true;
          const summary = await runGuidedFix({
            targetRoot: path,
            skillFindings: report.findings,
            configFindings: [], // path 模式无 --configs findings
            apply: doApply,
          });
          console.log('');
          console.log(formatGuidedFixOutput(summary, doApply));
        }
        return;
      }

      const optionHome = typeof options.home === 'string' ? options.home : undefined;
      const home = resolveHomeRoot(optionHome ?? command.parent?.opts<{ home?: string }>().home);
      const report = await auditHome(home, { includeConfigs: options.configs === true });

      // ── --write-baseline(home 模式):合并所有 skill + config findings 后写出 ──
      if (writeBaselinePath !== undefined) {
        const allFindings: AuditFinding[] = [
          ...report.skills.flatMap((s) => s.findings),
          ...(report.configs ? flattenConfigFindings(report.configs) : []),
        ];
        const baseline = buildBaselineFile(allFindings);
        try {
          await writeBaselineFile(writeBaselinePath, baseline);
        } catch (err) {
          process.stderr.write(`audit: 无法写入基线文件 ${writeBaselinePath}: ${(err as Error).message}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`audit: 已写入基线 ${writeBaselinePath}(${baseline.fingerprints.length} 条 finding)\n`);
        return; // exit 0
      }

      if (fmt === 'sarif') {
        // home 全量模式:合并所有 skill findings(+ configs findings)后序列化
        const allFindings: AuditFinding[] = [
          ...report.skills.flatMap((s) => s.findings),
          ...(report.configs ? flattenConfigFindings(report.configs) : []),
        ];
        const doc = toSarifDocument(allFindings, readVersion(), policy.suppressedRuleIds, baselinedFingerprints);
        console.log(JSON.stringify(doc, null, 2));
      } else if (fmt === 'github') {
        // GitHub Actions 注解模式(home 全量):合并所有 skill + config findings 后输出注解。
        // 被抑制/已基线化的 finding 输出为 ::notice,不触发阻断。
        const allFindings: AuditFinding[] = [
          ...report.skills.flatMap((s) => s.findings),
          ...(report.configs ? flattenConfigFindings(report.configs) : []),
        ];
        const annotatedFindings = applyPolicyAndBaselineToFindings(allFindings, policy, baselinedFingerprints);
        console.log(toGithubAnnotations(annotatedFindings));
      } else if (fmt === 'json') {
        // --fix + json:对每个 skill 跑引导修复(dry-run 或 apply),结果嵌入对应 skill 的 guidedFix 字段。
        // 无 --fix 时:不含任何 guidedFix 键,与旧版逐字节一致。
        if (options.fix) {
          const doApply = options.apply === true;
          const skillConfigFindings = report.configs ? flattenConfigFindings(report.configs) : [];
          const skillsWithFix = await Promise.all(
            report.skills.map(async (skill) => {
              const summary = await runGuidedFix({
                targetRoot: skill.path,
                skillFindings: skill.findings,
                configFindings: skillConfigFindings,
                apply: doApply,
              });
              const base = (policyActive || baselineActive)
                ? {
                    ...skill,
                    findings: applyPolicyAndBaselineToFindings(skill.findings, policy, baselinedFingerprints),
                    blocked: shouldBlockWithPolicy(skill, policy, baselinedFingerprints),
                  }
                : skill;
              return { ...base, guidedFix: serializeGuidedFix(summary, doApply) };
            }),
          );
          console.log(JSON.stringify({ ...report, skills: skillsWithFix }, null, 2));
        } else if (policyActive || baselineActive) {
          // 有策略或基线:每个 skill 的 findings 附带 suppressed/baselined 字段,blocked 按策略+基线重算
          const reportWithAnnotations = {
            ...report,
            skills: report.skills.map((skill) => ({
              ...skill,
              findings: applyPolicyAndBaselineToFindings(skill.findings, policy, baselinedFingerprints),
              blocked: shouldBlockWithPolicy(skill, policy, baselinedFingerprints),
            })),
          };
          console.log(JSON.stringify(reportWithAnnotations, null, 2));
        } else {
          // 无策略且无基线:输出与旧版完全一致
          console.log(JSON.stringify(report, null, 2));
        }
      } else {
        console.log(formatAuditHomeTable(report, baselinedFingerprints));
      }

      const skillsBlocked = report.skills.some((skill) => shouldBlockWithPolicy(skill, policy, baselinedFingerprints));
      const configBlocked = report.configsBlocked === true;
      if (skillsBlocked || configBlocked) process.exitCode = 1;

      // --fix human 格式:对每个 skill 目录分别跑引导修复,打印人类可读报告。
      // json 格式已在上方 json 块中处理;sarif 格式 --fix 无输出。
      // --configs 的 finding 永远不修改(config 只读保护)。
      if (options.fix && fmt === 'human') {
        const doApply = options.apply === true;
        for (const skill of report.skills) {
          const skillConfigFindings = report.configs ? flattenConfigFindings(report.configs) : [];
          const summary = await runGuidedFix({
            targetRoot: skill.path,
            skillFindings: skill.findings,
            configFindings: skillConfigFindings,
            apply: doApply,
          });
          if (summary.results.length > 0) {
            console.log('');
            console.log(`--- ${skill.name} (${skill.path}) ---`);
            console.log(formatGuidedFixOutput(summary, doApply));
          }
        }
      }
    });
}
