// packs 子命令:从 Claude Code 对话用法里「发现」常一起用的 skill,组成可携带的套餐。
// 全程只读真实 transcript、只数 skill 名(不读对话正文、不出本机),只建议、用户确认才落地。
//   packs suggest        读用法 → 建议套餐(只建议)
//   packs save <id>      把某条建议固化成 pack.json(source=discovered)
//   packs save --enrich  写出时从 skills.lock.json 回填来源(repo/commit/ref)
//   packs show <file>    查看一个 pack.json 里有什么
//   packs install <file> 安装套餐里所有 skill(reuse installFromSource)
//   packs list [dir]     列出目录下的 *.pack.json
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { AgentType } from '../../vendor/vercel-skills/types.ts';
import { resolveHomeRoot } from '../../core/paths.ts';
import { analyzeCooccurrence } from '../../core/packs/cooccurrence.ts';
import {
  loadPackManifest,
  suggestionToManifest,
  writePackManifest,
} from '../../core/packs/pack-model.ts';
import { suggestPacks } from '../../core/packs/suggest.ts';
import { getSkillsLockPath, readSkillsLock } from '../../core/lock.ts';
import {
  buildInstallPlan,
  enrichManifestSkills,
  installPack,
} from '../../core/packs/install-pack.ts';

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
    .option('--agent <agent>', '回填来源时读哪个 agent 的 lock(默认 claude-code)', 'claude-code')
    .option('--enrich', '从 skills.lock.json 回填每个 skill 的 repo/commit/ref(让套餐可跨机重装)')
    .option('--json', '机器可读 JSON 输出')
    .action(
      async (
        id: string,
        options: { name?: string; out?: string; days?: string; home?: string; agent?: string; enrich?: boolean; json?: boolean },
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

        // --enrich:从 skills.lock.json 回填来源信息
        if (options.enrich) {
          const lockPath = getSkillsLockPath(home);
          const lock = await readSkillsLock(lockPath);
          const agent = (options.agent ?? 'claude-code') as AgentType;
          const { enriched, notFound } = enrichManifestSkills(manifest, lock, agent);
          manifest.skills = enriched;
          if (notFound.length > 0 && !options.json) {
            console.log(`  注意:以下 skill 未在 ${agent} 的 lock 里找到来源,保持无来源:`);
            for (const n of notFound) console.log(`    · ${n}`);
          }
        }

        const out = options.out ?? `./${name}.pack.json`;
        await writePackManifest(out, manifest);

        if (options.json) {
          console.log(JSON.stringify({ written: out, manifest }, null, 2));
          return;
        }
        console.log(`✓ 已写出套餐:${out}`);
        console.log(`  ${manifest.name} —— ${manifest.skills.length} 个 skill:${manifest.skills.map((s) => s.name).join(', ')}`);
        console.log('  这是一份可携带的清单,能分享给别人或在另一台机器上复用。');
        if (options.enrich) {
          const withSource = manifest.skills.filter((s) => s.repo).length;
          console.log(`  已回填来源:${withSource}/${manifest.skills.length} 个 skill 有 repo 信息。`);
        }
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

  // ── packs install <file> ──────────────────────────────────────────────────
  packs
    .command('install')
    .description('安装套餐清单里的所有 skill(有来源的安装,无来源的跳过并提示)')
    .argument('<file>', 'pack.json 路径')
    .option('--agent <agent>', '目标 agent(如 claude-code、gemini-cli)', 'claude-code')
    .option('--home <dir>', '覆盖 home 根目录')
    .option('--dry-run', '只显示安装计划,不写任何文件')
    .option('--json', '机器可读 JSON 输出')
    .action(
      async (
        file: string,
        options: { agent?: string; home?: string; dryRun?: boolean; json?: boolean },
        command: Command,
      ) => {
        const home = resolveHome(options, command);
        const manifest = await loadPackManifest(file);
        const agent = (options.agent ?? 'claude-code') as AgentType;

        if (options.dryRun) {
          // dry-run:只显示计划
          const { resolvePackSkills } = await import('../../core/packs/install-pack.ts');
          const resolvedSkills = await resolvePackSkills(manifest, loadPackManifest);
          const plan = buildInstallPlan(resolvedSkills);

          if (options.json) {
            console.log(JSON.stringify({ dryRun: true, file, plan }, null, 2));
            return;
          }
          console.log(`📦 ${manifest.displayName ?? manifest.name}  dry-run 计划:`);
          for (const entry of plan) {
            if (entry.action === 'install') {
              console.log(`  ✓ 将安装:${entry.skill.name}  ← ${entry.skill.repo}`);
            } else {
              console.log(`  ✗ 跳过:${entry.skill.name}  (${entry.skipReason})`);
            }
          }
          return;
        }

        // 真实安装
        const result = await installPack(manifest, {
          home,
          agent,
          mode: 'copy',
        });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          // 有 blocked 时退出码 1
          if (result.results.some((r) => r.action === 'blocked' || r.action === 'error')) {
            process.exitCode = 1;
          }
          return;
        }

        // 人类可读输出
        console.log(`📦 ${manifest.displayName ?? manifest.name}`);
        for (const r of result.results) {
          switch (r.action) {
            case 'installed': {
              const targets = r.installResult?.installed.map((i) => i.name).join(', ') ?? r.name;
              console.log(`  ✓ 已安装:${targets}`);
              break;
            }
            case 'skipped':
              console.log(`  ✗ 跳过:${r.name}  (${r.skipReason})`);
              break;
            case 'blocked':
              console.log(`  ⛔ 被 audit 拦截:${r.name}(--force 可越过)`);
              break;
            case 'error':
              console.log(`  ✗ 错误:${r.name}  ${r.error}`);
              break;
          }
        }
        if (result.results.some((r) => r.action === 'blocked' || r.action === 'error')) {
          process.exitCode = 1;
        }
      },
    );

  // ── packs list [dir] ──────────────────────────────────────────────────────
  packs
    .command('list')
    .description('列出目录下的 *.pack.json 文件(名称 + skill 数)')
    .argument('[dir]', '目录(默认当前工作目录)')
    .option('--json', '机器可读 JSON 输出')
    .action(async (dir: string | undefined, options: { json?: boolean }) => {
      const targetDir = resolve(dir ?? '.');
      let entries: string[];
      try {
        entries = await readdir(targetDir);
      } catch (err) {
        throw new Error(`无法读取目录 ${targetDir}: ${(err as Error).message}`);
      }

      const packFiles = entries.filter((e) => e.endsWith('.pack.json'));

      const packs_list: Array<{ file: string; name: string; skillCount: number; source: string }> = [];
      for (const filename of packFiles) {
        const filePath = join(targetDir, filename);
        try {
          const m = await loadPackManifest(filePath);
          packs_list.push({
            file: filename,
            name: m.displayName ?? m.name,
            skillCount: m.skills.length,
            source: m.source,
          });
        } catch {
          // 损坏的文件:跳过,不中断列表
        }
      }

      if (options.json) {
        console.log(JSON.stringify({ dir: targetDir, packs: packs_list }, null, 2));
        return;
      }

      if (packs_list.length === 0) {
        console.log(`${targetDir} 下没有 *.pack.json 文件。`);
        return;
      }
      console.log(`${targetDir} 下找到 ${packs_list.length} 个套餐:\n`);
      for (const p of packs_list) {
        console.log(`  📦 ${p.name}  (${p.skillCount} 个 skill, 来源:${p.source})`);
        console.log(`     ${p.file}`);
      }
    });
}
