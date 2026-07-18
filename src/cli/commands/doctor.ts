// S6.2 doctor 子命令:三方校验(S6.1 核心)的 CLI 包装。
// --ci:漂移即 exit 1(skills.lock 进流水线的价值兑现点);默认模式只报告不改退出码。
// R20-b:追加配置安全 advisory 段落(auditConfigFiles 结果);不影响默认退出码。
// P3-D5:--fix 对检出漂移执行自修复(写前先快照):
//   content-drift → 从 source 重铺;extra-locked → 清孤儿锁;missing/stale-lock → 提示手动。
// W3:写操作日志(WAL journal)检查项——只读报告 pending/corrupt;--fix 在持锁内恢复可恢复 journal。
import type { Command } from 'commander';
import {
  checkJournal,
  fixFindings,
  fixPendingJournal,
  runDoctor,
  type JournalCheck,
} from '../../core/doctor.ts';
import { JournalRecoveryError } from '../../core/journal.ts';
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

/** W3:写操作日志检查项段落(绿/黄/红,与配置安全段风格一致)。 */
function formatJournalSection(journal: JournalCheck): string {
  const lines: string[] = ['', '写操作日志:'];
  if (journal.status === 'ok') {
    lines.push(`  ✓ ${journal.detail}`);
  } else if (journal.status === 'pending') {
    lines.push(`  ⚠ ${journal.detail}`);
  } else {
    lines.push(`  ✗ ${journal.detail}`);
  }
  return lines.join('\n');
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('声明/锁/磁盘三方一致性校验(--ci 模式漂移即 exit 1)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--ci', '漂移时以非零退出(供 CI 使用)')
    .option('--json', '机器可读 JSON 输出')
    .option('--fix', '[P3] 对漂移执行自修复(写前先快照;missing/stale-lock 只提示);恢复待处理 WAL journal')
    .action(async (options: { home?: string; ci?: boolean; json?: boolean; fix?: boolean }, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
      const report = await runDoctor(home);

      // P3-D5 + W3:--fix 模式(漂移自修复 +/或 journal 恢复)
      if (options.fix) {
        const hasDrift = !report.clean;
        const hasPendingJournal = report.journal.status === 'pending';
        const journalCorrupt = report.journal.status === 'corrupt';

        // 损坏 journal:绝不 recover,只报告红(不 crash)。
        if (journalCorrupt && !hasDrift) {
          if (options.json) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            console.log(`✓ 三方一致(声明 ${report.checked.declared} 项,锁 ${report.checked.locked} 条)`);
            console.log(formatJournalSection(report.journal));
            console.log(formatConfigAuditSection(report.configAudit));
          }
          if (options.ci && !report.clean) process.exitCode = 1;
          return;
        }

        if (hasDrift || hasPendingJournal) {
          let fixReport: Awaited<ReturnType<typeof fixFindings>> | undefined;
          let journalAfter: JournalCheck = report.journal;

          try {
            if (hasDrift) {
              // fixFindings 持 withOperationLock → 入口自动 recoverPendingJournal
              const declaration = await readDeclaration(getSkillsJsonPath(home));
              fixReport = await fixFindings(home, report.findings, declaration);
              journalAfter = await checkJournal(home);
            } else {
              // 仅 journal pending:空 withOperationLock 即可触发恢复
              journalAfter = await fixPendingJournal(home);
            }
          } catch (err) {
            // journal 损坏/预验失败:红色报告,不 crash 整个 doctor
            if (err instanceof JournalRecoveryError) {
              journalAfter = {
                status: 'corrupt',
                path: err.journalFile,
                detail:
                  `写操作日志损坏,自动恢复已停用,` +
                  `请人工检查 ${err.journalFile} 或删除该文件后用快照恢复`,
              };
            } else {
              throw err;
            }
          }

          if (options.json) {
            console.log(JSON.stringify({
              ...report,
              journal: journalAfter,
              ...(fixReport ? { fix: fixReport } : {}),
            }, null, 2));
          } else if (hasDrift) {
            if (fixReport) {
              console.log(`✗ 检出 ${report.findings.length} 处漂移,已尝试修复:`);
              for (const r of fixReport.fixes) {
                console.log(`  [${r.status}] ${r.kind}  ${r.agent}/${r.name}`);
                console.log(`    ${r.detail}`);
              }
              if (fixReport.snapshotPaths.length > 0) {
                for (const p of fixReport.snapshotPaths) console.log(`  快照: ${p}`);
              }
            } else {
              // journal 损坏导致持锁恢复失败:漂移未动,如实报告
              console.log(`✗ 检出 ${report.findings.length} 处漂移(写操作日志损坏,未执行修复):`);
              for (const f of report.findings) {
                console.log(`  [${f.kind}] ${f.agent}/${f.name}${f.target ? `  ${f.target}` : ''}`);
                console.log(`    ${f.detail}`);
              }
            }
            console.log(formatJournalSection(journalAfter));
            console.log(formatConfigAuditSection(report.configAudit));
          } else {
            // 仅 journal 恢复(三方一致)
            console.log(`✓ 三方一致(声明 ${report.checked.declared} 项,锁 ${report.checked.locked} 条)`);
            if (journalAfter.status === 'ok' && report.journal.status === 'pending') {
              console.log(`  ✓ 已恢复中断的写操作日志${report.journal.operation ? `(${report.journal.operation})` : ''}`);
            }
            console.log(formatJournalSection(journalAfter));
            console.log(formatConfigAuditSection(report.configAudit));
          }

          if (options.ci && !report.clean) process.exitCode = 1;
          return;
        }

        // clean + journal ok:与无 --fix 行为一致(p3 测试钉死「三方一致」)
      }

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else if (report.clean) {
        console.log(`✓ 三方一致(声明 ${report.checked.declared} 项,锁 ${report.checked.locked} 条)`);
        console.log(formatJournalSection(report.journal));
        console.log(formatConfigAuditSection(report.configAudit));
      } else {
        console.log(`✗ 检出 ${report.findings.length} 处漂移:`);
        for (const f of report.findings) {
          console.log(`  [${f.kind}] ${f.agent}/${f.name}${f.target ? `  ${f.target}` : ''}`);
          console.log(`    ${f.detail}`);
        }
        console.log(formatJournalSection(report.journal));
        console.log(formatConfigAuditSection(report.configAudit));
      }

      // 退出码:仅由漂移决定(--ci);config/journal 为 advisory,不改退出码。
      if (options.ci && !report.clean) process.exitCode = 1;
    });
}
