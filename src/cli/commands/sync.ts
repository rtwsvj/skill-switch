// F8 sync 子命令:应用整份 skills.json 声明;dry-run 只报 plan,正常执行前快照。
// P3-D5:
//   sync --out <file>    把 planSync 结果 + 声明 sha256 序列化写盘(plan artifact)
//   sync --plan <file>   读取 plan artifact,校验声明 sha256 未变后执行
//   两者均与现有 sync / sync --dry-run 行为完全兼容。
import type { Command } from 'commander';
import { snapshotAgents } from '../../core/agent-snapshots.ts';
import { resolveHomeRoot } from '../../core/paths.ts';
import {
  applySync,
  getSkillsJsonPath,
  planSync,
  readAndVerifyPlanArtifact,
  readDeclaration,
  writePlanArtifact,
  type SyncAction,
} from '../../core/sync.ts';
import type { SnapshotInfo } from '../../core/backup.ts';
import type { AgentType } from '../../vendor/vercel-skills/types.ts';

interface SyncCliOptions {
  home?: string;
  json?: boolean;
  dryRun?: boolean;
  /** P3-D5:plan artifact 输出路径(仅 plan 模式用) */
  out?: string;
  /** P3-D5:plan artifact 输入路径(apply 从文件执行) */
  plan?: string;
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
  // 操作后汇总:非 dry-run 时打印一行完成摘要 + 下一步提示
  if (!result.dryRun) {
    const created = result.actions.filter((a) => a.kind === 'create').length;
    const removed = result.actions.filter((a) => a.kind === 'remove').length;
    const snapshotted = result.snapshots.length > 0;
    const parts: string[] = [];
    if (created > 0) parts.push(`启用 ${created}`);
    if (removed > 0) parts.push(`停用/移除 ${removed}`);
    const tally = parts.length > 0 ? parts.join('、') : '无变更';
    const snapHint = snapshotted ? '已快照;' : '';
    console.log(`✓ 同步完成:${tally}。${snapHint}跑 \`skill-switch doctor\` 校验三方一致性。`);
  }
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('应用 skills.json 声明到磁盘(--dry-run 只报告计划)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--dry-run', '只计算并输出动作,不写磁盘也不快照')
    .option('--json', '机器可读 JSON 输出')
    .option('--out <file>', '[P3] 把 plan 结果序列化写到文件(plan artifact),不执行')
    .option('--plan <file>', '[P3] 从 plan artifact 文件读取动作并执行(校验声明未变)')
    .action(async (options: SyncCliOptions, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
      const declarationPath = getSkillsJsonPath(home);

      // P3-D5:--out 模式:只做 plan 并写出 artifact,不执行任何写操作
      if (options.out) {
        const declaration = await readDeclaration(declarationPath);
        const planned = await planSync(home, declaration);
        const artifact = await writePlanArtifact(options.out, declarationPath, planned);
        if (options.json) {
          console.log(JSON.stringify({ planFile: options.out, artifact }, null, 2));
        } else {
          console.log(`plan 已写出: ${options.out}`);
          console.log(`  声明摘要: ${artifact.declarationSha256.slice(0, 16)}…`);
          console.log(`  计划动作: ${planned.length} 条`);
        }
        return;
      }

      // P3-D5:--plan 模式:读取 artifact,校验声明 sha256,直接用 artifact 中的 actions 执行
      if (options.plan) {
        const artifact = await readAndVerifyPlanArtifact(options.plan, declarationPath);
        const declaration = await readDeclaration(declarationPath);
        const planned = artifact.actions;

        const result: SyncCliResult = {
          declarationPath,
          dryRun: false,
          snapshots: [],
          actions: planned,
        };

        result.snapshots = await snapshotAgents(home, changedAgents(planned), 'pre-sync');
        // 使用 artifact 中的 actions 执行(声明文件已校验未变,重新 apply 等价)
        result.actions = (await applySync(home, declaration)).actions;

        if (options.json) console.log(JSON.stringify(result, null, 2));
        else printSyncResult(result);
        return;
      }

      // 默认:与原有行为完全一致
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
