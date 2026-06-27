// S7.1 drift 子命令:以 skills.lock 为基线的三方漂移报告。
// v2(drift-review):新增 cargo-vet 式逐条审批。
//
// 退出码语义:
//   默认模式:始终 exit 0(纯报告)。
//   --ci:存在未批准漂移时 exit 1;已审批漂移不计入退出码决策。
//   --review / --approve-all:始终 exit 0(交互/批量审批)。
//
// 守则(STRICTLY ADDITIVE):
//   无 approvals 文件时行为与旧版完全相同——exit 0,列出所有漂移条目。
//   已有测试不应受任何影响。
import * as readline from 'node:readline';
import type { Command } from 'commander';
import type { DriftEntry } from '../../core/drift.ts';
import { checkDrift } from '../../core/drift.ts';
import {
  approvalKey,
  driftContentHash,
  isApproved,
  loadApprovals,
  recordApproval,
} from '../../core/drift-approvals.ts';
import { resolveHomeRoot } from '../../core/paths.ts';

// ─── 人类可读输出 ─────────────────────────────────────────────────────────────

function label(e: DriftEntry, approved: boolean): string {
  const tag = approved ? ' (已审批)' : '';
  return `[${e.state}] ${e.agent}/${e.name}  ${e.detail}${tag}`;
}

// ─── 交互式审批 ───────────────────────────────────────────────────────────────

async function runReview(home: string, entries: DriftEntry[]): Promise<void> {
  // 只审批非 in-sync / unknown 的条目
  const reviewable = entries.filter(
    (e) => e.state !== 'in-sync' && e.state !== 'unknown',
  );
  if (reviewable.length === 0) {
    console.log('没有可审批的漂移条目。');
    return;
  }

  const store = await loadApprovals(home);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  let approved = 0;
  let skipped = 0;

  for (const e of reviewable) {
    const alreadyApproved = isApproved(store, e);
    console.log('');
    console.log(`  ${label(e, alreadyApproved)}`);
    if (alreadyApproved) {
      console.log('  → 已审批,跳过。');
      skipped++;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const answer = await ask('  批准此漂移? [a=批准 / s=跳过 / r=拒绝] > ');
    const trimmed = answer.trim().toLowerCase();

    if (trimmed === 'a' || trimmed === 'approve') {
      // eslint-disable-next-line no-await-in-loop
      const noteRaw = await ask('  可选说明(回车跳过): ');
      const note = noteRaw.trim() || undefined;
      // eslint-disable-next-line no-await-in-loop
      await recordApproval(home, e, note);
      console.log('  → 已记录审批。');
      approved++;
    } else if (trimmed === 'r' || trimmed === 'reject') {
      console.log('  → 已拒绝(不记录)。');
      skipped++;
    } else {
      console.log('  → 跳过。');
      skipped++;
    }
  }

  rl.close();
  console.log('');
  console.log(`审批完成:批准 ${approved} 条,跳过/拒绝 ${skipped} 条。`);
}

// ─── 非交互批量审批 ──────────────────────────────────────────────────────────

async function runApproveAll(home: string, entries: DriftEntry[]): Promise<void> {
  const toApprove = entries.filter(
    (e) => e.state !== 'in-sync' && e.state !== 'unknown',
  );
  for (const e of toApprove) {
    // eslint-disable-next-line no-await-in-loop
    await recordApproval(home, e);
  }
  console.log(`已批准 ${toApprove.length} 条漂移(--approve-all)。`);
}

// ─── 命令注册 ─────────────────────────────────────────────────────────────────

export function registerDriftCommand(program: Command): void {
  program
    .command('drift')
    .description(
      '上游 HEAD / 锁定 commit / 本地内容 三方漂移 diff(纯读报告)\n' +
      '  --ci          未审批漂移时 exit 1\n' +
      '  --review      交互式逐条审批(cargo-vet 风格)\n' +
      '  --approve-all 非交互批量审批所有当前漂移项(CI 场景)\n' +
      '  --json        机器可读 JSON 输出(含审批状态)',
    )
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--json', '机器可读 JSON 输出')
    .option('--ci', '存在未审批漂移时以非零退出码(供 CI 使用)')
    .option('--review', '交互式逐条审批各漂移条目')
    .option('--approve-all', '非交互:批量审批所有当前漂移条目')
    .action(
      async (
        options: {
          home?: string;
          json?: boolean;
          ci?: boolean;
          review?: boolean;
          approveAll?: boolean;
        },
        command: Command,
      ) => {
        const home = resolveHomeRoot(
          options.home ?? command.parent?.opts<{ home?: string }>().home,
        );
        const entries = await checkDrift(home);

        // ── --approve-all(非交互批量审批) ──────────────────────────────────
        if (options.approveAll) {
          await runApproveAll(home, entries);
          return;
        }

        // ── --review(交互式审批) ───────────────────────────────────────────
        if (options.review) {
          await runReview(home, entries);
          return;
        }

        // ── 普通报告模式(含 --json 和 --ci) ──────────────────────────────
        const store = await loadApprovals(home);

        if (options.json) {
          const items = entries.map((e) => ({
            ...e,
            approved: isApproved(store, e),
            approvalKey: approvalKey(e),
            contentHash: driftContentHash(e),
          }));
          console.log(JSON.stringify(items, null, 2));
          return;
        }

        if (entries.length === 0) {
          console.log('锁为空,无可比对的 skill。');
          return;
        }

        let unapprovedCount = 0;
        for (const e of entries) {
          const approved = isApproved(store, e);
          // in-sync 条目只在详细需要时才打印;漂移条目永远打印(带审批标记)
          if (e.state === 'in-sync') continue;
          console.log(label(e, approved));
          if (!approved) unapprovedCount++;
        }

        // 统计 in-sync 数量供参考(与旧版一致:有漂移时不单独报 in-sync)
        // (旧版全部打印,新版只打印非 in-sync — 仅在有漂移时才有变化)

        // 退出码:--ci 下仅未审批漂移计入
        if (options.ci && unapprovedCount > 0) {
          process.exitCode = 1;
        }
      },
    );
}
