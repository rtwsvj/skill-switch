// S2.5 audit 子命令:对一个 skill 目录做装前/存量安全体检。纯读。
//
// 阻断策略(严重度下限,见 docs/changes/2026-06-12-S2.4.md):
//   纯按 ags 分数带会把"单条 HIGH 的登录后门"判成 SAFE(90 分)。所以阻断判据是
//   "任意 finding 严重度 ∈ {critical, high}  OR  score < 70" → exit 1。
//   分数带(SAFE/REVIEW/DANGER)仅用于展示。
//
// v0.5-1:新增 --format sarif 输出 SARIF 2.1.0 文档(GitHub code-scanning 可用)。
//   --json 旧标志保留,行为完全不变;--format json 与其等价。
import { readFileSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { allFileRules, allRules } from '../../../rules/index.ts';
import { auditContents, type AuditReport, type AuditTarget } from '../../core/audit/engine.ts';
import { auditConfigFiles, flattenConfigFindings, type ConfigFileResult } from '../../core/audit/config-discovery.ts';
import { toSarifDocument } from '../../core/audit/sarif.ts';
import { DANGER_THRESHOLD } from '../../core/audit/score.ts';
import type { AuditFinding } from '../../core/audit/types.ts';
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

const BLOCKING_SEVERITIES = new Set(['critical', 'high']);

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
 */
function formatFindingLines(findings: AuditFinding[]): string[] {
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const lines: string[] = [];
  for (const f of sorted) {
    lines.push(`  [${f.severity.toUpperCase()}] ${f.ruleId}  ${f.file}:${f.line}`);
    lines.push(`    ${f.message}`);
    lines.push(`    > ${f.excerpt.trim()}`);
  }
  return lines;
}

export function formatAuditReport(path: string, report: AuditReport): string {
  const lines: string[] = [`audit: ${path}`, `score: ${report.score}/100  verdict: ${report.verdict}`];
  if (report.findings.length === 0) {
    lines.push('findings: none');
    return lines.join('\n');
  }
  lines.push(`findings: ${report.findings.length}`, '');
  lines.push(...formatFindingLines(report.findings));
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

function formatAuditHomeTable(report: AuditHomeReport): string {
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
          parts.push(...formatFindingLines(cfg.findings));
        }
      }
    }
  }

  return parts.join('\n');
}

// 解析最终输出格式:--format 优先;若无 --format 但有 --json 则等价于 json。
type OutputFormat = 'human' | 'json' | 'sarif';

function resolveFormat(options: { format?: string; json?: boolean }): OutputFormat {
  if (options.format === 'sarif') return 'sarif';
  if (options.format === 'json' || options.json === true) return 'json';
  return 'human';
}

export function registerAuditCommand(program: Command): void {
  program
    .command('audit')
    .description('对 skill 目录或 home 内全部已装 skill 做安全体检(纯读;任意 critical/high 或评分<70 → exit 1)')
    .argument('[path]', 'skill 目录或 SKILL.md 路径;省略时扫描 --home 下全部已装 skill')
    .option('--home [dir]', '启用 home 全量模式;可选覆盖 home 根目录(默认取系统 home)')
    .option('--json', '机器可读 JSON 输出(等价于 --format json;保留向后兼容)')
    .option('--format <fmt>', '输出格式:human(默认)/ json / sarif', 'human')
    .option('--configs', '同时审查 home 下的 agent 配置文件(settings.json / MCP 等)')
    .action(async (
      path: string | undefined,
      options: { home?: string | boolean; json?: boolean; format?: string; configs?: boolean },
      command: Command,
    ) => {
      const fmt = resolveFormat(options);

      if (path) {
        const report = await auditSkillDir(path);
        if (fmt === 'sarif') {
          // SARIF 模式:将单路径 findings 序列化为 SARIF 文档输出
          const doc = toSarifDocument(report.findings, readVersion());
          console.log(JSON.stringify(doc, null, 2));
        } else if (fmt === 'json') {
          console.log(JSON.stringify({ path, ...report }, null, 2));
        } else {
          console.log(formatAuditReport(path, report));
        }
        if (shouldBlock(report)) process.exitCode = 1;
        return;
      }

      const optionHome = typeof options.home === 'string' ? options.home : undefined;
      const home = resolveHomeRoot(optionHome ?? command.parent?.opts<{ home?: string }>().home);
      const report = await auditHome(home, { includeConfigs: options.configs === true });

      if (fmt === 'sarif') {
        // home 全量模式:合并所有 skill findings(+ configs findings)后序列化
        const allFindings: AuditFinding[] = [
          ...report.skills.flatMap((s) => s.findings),
          ...(report.configs ? flattenConfigFindings(report.configs) : []),
        ];
        const doc = toSarifDocument(allFindings, readVersion());
        console.log(JSON.stringify(doc, null, 2));
      } else if (fmt === 'json') {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatAuditHomeTable(report));
      }

      const skillsBlocked = report.skills.some((skill) => skill.blocked);
      const configBlocked = report.configsBlocked === true;
      if (skillsBlocked || configBlocked) process.exitCode = 1;
    });
}
