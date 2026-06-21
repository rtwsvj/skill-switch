// S5.3 lint 子命令:单 skill 模式(给定路径)或 home 模式(全量 + 冲突 + 预算)。
// exit 语义:存在 error(spec error / portability error / critical conflict)→ 1;
// 仅 warning/info → 0。纯读。
import type { Command } from 'commander';
import { resolveHomeRoot } from '../../core/paths.ts';
import { lintHome, lintSkillDir, type HomeLintReport, type SkillLintResult } from '../../core/lint/lint-home.ts';
import type { LintTarget } from '../../core/lint/portability.ts';

const TARGETS: LintTarget[] = ['claude-code', 'codex', 'gemini-cli', 'cursor', 'copilot'];

function printSkill(result: SkillLintResult): void {
  if (result.specErrors.length === 0 && result.issues.length === 0) return;
  console.log(`${result.name} (${result.dir})`);
  for (const e of result.specErrors) console.log(`  [ERROR] spec: ${e}`);
  for (const i of result.issues) console.log(`  [${i.severity.toUpperCase()}] ${i.rule}: ${i.message}`);
}

function printHomeReport(report: HomeLintReport): void {
  for (const s of report.skills) printSkill(s);
  if (report.skillsJsonFindings.length > 0) {
    console.log('skills.json');
    for (const f of report.skillsJsonFindings) {
      const where = f.path ? ` (${f.path})` : '';
      console.log(`  [${f.severity.toUpperCase()}] ${f.rule}: ${f.message}${where}`);
    }
  }
  const { summary } = report.conflicts;
  console.log(`冲突: critical=${summary.critical} warning=${summary.warnings} overlap=${summary.overlapCount}`);
  for (const row of report.budget.perAgent) {
    console.log(`预算: ${row.relSkillsDir} → ${row.skillCount} skills ≈ ${row.metadataTokens} tokens 常驻 metadata`);
  }
  if (report.budget.plan) {
    const p = report.budget.plan;
    console.log(`预算: 全量加载估算 ${p.totalTokens}/${p.budget} tokens(可载 ${p.loaded},超出 ${p.skipped})`);
  }
}

export function registerLintCommand(program: Command): void {
  program
    .command('lint')
    .description('规范校验 + 跨家移植告警 + 冲突/预算健康度(error→exit 1,仅 warning→exit 0)')
    .argument('[path]', '单个 skill 目录(缺省进入 home 全量模式)')
    .option('--target <agent>', `移植目标:${TARGETS.join('|')}`, 'claude-code')
    .option('--home <dir>', '覆盖 home 根目录(home 模式)')
    .option('--budget <tokens>', '预算估算的 token 上限', '8000')
    .option('--json', '机器可读 JSON 输出')
    .action(
      async (
        path: string | undefined,
        options: { target: string; home?: string; budget: string; json?: boolean },
        command: Command,
      ) => {
        if (!TARGETS.includes(options.target as LintTarget)) {
          throw new Error(`--target 只接受 ${TARGETS.join('|')},收到: ${options.target}`);
        }
        const target = options.target as LintTarget;

        if (path) {
          const result = await lintSkillDir(path, target);
          if (options.json) console.log(JSON.stringify(result, null, 2));
          else printSkill(result);
          const hasErrors =
            result.specErrors.length > 0 || result.issues.some((i) => i.severity === 'error');
          if (hasErrors) process.exitCode = 1;
          return;
        }

        const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
        const report = await lintHome(home, target, Number(options.budget));
        if (options.json) console.log(JSON.stringify(report, null, 2));
        else printHomeReport(report);
        if (report.hasErrors) process.exitCode = 1;
      },
    );
}
