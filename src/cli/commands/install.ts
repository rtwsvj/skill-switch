// S3.3 install 子命令:装前自动 audit(severity floor 拦截)+ 自动快照。
// 这是第一个会写 agent 目录的命令:写入目标完全由 --home 决定,
// 演练/测试请显式指向假目录。
import type { Command } from 'commander';
import type { AgentType } from '../../vendor/vercel-skills/types.ts';
import { installFromSource, type InstallMode } from '../../core/install.ts';
import { resolveHomeRoot } from '../../core/paths.ts';

interface InstallCliOptions {
  agent: string;
  home?: string;
  mode: string;
  skill?: string;
  ref?: string;
  force?: boolean;
  forceReason?: string;
  json?: boolean;
}

export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description('安装 skill(装前自动 audit + 快照;S3.4 起写 skills.lock)')
    .argument('<source>', 'git URL(https/file://)或本地目录')
    .requiredOption('--agent <agent>', '目标 agent(如 claude-code、gemini-cli)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--mode <mode>', '铺设方式:copy | symlink(symlink 仅限本地源)', 'copy')
    .option('--skill <name>', '只装来源中指定目录名的 skill')
    .option('--ref <ref>', 'git 来源的分支/tag(写入 skills.lock)')
    .option('--force', '越过 audit 拦截(自担风险)')
    .option('--force-reason <reason>', 'force 时记入 bypass 留痕账本的理由')
    .option('--json', '机器可读 JSON 输出')
    .action(async (source: string, options: InstallCliOptions, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
      if (options.mode !== 'copy' && options.mode !== 'symlink') {
        throw new Error(`--mode 只接受 copy|symlink,收到: ${options.mode}`);
      }
      const result = await installFromSource(source, {
        home,
        agent: options.agent as AgentType,
        mode: options.mode as InstallMode,
        skill: options.skill,
        ref: options.ref,
        force: options.force,
        forceReason: options.forceReason,
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.blocked.length > 0) {
        console.log('audit 拦截,未安装任何 skill:');
        for (const b of result.blocked) {
          console.log(`  ✗ ${b.name}  score=${b.score}  findings=${b.report.findings.length}(--force 可越过)`);
        }
      } else {
        for (const s of result.installed) console.log(`  ✓ ${s.name} → ${s.targetPath}`);
        if (result.snapshotPath) console.log(`  快照: ${result.snapshotPath}`);
        if (result.lockPath) console.log(`  锁: ${result.lockPath}`);
        if (result.declarationPath) console.log(`  声明: ${result.declarationPath}`);
        if (result.installed.length > 0) {
          console.log(`✓ 已安装 ${result.installed.length} 个 skill;跑 \`skill-switch doctor\` 校验三方一致性。`);
        }
      }
      if (result.blocked.length > 0) process.exitCode = 1;
    });
}
