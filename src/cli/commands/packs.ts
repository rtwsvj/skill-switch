// packs 子命令:从 Claude Code 对话用法里「发现」常一起用的 skill,组成可携带的套餐。
// 全程只读真实 transcript、只数 skill 名(不读对话正文、不出本机),只建议、用户确认才落地。
//   packs suggest        读用法 → 建议套餐(只建议)
//   packs save <id>      把某条建议固化成 pack.json(source=discovered)
//   packs show <file>    查看一个 pack.json 里有什么
import type { Command } from 'commander';
import { resolveHomeRoot } from '../../core/paths.ts';
import { analyzeCooccurrence } from '../../core/packs/cooccurrence.ts';
import {
  loadPackManifest,
  suggestionToManifest,
  writePackManifest,
} from '../../core/packs/pack-model.ts';
import { suggestPacks } from '../../core/packs/suggest.ts';

/** 从子命令向上找全局 --home。 */
function resolveHome(options: { home?: string }, command: Command): string {
  const globalHome = command.parent?.parent?.opts<{ home?: string }>()?.home;
  return resolveHomeRoot(options.home ?? globalHome);
}

/** 解析 --days,非正数报错。 */
function parseDays(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--days 需要正数,收到: ${raw}`);
  return n;
}

export function registerPacksCommand(program: Command): void {
  const packs = program
    .command('packs')
    .description('套餐:从对话用法发现常一起用的 skill,组成可携带、可分享的套餐');

  // ── packs suggest ─────────────────────────────────────────────────────────
  packs
    .command('suggest')
    .description('读你和 Claude Code 的对话(只在本机、只数 skill 名),建议把常结伴出现的 skill 存成套餐')
    .option('--days <n>', '只看最近 N 天的用法')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--json', '机器可读 JSON 输出')
    .action(async (options: { days?: string; home?: string; json?: boolean }, command: Command) => {
      const home = resolveHome(options, command);
      const days = parseDays(options.days);
      const report = await analyzeCooccurrence(home, { windowDays: days });
      const suggestions = suggestPacks(report);

      if (options.json) {
        console.log(
          JSON.stringify(
            { sessionCount: report.sessionCount, windowDays: days, suggestions },
            null,
            2,
          ),
        );
        return;
      }

      console.log(
        `分析了 ${report.sessionCount} 段对话${days ? `(最近 ${days} 天)` : ''}。`,
      );
      if (suggestions.length === 0) {
        console.log('暂无足够"老搭子"信号 —— 还没有 skill 经常一起出现(或用法太少)。');
        console.log('继续用一阵子再来,或试试 `packs suggest --days 90` 放宽窗口。');
        return;
      }
      console.log(`发现 ${suggestions.length} 个建议套餐:\n`);
      for (const s of suggestions) {
        console.log(`  📦 ${s.suggestedName}  [${s.id}]`);
        console.log(`     skills: ${s.skills.join(', ')}`);
        console.log(`     ${s.rationale}`);
        console.log(`     → 存成套餐:  skill-switch packs save ${s.id}\n`);
      }
    });

  // ── packs save <id> ───────────────────────────────────────────────────────
  packs
    .command('save')
    .description('把 `packs suggest` 里的某条建议固化成 pack.json(可携带/分享;skills 已在用,故只记录分组)')
    .argument('<id>', '建议套餐的 id(从 packs suggest 里取)')
    .option('--name <name>', '自定义套餐名(默认用建议名)')
    .option('--out <path>', '输出文件路径(默认 ./<name>.pack.json)')
    .option('--days <n>', '与 suggest 一致的窗口(确保 id 对得上)')
    .option('--home <dir>', '覆盖 home 根目录')
    .option('--json', '机器可读 JSON 输出')
    .action(
      async (
        id: string,
        options: { name?: string; out?: string; days?: string; home?: string; json?: boolean },
        command: Command,
      ) => {
        const home = resolveHome(options, command);
        const days = parseDays(options.days);
        const report = await analyzeCooccurrence(home, { windowDays: days });
        const suggestions = suggestPacks(report);
        const found = suggestions.find((s) => s.id === id);
        if (!found) {
          throw new Error(
            `找不到 id 为 ${id} 的建议套餐。先跑 \`skill-switch packs suggest\` 看可用的 id` +
              (days ? '' : '(若当时用了 --days,save 也要带同样的 --days)'),
          );
        }
        const name = options.name ?? found.suggestedName;
        const manifest = suggestionToManifest(found, {
          displayName: name,
          description: found.rationale,
        });
        manifest.name = name;
        const out = options.out ?? `./${name}.pack.json`;
        await writePackManifest(out, manifest);

        if (options.json) {
          console.log(JSON.stringify({ written: out, manifest }, null, 2));
          return;
        }
        console.log(`✓ 已写出套餐:${out}`);
        console.log(`  ${manifest.name} —— ${manifest.skills.length} 个 skill:${manifest.skills.map((s) => s.name).join(', ')}`);
        console.log('  这是一份可携带的清单,能分享给别人或在另一台机器上复用。');
      },
    );

  // ── packs show <file> ─────────────────────────────────────────────────────
  packs
    .command('show')
    .description('查看一个 pack.json 套餐清单里有什么')
    .argument('<file>', 'pack.json 路径')
    .option('--json', '机器可读 JSON 输出')
    .action(async (file: string, options: { json?: boolean }) => {
      const manifest = await loadPackManifest(file);
      if (options.json) {
        console.log(JSON.stringify(manifest, null, 2));
        return;
      }
      console.log(`📦 ${manifest.displayName ?? manifest.name}  (来源:${manifest.source})`);
      if (manifest.description) console.log(`   ${manifest.description}`);
      console.log(`   ${manifest.skills.length} 个 skill:`);
      for (const s of manifest.skills) {
        const src = s.repo ? `  ← ${s.repo}${s.commit ? `@${s.commit.slice(0, 7)}` : ''}` : '';
        console.log(`     · ${s.name}${src}`);
      }
    });
}
