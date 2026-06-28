// S7.1 drift 子命令:以 skills.lock 为基线的三方漂移报告。
// v2(drift-review):新增 cargo-vet 式逐条审批。
// P3-D4:新增 --osv(供应链 CVE 扫描)、--criteria(审批分级)、--upstream-summary(commit 摘要)。
//
// 退出码语义:
//   默认模式:始终 exit 0(纯报告)。
//   --ci:存在未批准漂移时 exit 1;已审批漂移不计入退出码决策。
//   --review / --approve-all:始终 exit 0(交互/批量审批)。
//
// 守则(STRICTLY ADDITIVE):
//   无 approvals 文件时行为与旧版完全相同——exit 0,列出所有漂移条目。
//   --osv 默认关闭,只有显式传入时才联网。
//   --criteria 默认不过滤,与旧版完全一致。
//   --upstream-summary 默认关闭。
//   已有测试不应受任何影响。
import * as readline from 'node:readline';
import { join } from 'node:path';
import type { Command } from 'commander';
import type { DriftEntry } from '../../core/drift.ts';
import { checkDrift } from '../../core/drift.ts';
import type { ApprovalCriteria } from '../../core/drift-approvals.ts';
import {
  approvalKey,
  driftContentHash,
  isApproved,
  loadApprovals,
  recordApproval,
} from '../../core/drift-approvals.ts';
import { buildUpstreamCommitSummary } from '../../core/diff-narrative.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir, resolveHomeRoot } from '../../core/paths.ts';

// ─── 人类可读输出 ─────────────────────────────────────────────────────────────

function label(e: DriftEntry, approved: boolean): string {
  const tag = approved ? ' (已审批)' : '';
  return `[${e.state}] ${e.agent}/${e.name}  ${e.detail}${tag}`;
}

// ─── 上游 commit 摘要(P3-D4 新增,仅 --upstream-summary 时调用) ────────────

/**
 * 对 upstream-ahead 条目生成 commit 摘要前导行。
 * 利用已安装到本地的 skill 目录作为 git 仓库目录(file:// 安装时已 clone)。
 * 若本地目录不是 git 仓库(copy 模式没有 .git),git log 会失败 → 静默返回 undefined。
 */
