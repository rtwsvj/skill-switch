// `registry` 命令(C 线):从外部注册表只读搜索 + 经审计后安装 skill / MCP server。
//
// 安全姿态(见 docs/registry-integration-plan.md §0,不可协商):
//   - 纯 opt-in:只有运行本命令才联网;只读、HTTPS-only、零遥测(底层 fetch.ts 把关)。
//   - 装前必审:install 取到条目后,把它的来源喂给现有 add 的「解析→克隆(只读)→审计」管线
//     (previewAdd),再经 installFromSource 落盘;DANGER 默认拦截,--force + 理由 才放行。
//   - 绝不执行注册表内容里的任何命令 / 脚本(沿用 add 姿态:只抽 git 来源,从不执行)。
//
// 本文件不直接联网(经 core/registry),不 import node:http(s)/net,不引用模块 URL 元数据(SEA 安全)。
import type { Command } from 'commander';
import { previewAdd } from '../../core/add/preview.ts';
import type { SkillCandidate } from '../../core/add/types.ts';
import { installFromSource, type InstallMode } from '../../core/install.ts';
import { resolveHomeRoot } from '../../core/paths.ts';
import {
  type RegistryEntry,
  type RegistrySource,
  findEntryById,
  searchRegistries,
} from '../../core/registry/index.ts';

interface RegistryCommonOptions {
  source?: string; // mcp | marketplace
  marketplace?: string; // owner/repo
  json?: boolean;
  home?: string;
}

interface RegistryInstallOptions extends RegistryCommonOptions {
  agent?: string;
  mode?: string;
  force?: boolean;
  forceReason?: string;
  dryRun?: boolean;
}

const VERDICT_MARK: Record<SkillCandidate['verdict'], string> = {
  SAFE: '✓ 安全',
  REVIEW: '⚠ 待核',
  DANGER: '✗ 危险',
};

/** 校验 --source 值;非法即报错。 */
function parseSourceFlag(v: string | undefined): RegistrySource | undefined {
  if (v === undefined) return undefined;
  if (v === 'mcp' || v === 'marketplace') return v;
  throw new Error(`--source 只能是 mcp 或 marketplace(收到:${v})`);
}

function sourceLabel(s: RegistrySource): string {
  return s === 'mcp' ? 'MCP Registry' : 'marketplace.json';
}

function printSearchHuman(query: string, entries: RegistryEntry[], notes: string[]): void {
  console.log(`搜索「${query || '(全部)'}」:`);
  for (const n of notes) console.log(`  · ${n}`);
  if (entries.length === 0) {
    console.log('\n没有匹配的条目。');
    return;
  }
  console.log(`\n找到 ${entries.length} 条:`);
  for (const e of entries) {
    console.log(`  [${e.id}]  ${e.name}  (来源:${sourceLabel(e.source)})`);
    if (e.description) console.log(`      ${e.description}`);
    if (e.repositoryUrl) console.log(`      仓库:${e.repositoryUrl}${e.subdir ? ` (子目录 ${e.subdir})` : ''}`);
    else if (e.installHint) console.log(`      来源:${e.installHint}(类型 ${e.sourceType})`);
  }
  console.log('\n用 `skill-switch registry install <id> --agent <agent>` 安装(装前自动审计)。');
}

