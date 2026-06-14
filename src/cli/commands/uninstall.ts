// uninstall 子命令:一键卸载 skill-switch。默认删状态目录 + App + CLI 软链,
// 保留已装 skill;--purge-skills 连同声明里的 skill 一并拆除(各自先快照)。
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { resolveHomeRoot } from '../../core/paths.ts';
import {
  planUninstall,
  uninstall,
  type UninstallInput,
  type UninstallPlan,
  type UninstallResult,
} from '../../core/uninstall.ts';

const DEFAULT_APP_PATH = '/Applications/skill-switch.app';

interface UninstallCliOptions {
  purgeSkills?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  home?: string;
  json?: boolean;
}

/** 在 PATH 上找名为 skill-switch 的软链(核心还会再校验指向)。 */
async function detectBinLink(): Promise<string | null> {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, 'skill-switch');
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) return candidate;
    } catch {
      // 不存在/不可读则跳过
    }
  }
  return null;
}

async function confirmTty(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function printPlan(plan: UninstallPlan): void {
  console.error('将删除:');
  if (plan.skillSwitchDirExists) console.error(`  状态目录: ${plan.skillSwitchDir}`);
  if (plan.appPath) console.error(`  App: ${plan.appPath}`);
  if (plan.binLinkPath) console.error(`  CLI 链接: ${plan.binLinkPath}`);
  if (plan.purgeTargets.length > 0) {
    console.error('  已安装的 skill(--purge-skills,各自先快照):');
    for (const target of plan.purgeTargets) console.error(`    - ${target.agent}/${target.name}`);
  } else {
    console.error('  (保留已安装的各 skill)');
  }
  if (
    !plan.skillSwitchDirExists &&
    !plan.appPath &&
    !plan.binLinkPath &&
    plan.purgeTargets.length === 0
  ) {
    console.error('  (无可删除项)');
  }
}

function printResult(result: UninstallResult): void {
  for (const purged of result.purged) {
    console.log(`✓ 移除 ${purged.agent}/${purged.name}(快照 ${purged.snapshots[0]?.path ?? '无'})`);
  }
  if (result.removedSkillSwitchDir) console.log(`✓ 删除状态目录 ${result.plan.skillSwitchDir}`);
  if (result.removedApp) console.log(`✓ 删除 App ${result.plan.appPath}`);
  if (result.removedBinLink) console.log(`✓ 删除 CLI 链接 ${result.plan.binLinkPath}`);
  console.log('卸载完成。');
}

export function registerUninstallCommand(program: Command): void {
  program
    .command('uninstall')
    .description('一键卸载 skill-switch:删除状态目录、App、CLI 链接(--purge-skills 连同已装 skill)')
    .option('--purge-skills', '连同本软件装进各工具的 skill 一并移除(每个先快照)')
    .option('--dry-run', '只列出会删什么,不真删')
    .option('--yes', '跳过确认')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--json', '机器可读 JSON 输出')
    .action(async (options: UninstallCliOptions, command: Command) => {
      const homeOverride = options.home ?? command.parent?.opts<{ home?: string }>().home;
      const home = resolveHomeRoot(homeOverride);
      // App 与 CLI 软链是全局的(不随 home 走)。给了 --home(测试/演练)时
      // 只清该 home 的状态,绝不碰真实 /Applications 与 PATH 上的链接。
      const scopedToCustomHome = Boolean(homeOverride);
      const input: UninstallInput = {
        home,
        purgeSkills: Boolean(options.purgeSkills),
        dryRun: Boolean(options.dryRun),
        appPath: scopedToCustomHome ? null : DEFAULT_APP_PATH,
        binLinkPath: scopedToCustomHome ? null : await detectBinLink(),
      };

      const plan = await planUninstall(input);

      if (options.dryRun) {
        if (options.json) {
          console.log(JSON.stringify({ dryRun: true, plan }, null, 2));
        } else {
          printPlan(plan);
        }
        return;
      }

      if (!options.json) printPlan(plan);

      if (!options.yes) {
        if (!process.stdin.isTTY) {
          throw new Error('非交互环境需显式 --yes 才能卸载');
        }
        const confirmed = await confirmTty('确认卸载?此操作不可撤销 [y/N]: ');
        if (!confirmed) {
          console.error('已取消。');
          return;
        }
      }

      const result = await uninstall({ ...input, dryRun: false });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printResult(result);
    });
}