async function getCommitSummaryLine(home: string, e: DriftEntry): Promise<string | undefined> {
  if (e.state !== 'upstream-ahead' && e.state !== 'diverged') return undefined;
  if (!e.lockCommit || !e.upstreamCommit) return undefined;

  // 已安装的 skill 目录:可能是本地 copy(无 .git),或 symlink 指向 clone 目录
  const location = getAgentSkillsLocations().find((l) => l.agent === e.agent);
  if (!location) return undefined;
  const skillDir = join(resolveGlobalSkillsDir(home, location), e.name);

  return buildUpstreamCommitSummary(skillDir, e.lockCommit, e.upstreamCommit);
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

async function runApproveAll(
  home: string,
  entries: DriftEntry[],
  criteria?: ApprovalCriteria,
): Promise<void> {
  const toApprove = entries.filter(
    (e) => e.state !== 'in-sync' && e.state !== 'unknown',
  );
  for (const e of toApprove) {
    // eslint-disable-next-line no-await-in-loop
    await recordApproval(home, e, undefined, criteria);
  }
  console.log(`已批准 ${toApprove.length} 条漂移(--approve-all)。`);
}

// ─── 命令注册 ─────────────────────────────────────────────────────────────────

export function registerDriftCommand(program: Command): void {
  program
    .command('drift')
    .description(
      '上游 HEAD / 锁定 commit / 本地内容 三方漂移 diff(纯读报告)\n' +
      '  --ci                  未审批漂移时 exit 1\n' +
      '  --review              交互式逐条审批(cargo-vet 风格)\n' +
      '  --approve-all         非交互批量审批所有当前漂移项(CI 场景)\n' +
      '  --json                机器可读 JSON 输出(含审批状态)\n' +
      '  --criteria <level>    审批分级过滤:safe-to-run(默认) / safe-to-deploy\n' +
      '  --upstream-summary    对 upstream-ahead 漂移显示上游 commit 前导摘要(本地 git,无网络)\n' +
      '  --osv                 ⚠ 新网络出口:扫描 skill 依赖的 CVE(默认关闭,仅此 flag 触发)',
    )
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--json', '机器可读 JSON 输出')
    .option('--ci', '存在未审批漂移时以非零退出码(供 CI 使用)')
    .option('--review', '交互式逐条审批各漂移条目')
    .option('--approve-all', '非交互:批量审批所有当前漂移条目')
    .option(
      '--criteria <level>',
      '审批分级:safe-to-run(任何审批均通过)/ safe-to-deploy(仅 safe-to-deploy 审批通过)',
    )
    .option(
      '--upstream-summary',
      '对 upstream-ahead 漂移显示本地 git log 摘要(不联网)',
    )
    .option(
      '--osv',
      '⚠ 扫描 skill 目录内的依赖 CVE(POST https://api.osv.dev/v1/querybatch);默认关闭',
    )
    .action(
      async (
        options: {
          home?: string;
          json?: boolean;
          ci?: boolean;
          review?: boolean;
          approveAll?: boolean;
          criteria?: string;
          upstreamSummary?: boolean;
          osv?: boolean;
        },
        command: Command,
      ) => {
        const home = resolveHomeRoot(
          options.home ?? command.parent?.opts<{ home?: string }>().home,
        );
        const entries = await checkDrift(home);

        // 解析 --criteria(若值非法则忽略,保持向后兼容)
        const criteria: ApprovalCriteria | undefined =
          options.criteria === 'safe-to-deploy' ? 'safe-to-deploy' :
          options.criteria === 'safe-to-run' ? 'safe-to-run' :
          undefined;

        // ── --approve-all(非交互批量审批) ──────────────────────────────────
        if (options.approveAll) {
          await runApproveAll(home, entries, criteria);
          return;
        }

        // ── --review(交互式审批) ───────────────────────────────────────────
        if (options.review) {
          await runReview(home, entries);
          return;
        }

        // ── OSV 扫描(--osv,仅此 flag 触发联网) ───────────────────────────
        // ⚠ 网络出口:仅当 --osv 明确指定时才 import 并调用 osv.ts。
        if (options.osv) {
          // 动态 import 确保非 --osv 路径下完全不加载联网模块
          const { scanSkillOsv, formatOsvResults } = await import('../../core/osv.ts');
          const location = getAgentSkillsLocations();
          const osvResults = [];
          for (const e of entries) {
            const loc = location.find((l) => l.agent === e.agent);
            if (!loc) continue;
            const skillDir = join(resolveGlobalSkillsDir(home, loc), e.name);
            // eslint-disable-next-line no-await-in-loop
            const result = await scanSkillOsv(skillDir, fetch);
            osvResults.push(result);
          }
          const lines = formatOsvResults(osvResults);
          if (lines.length > 0) {
            console.log('\n=== OSV 供应链 CVE 扫描 ===');
            for (const line of lines) console.log(line);
          } else {
            console.log('[OSV] 无依赖声明文件或无已知 CVE。');
          }
        }

        // ── 普通报告模式(含 --json 和 --ci) ──────────────────────────────
        const store = await loadApprovals(home);

        if (options.json) {
          const items = entries.map((e) => ({
            ...e,
            approved: isApproved(store, e, criteria),
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
          const approved = isApproved(store, e, criteria);
          // in-sync 条目只在详细需要时才打印;漂移条目永远打印(带审批标记)
          if (e.state === 'in-sync') continue;

          // --upstream-summary:对 upstream-ahead/diverged 条目显示 commit 前导行
          if (options.upstreamSummary && (e.state === 'upstream-ahead' || e.state === 'diverged')) {
            // eslint-disable-next-line no-await-in-loop
            const summary = await getCommitSummaryLine(home, e);
            if (summary) console.log(`  ↑ ${summary}`);
          }

          console.log(label(e, approved));
          if (!approved) unapprovedCount++;
        }

        // 退出码:--ci 下仅未审批漂移计入
        if (options.ci && unapprovedCount > 0) {
          process.exitCode = 1;
        }
      },
    );
}
