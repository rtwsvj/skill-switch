// S2.5 audit 子命令:对一个 skill 目录做装前/存量安全体检。纯读。
//
// 阻断策略(严重度下限,见 docs/changes/2026-06-12-S2.4.md):
//   纯按 ags 分数带会把"单条 HIGH 的登录后门"判成 SAFE(90 分)。所以阻断判据是
//   "任意 finding 严重度 ∈ {critical, high}  OR  score < 70" → exit 1。
//   分数带(SAFE/REVIEW/DANGER)仅用于展示。
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import type { Command } from 'commander';
import { allFileRules, allRules } from '../../../rules/index.ts';
import { auditContents, type AuditReport, type AuditTarget } from '../../core/audit/engine.ts';
import { DANGER_THRESHOLD } from '../../core/audit/score.ts';

const BLOCKING_SEVERITIES = new Set(['critical', 'high']);

// 只读文本扩展;跳过二进制资源
const TEXT_EXT = new Set(['.md', '.txt', '.sh', '.bash', '.zsh', '.py', '.js', '.ts', '.json', '.toml', '.yaml', '.yml', '.cfg', '.conf', '']);
const MAX_FILE_BYTES = 512 * 1024;

export function shouldBlock(report: Pick<AuditReport, 'score' | 'findings'>): boolean {
  if (report.score < DANGER_THRESHOLD) return true;
  return report.findings.some((f) => BLOCKING_SEVERITIES.has(f.severity));
}

async function collectTextFiles(root: string): Promise<AuditTarget[]> {
  const targets: AuditTarget[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        await walk(full);
      } else if (entry.isFile() && TEXT_EXT.has(extname(entry.name).toLowerCase())) {
        const info = await stat(full);
        if (info.size > MAX_FILE_BYTES) continue;
        targets.push({ file: relative(root, full), content: await readFile(full, 'utf8') });
      }
    }
  }

  const info = await stat(root);
  if (info.isFile()) {
    targets.push({ file: relative(join(root, '..'), root), content: await readFile(root, 'utf8') });
  } else {
    await walk(root);
  }
  return targets;
}

export async function auditSkillDir(path: string): Promise<AuditReport> {
  const targets = await collectTextFiles(path);
  return auditContents(allRules, targets, allFileRules);
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

export function formatAuditReport(path: string, report: AuditReport): string {
  const lines: string[] = [`audit: ${path}`, `score: ${report.score}/100  verdict: ${report.verdict}`];
  if (report.findings.length === 0) {
    lines.push('findings: none');
    return lines.join('\n');
  }
  lines.push(`findings: ${report.findings.length}`, '');
  const sorted = [...report.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  for (const f of sorted) {
    lines.push(`  [${f.severity.toUpperCase()}] ${f.ruleId}  ${f.file}:${f.line}`);
    lines.push(`    ${f.message}`);
    lines.push(`    > ${f.excerpt.trim()}`);
  }
  return lines.join('\n');
}

export function registerAuditCommand(program: Command): void {
  program
    .command('audit')
    .description('对 skill 目录做安全体检(纯读;任意 critical/high 或评分<70 → exit 1)')
    .argument('<path>', 'skill 目录或 SKILL.md 路径')
    .option('--json', '机器可读 JSON 输出')
    .action(async (path: string, options: { json?: boolean }) => {
      const report = await auditSkillDir(path);
      if (options.json) {
        console.log(JSON.stringify({ path, ...report }, null, 2));
      } else {
        console.log(formatAuditReport(path, report));
      }
      if (shouldBlock(report)) process.exitCode = 1;
    });
}
