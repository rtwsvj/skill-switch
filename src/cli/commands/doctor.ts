// S6.2 doctor 子命令:三方校验(S6.1 核心)的 CLI 包装。
// --ci:漂移即 exit 1(skills.lock 进流水线的价值兑现点);默认模式只报告不改退出码。
// R20-b:追加配置安全 advisory 段落(auditConfigFiles 结果);不影响默认退出码。
// P3-D5:--fix 对检出漂移执行自修复(写前先快照):
//   content-drift → 从 source 重铺;extra-locked → 清孤儿锁;missing/stale-lock → 提示手动。
import type { Command } from 'commander';
import { fixFindings, runDoctor } from '../../core/doctor.ts';
import { getSkillsJsonPath, readDeclaration } from '../../core/sync.ts';
import { resolveHomeRoot } from '../../core/paths.ts';
import type { ConfigFileResult } from '../../core/audit/config-discovery.ts';

const BLOCKING_SEVERITIES = new Set(['critical', 'high']);

/** 把 configAudit 结果格式化成 advisory 段落(inline zh 风格,与 doctor 其余输出一致)。 */
function formatConfigAuditSection(configAudit: ConfigFileResult[]): string {
  const lines: string[] = ['', '配置安全:'];

  // 过滤出有 critical/high finding 的文件
  const criticalFiles = configAudit.filter((r) =>
    r.findings.some((f) => BLOCKING_SEVERITIES.has(f.severity)),
  );

  if (criticalFiles.length === 0) {
    lines.push('  ✓ 无配置安全问题');
    return lines.join('\n');
  }

  for (const cfg of criticalFiles) {
    const blocking = cfg.findings.filter((f) => BLOCKING_SEVERITIES.has(f.severity));
    for (const f of blocking) {
      lines.push(`  [${f.severity.toUpperCase()}] ${cfg.relPath}  ${f.ruleId}`);
      lines.push(`    ${f.message}`);
    }
  }
  lines.push('  (仅显示 critical/high;跑 `audit --configs` 查看完整报告)');

  return lines.join('\n');
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('声明/锁/磁盘三方一致性校验(--ci 模式漂移即 exit 1)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--ci', '漂移时以非零退出(供 CI 使用)')
    .option('--json', '机器可读 JSON 输出')
    .option('--fix', '[P3] 对漂移执行自修复(写前先快照;missing/stale-lock 只提示)')
    .action(async (options: { home?: string; ci?: boolean; json?: boolean; fix?: boolean }, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
      const report = await runDoctor(home);

      // P3-D5:--fix 模式
      if (options.fix && !report.clean) {
        const declaration = await readDeclaration(getSkillsJsonPath(home));
        const fixReport = await fixFindings(home, report.findings, declaration);

        if (options.json) {
          console.log(JSON.stringify({ ...report, fix: fixReport }, null, 2));
        } else {
          console.log(`✗ 检出 ${report.findings.length} 处漂移,已尝试修复:`);
          for (const r of fixReport.fixes) {
            console.log(`  [${r.status}] ${r.kind}  ${r.agent}/${r.name}`);
            console.log(`    ${r.detail}`);
          }
          if (fixReport.snapshotPaths.length > 0) {
            for (const p of fixReport.snapshotPaths) console.log(`  快照: ${p}`);
          }
          console.log(formatConfigAuditSection(report.configAudit));
        }

        if (options.ci && !report.clean) process.exitCode = 1;
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else if (report.clean) {
        console.log(`✓ 三方一致(声明 ${report.checked.declared} 项,锁 ${report.checked.locked} 条)`);
        console.log(formatConfigAuditSection(report.configAudit));
      } else {
        console.log(`✗ 检出 ${report.findings.length} 处漂移:`);
        for (const f of report.findings) {
          console.log(`  [${f.kind}] ${f.agent}/${f.name}${f.target ? `  ${f.target}` : ''}`);
          console.log(`    ${f.detail}`);
        }
        console.log(formatConfigAuditSection(report.configAudit));
      }

      // 退出码:仅由漂移决定(--ci);config findings 为 advisory,不改退出码。
      if (options.ci && !report.clean) process.exitCode = 1;
    });
}
