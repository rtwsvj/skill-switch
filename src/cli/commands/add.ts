// add 子命令:把一段「GitHub 链接 / git clone / npx·npm 安装指令」粘进来,
// 自动解析出 git 来源 → 克隆(只读)→ 审计 → 列出候选 skill + 安全裁决 → 选装。
//
// 安全:绝不执行粘贴的命令(curl|bash 一律拒绝);危险源(DANGER)默认不装,需 --force 显式放行。
import type { Command } from 'commander';
import { previewAdd } from '../../core/add/preview.ts';
import type { AddPreview, SkillCandidate } from '../../core/add/types.ts';
import { installFromSource, type InstallMode } from '../../core/install.ts';
import { resolveHomeRoot } from '../../core/paths.ts';

interface AddOptions {
  agent?: string;
  skill?: string[];
  all?: boolean;
  yes?: boolean;
  mode?: string;
  ref?: string;
  force?: boolean;
  forceReason?: string;
  home?: string;
  json?: boolean;
  dryRun?: boolean;
}

const VERDICT_MARK: Record<SkillCandidate['verdict'], string> = {
  SAFE: '✓ 安全',
  REVIEW: '⚠ 待核',
  DANGER: '✗ 危险',
};

function printPreview(preview: AddPreview): void {
  const { parsed, candidates } = preview;
  console.log(`来源类型:${parsed.kind}`);
  if (parsed.gitSource) console.log(`git 源  :${parsed.gitSource}${parsed.ref ? ` @${parsed.ref}` : ''}`);
  if (parsed.subdir) console.log(`子目录  :${parsed.subdir}`);
  if (parsed.provenanceWarning) console.log(`⚠ ${parsed.provenanceWarning}`);
  if (candidates.length === 0) return;
  console.log(`\n发现 ${candidates.length} 个 skill:`);
  for (const c of candidates) {
    const flag = c.blocked ? '  ⛔ 默认拦下(需 --force 才装)' : '';
    console.log(`  ${VERDICT_MARK[c.verdict]}  ${c.name}  (评分 ${c.score})${flag}`);
    for (const f of c.findings.slice(0, 4)) {
      console.log(`        · [${f.severity}] ${f.ruleId}`);
    }
  }
}

/** 决定要安装哪些候选。返回选中的 name 列表;空 = 不安装(仅预览)。 */
function decideSelection(candidates: SkillCandidate[], options: AddOptions): string[] {
  const names = new Set(candidates.map((c) => c.name));
  if (options.skill && options.skill.length > 0) {
    const unknown = options.skill.filter((s) => !names.has(s));
    if (unknown.length > 0) {
      throw new Error(`来源里没有这些 skill:${unknown.join(', ')}`);
    }
    return options.skill;
  }
  if (options.all) return candidates.map((c) => c.name);
  if (options.yes) return candidates.filter((c) => !c.blocked).map((c) => c.name);
  // 无显式选择:只有恰好一个「非拦下」候选时,一键装它;否则不自动装(避免批量惊喜)。
  const installable = candidates.filter((c) => !c.blocked);
  if (installable.length === 1) return [installable[0]!.name];
  return [];
}

export function registerAddCommand(program: Command): void {
  program
    .command('add')
    .description('粘贴 GitHub 链接 / git clone / npx·npm 指令 → 自动解析、审计、安装(绝不执行粘贴的命令)')
    .argument('<source...>', '粘贴的链接或安装指令(可含空格,如 git clone <url>)')
    .option('--agent <agent>', '安装到的目标 agent(如 claude-code、gemini-cli)')
    .option('--skill <name>', '只装指定名字的 skill(可重复)', (v: string, acc: string[] = []) => [...acc, v])
    .option('--all', '安装来源里全部 skill(危险项仍需 --force)')
    .option('--yes', '安装全部「非拦下」的 skill(跳过逐个确认)')
    .option('--mode <mode>', '铺设方式:copy | symlink', 'copy')
    .option('--ref <ref>', '覆盖 git 分支/tag')
    .option('--force', '越过 audit 拦截装危险源(自担风险,留痕)')
    .option('--force-reason <reason>', 'force 时记入 bypass 账本的理由')
    .option('--home <dir>', '覆盖 home 根目录')
    .option('--dry-run', '只解析+审计预览,绝不安装')
    .option('--json', '机器可读 JSON 输出')
    .action(async (source: string[], options: AddOptions, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
      const raw = source.join(' ');
      const preview = await previewAdd(raw);

      // 预览有错(unsupported / 克隆失败 / 没有 skill)→ 报错退出
      if (preview.error) {
        if (options.json) {
          console.log(JSON.stringify({ preview, installed: [], error: preview.error }, null, 2));
        } else {
          printPreview(preview);
          console.error(`\n错误: ${preview.error}`);
        }
        process.exitCode = 1;
        return;
      }

      const selected = options.dryRun ? [] : decideSelection(preview.candidates, options);

      // 仅预览(dry-run,或多候选未选)
      if (selected.length === 0) {
        if (options.json) {
          console.log(JSON.stringify({ preview, installed: [], note: 'preview-only' }, null, 2));
          return;
        }
        printPreview(preview);
        if (options.dryRun) return;
        if (preview.candidates.filter((c) => !c.blocked).length !== 1) {
          console.log('\n有多个可装的 skill —— 用 `--skill <名>`(可重复)/`--all`/`--yes` 选择要装哪些。');
        }
        return;
      }

      // 要安装 → 需要 agent
      if (!options.agent) {
        throw new Error('安装需要指定目标 agent:加 --agent <agent>(如 --agent claude-code)');
      }
      if (!preview.parsed.gitSource) {
        throw new Error('内部错误:没有可安装的 git 来源');
      }

      const installedAll: Array<{ name: string; targetPath: string }> = [];
      const blockedAll: Array<{ name: string; score: number }> = [];
      for (const name of selected) {
        const result = await installFromSource(preview.parsed.gitSource, {
          agent: options.agent as Parameters<typeof installFromSource>[1]['agent'],
          home,
          mode: (options.mode ?? 'copy') as InstallMode,
          skill: name,
          ...(preview.parsed.ref ? { ref: preview.parsed.ref } : {}),
          ...(options.force ? { force: true } : {}),
          ...(options.forceReason ? { forceReason: options.forceReason } : {}),
          sourceLabel: preview.parsed.gitSource,
        });
        installedAll.push(...result.installed);
        if (result.blocked) blockedAll.push(...result.blocked.map((b) => ({ name: b.name, score: b.score })));
      }

      if (options.json) {
        console.log(JSON.stringify({ preview, installed: installedAll, blocked: blockedAll }, null, 2));
        return;
      }
      printPreview(preview);
      console.log('');
      if (installedAll.length > 0) {
        console.log(`✓ 已安装 ${installedAll.length} 个 skill:${installedAll.map((i) => i.name).join(', ')}`);
        console.log('  装前已自动审计 + 快照;跑 `skill-switch doctor` 校验。');
      }
      if (blockedAll.length > 0) {
        console.log(`⛔ ${blockedAll.length} 个因安全拦截未装:${blockedAll.map((b) => b.name).join(', ')}`);
        console.log('  确需安装请加 --force --force-reason "<理由>"(留痕)。');
        process.exitCode = 1;
      }
    });
}
