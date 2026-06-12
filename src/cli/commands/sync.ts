// F8 sync 子命令:应用整份 skills.json 声明;dry-run 只报 plan,正常执行前快照。
import type { Command } from 'commander';
import { snapshotAgents } from '../../core/agent-snapshots.ts';
import { resolveHomeRoot } from '../../core/paths.ts';
import {
  applySync,
  getSkillsJsonPath,
  planSync,
  readDeclaration,
  type SyncAction,
} from '../../core/sync.ts';
import type { SnapshotInfo } from '../../core/backup.ts';
import type { AgentType } from '../../vendor/vercel-skills/types.ts';

interface SyncCliOptions {
  home?: string;
  json?: boolean;
  dryRun?: boolean;
}

interface SyncCliResult {
  declarationPath: string;
  dryRun: boolean;
  snapshots: SnapshotInfo[];
  actions: SyncAction[];
}

function changedAgents(actions: SyncAction[]): AgentType[] {
  return [...new Set(actions.filter((a) => a.kind !== 'noop').map((a) => a.agent))];
}

function printSyncResult(result: SyncCliResult): void {
  const changed = result.actions.filter((a) => a.kind !== 'noop').length;
  const mode = result.dryRun ? 'dry-run' : 'applied';
  console.log(`sync ${mode}: ${changed}/${result.actions.length} actions need changes`);
  for (const action of result.actions) {
    console.log(`  [${action.kind}] ${action.agent}/${action.name}  ${action.target}`);
    if (action.reason) console.log(`    ${action.reason}`);
  }
  for (const snap of result.snapshots) {
    console.log(`  快照: ${snap.path}`);
  }
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('应用 skills.json 声明到磁盘(--dry-run 只报告计划)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--dry-run', '只计算并输出动作,不写磁盘也不快照')
    .option('--json', '机器可读 JSON 输出')
    .action(async (options: SyncCliOptions, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
      const declarationPath = getSkillsJsonPath(home);
      const declaration = await readDeclaration(declarationPath);
      const planned = await planSync(home, declaration);

      const result: SyncCliResult = {
        declarationPath,
        dryRun: Boolean(options.dryRun),
        snapshots: [],
        actions: planned,
      };

      if (!options.dryRun) {
        result.snapshots = await snapshotAgents(home, changedAgents(planned), 'pre-sync');
        result.actions = (await applySync(home, declaration)).actions;
      }

      if (options.json) console.log(JSON.stringify(result, null, 2));
      else printSyncResult(result);
    });
}