export function registerRegistryCommand(program: Command): void {
  const registry = program
    .command('registry')
    .description('从外部注册表只读搜索 / 经审计后安装 skill·MCP server(纯 opt-in:只在运行本命令时联网)');

  // ── registry search ───────────────────────────────────────────────────────
  registry
    .command('search')
    .description('只读搜索注册表,列出匹配条目(不写盘)')
    .argument('<query>', '搜索关键词')
    .option('--source <source>', '只查某一源:mcp | marketplace(缺省两源)')
    .option('--marketplace <owner/repo>', '要查的 marketplace 仓库(如 anthropics/skills)')
    .option('--json', '机器可读 JSON 输出')
    .action(async (query: string, options: RegistryCommonOptions) => {
      const source = parseSourceFlag(options.source);
      const result = await searchRegistries(query, {
        ...(source ? { source } : {}),
        ...(options.marketplace ? { marketplaceRepo: options.marketplace } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const notes: string[] = [];
      for (const sr of result.perSource) {
        if (sr.skipped) notes.push(`${sourceLabel(sr.source)} 已跳过:${sr.skipped}`);
        else if (sr.error) notes.push(`${sourceLabel(sr.source)} 查询出错:${sr.error}`);
        else notes.push(`${sourceLabel(sr.source)}:${sr.entries.length} 条`);
      }
      printSearchHuman(query, result.entries, notes);
    });

  // ── registry install ──────────────────────────────────────────────────────
  registry
    .command('install')
    .description('取注册表条目 → 解析来源 → 审计 → dry-run 预览或经现有安装路径落盘(绝不执行远端内容)')
    .argument('<id>', '要安装的条目 id(来自 registry search)')
    .option('--source <source>', '在哪个源里找该 id:mcp | marketplace')
    .option('--marketplace <owner/repo>', 'marketplace 源的仓库(--source marketplace 时需要)')
    .option('--agent <agent>', '安装到的目标 agent(如 claude-code);实际落盘必填')
    .option('--mode <mode>', '铺设方式:copy | symlink', 'copy')
    .option('--force', '越过 audit 拦截装危险源(自担风险,留痕)')
    .option('--force-reason <reason>', 'force 时记入 bypass 账本的理由')
    .option('--dry-run', '只取条目 + 解析 + 审计预览,绝不安装')
    .option('--json', '机器可读 JSON 输出')
    .action(async (id: string, options: RegistryInstallOptions, command: Command) => {
      const source = parseSourceFlag(options.source);
      const home = resolveHomeRoot(options.home ?? command.parent?.parent?.opts<{ home?: string }>().home);

      // 1) 取条目(用 id 当查询词,缩小返回集,再精确匹配)。
      const result = await searchRegistries(id, {
        ...(source ? { source } : {}),
        ...(options.marketplace ? { marketplaceRepo: options.marketplace } : {}),
      });
      const entry = findEntryById(result.entries, id);
      if (!entry) {
        const hint = result.perSource
          .filter((s) => s.error || s.skipped)
          .map((s) => `${sourceLabel(s.source)}:${s.error ?? s.skipped}`)
          .join(';');
        const msg = `注册表里找不到条目「${id}」。${hint ? `(${hint})` : ''}`;
        if (options.json) {
          console.log(JSON.stringify({ id, error: msg }, null, 2));
        } else {
          console.error(msg);
        }
        process.exitCode = 1;
        return;
      }

      if (!entry.installHint) {
        const msg = `条目「${id}」没有可克隆审计的来源(无仓库 URL / 无包),无法安装。`;
        if (options.json) console.log(JSON.stringify({ entry, error: msg }, null, 2));
        else console.error(msg);
        process.exitCode = 1;
        return;
      }

      // 2) 经现有 add 管线:解析来源 → 克隆(只读)→ 逐个审计。绝不执行远端内容。
      //    若条目指向某个子目录,把它拼成 GitHub /tree 链接,让 previewAdd 只审计那个子目录。
      const rawSource = buildAddSource(entry);
      const preview = await previewAdd(rawSource);

      if (preview.error) {
        if (options.json) {
          console.log(JSON.stringify({ entry, preview, error: preview.error }, null, 2));
        } else {
          console.error(`解析 / 审计来源失败:${preview.error}`);
        }
        process.exitCode = 1;
        return;
      }

      // 3) dry-run:只展示审计结果,绝不落盘。
      if (options.dryRun) {
        if (options.json) {
          console.log(JSON.stringify({ entry, preview, installed: [], note: 'dry-run' }, null, 2));
          return;
        }
        printInstallPreview(entry, preview.candidates);
        console.log('\n[dry-run] 仅审计预览,未安装。去掉 --dry-run 并加 --agent <agent> 才会落盘。');
        return;
      }

      // 4) 真正安装:需要 agent;复用 installFromSource(其内部再次审计 + 拦截 + 快照 + 写锁)。
      if (!options.agent) {
        const msg = '安装需要指定目标 agent:加 --agent <agent>(如 --agent claude-code);或用 --dry-run 只预览。';
        if (options.json) console.log(JSON.stringify({ entry, error: msg }, null, 2));
        else console.error(msg);
        process.exitCode = 1;
        return;
      }
      if (!preview.parsed.gitSource) {
        const msg = '内部错误:没有可安装的 git 来源。';
        if (options.json) console.log(JSON.stringify({ entry, error: msg }, null, 2));
        else console.error(msg);
        process.exitCode = 1;
        return;
      }

      const installResult = await installFromSource(preview.parsed.gitSource, {
        agent: options.agent as Parameters<typeof installFromSource>[1]['agent'],
        home,
        mode: (options.mode ?? 'copy') as InstallMode,
        ...(preview.parsed.ref ? { ref: preview.parsed.ref } : {}),
        ...(options.force ? { force: true } : {}),
        ...(options.forceReason ? { forceReason: options.forceReason } : {}),
        sourceLabel: `registry:${entry.source}:${entry.id}`,
      });

      if (options.json) {
        console.log(
          JSON.stringify(
            { entry, installed: installResult.installed, blocked: installResult.blocked.map((b) => ({ name: b.name, score: b.score })) },
            null,
            2,
          ),
        );
        return;
      }

      printInstallPreview(entry, preview.candidates);
      console.log('');
      if (installResult.installed.length > 0) {
        console.log(`✓ 已安装 ${installResult.installed.length} 个 skill:${installResult.installed.map((i) => i.name).join(', ')}`);
        console.log('  装前已自动审计 + 快照;跑 `skill-switch doctor` 校验。');
      }
      if (installResult.blocked.length > 0) {
        console.log(`⛔ ${installResult.blocked.length} 个因安全拦截未装:${installResult.blocked.map((b) => b.name).join(', ')}`);
        console.log('  确需安装请加 --force --force-reason "<理由>"(留痕)。');
        process.exitCode = 1;
      }
    });
}

/** 把一个条目拼成可喂 previewAdd 的来源串:有子目录就拼 GitHub /tree 链接。 */
function buildAddSource(entry: RegistryEntry): string {
  const src = entry.installHint!;
  // 仅对 github.com 的 https 仓库 + 有子目录时,拼成 /tree/<ref>/<subdir>,让审计只看该子目录。
  if (entry.subdir && /^https?:\/\/github\.com\//i.test(src)) {
    const repoPath = src.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
    return `https://github.com/${repoPath}/tree/HEAD/${entry.subdir}`;
  }
  return src;
}

function printInstallPreview(entry: RegistryEntry, candidates: SkillCandidate[]): void {
  console.log(`条目  :[${entry.id}] ${entry.name}  (来源:${entry.source})`);
  console.log(`来源  :${entry.installHint}${entry.subdir ? ` (子目录 ${entry.subdir})` : ''}`);
  if (candidates.length === 0) {
    console.log('未发现可装的 skill。');
    return;
  }
  console.log(`\n发现 ${candidates.length} 个 skill:`);
  for (const c of candidates) {
    const flag = c.blocked ? '  ⛔ 默认拦下(需 --force 才装)' : '';
    console.log(`  ${VERDICT_MARK[c.verdict]}  ${c.name}  (评分 ${c.score})${flag}`);
    for (const f of c.findings.slice(0, 4)) {
      console.log(`        · [${f.severity}] ${f.ruleId}`);
    }
  }
}
