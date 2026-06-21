// W2-a init 子命令:扫描已安装的 skill,草拟 skills.json 初始声明。
// 安全第一:已存在 skills.json 时不覆盖,需 --force 才写入;--dry-run 只打印不写。
import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { resolveHomeRoot } from '../../core/paths.ts';
import { scanHome, type SkillRecord } from '../../core/scan.ts';
import { getSkillsJsonPath, type SkillsDeclarationFile } from '../../core/sync.ts';
import { writeJsonState } from '../../core/state-io.ts';
import type { AgentType } from '../../vendor/vercel-skills/types.ts';

/** 从 scan 记录构造 skills.json 草稿。 */
export function buildDraftDeclaration(records: SkillRecord[]): SkillsDeclarationFile {
  // 按 dirName(skill 文件夹名)合并 agents
  const byDir = new Map<string, { agents: AgentType[]; dir: string }>();
  for (const record of records) {
    if (record.error) continue; // 坏样本跳过,不写入声明
    const key = record.dirName;
    const existing = byDir.get(key);
    if (existing) {
      for (const agent of record.agents) {
        if (!existing.agents.includes(agent)) existing.agents.push(agent);
      }
    } else {
      byDir.set(key, { agents: [...record.agents], dir: record.dir });
    }
  }

  const skills = [...byDir.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dirName, { agents, dir }]) => ({
      name: dirName,
      source: dir,
      agents,
      enabled: true,
      mode: 'symlink' as const,
    }));

  return { version: 1, skills };
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('扫描已安装的 skill,草拟 skills.json 初始声明(已存在则不覆盖,需 --force)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--force', '已有 skills.json 时强制覆盖')
    .option('--dry-run', '只打印草稿,不写入文件')
    .option('--json', '机器可读 JSON 输出')
    .action(
      async (
        options: { home?: string; force?: boolean; dryRun?: boolean; json?: boolean },
        command: Command,
      ) => {
        const homeOverride = options.home ?? command.parent?.opts<{ home?: string }>().home;
        const home = resolveHomeRoot(homeOverride);
        const skillsJsonPath = getSkillsJsonPath(home);

        // 已存在且未指定 --force:打印提示、exit 0
        if (!options.force && !options.dryRun && existsSync(skillsJsonPath)) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { status: 'exists', path: skillsJsonPath, message: '已有 skills.json,跳过(用 --force 覆盖)' },
                null,
                2,
              ),
            );
          } else {
            console.log(`已有 skills.json: ${skillsJsonPath}`);
            console.log('跳过写入。用 --force 强制覆盖。');
          }
          return; // exit 0
        }

        const records = await scanHome(home);
        const draft = buildDraftDeclaration(records);

        if (options.dryRun) {
          if (options.json) {
            console.log(JSON.stringify({ dryRun: true, path: skillsJsonPath, draft }, null, 2));
          } else {
            console.log(`# 草稿(--dry-run,未写入): ${skillsJsonPath}`);
            console.log(JSON.stringify(draft, null, 2));
          }
          return;
        }

        await writeJsonState(skillsJsonPath, draft);

        if (options.json) {
          console.log(
            JSON.stringify({ status: 'written', path: skillsJsonPath, skills: draft.skills.length }, null, 2),
          );
        } else {
          console.log(`已写入 ${skillsJsonPath}`);
          console.log(`共收录 ${draft.skills.length} 个 skill。`);
        }
      },
    );
}
