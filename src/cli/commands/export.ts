// W3-b export 子命令:把 home 里的 skills.json + skills.lock.json 打包成一个可携带的 .ssp 档案。
// 只读操作——不修改 home 的任何文件。
// 产物格式:{ profile: 1, declaration: <SkillsDeclarationFile>, lock: <SkillsLockFile> }
// 默认输出到 ./skill-switch-profile.ssp;--json 改为输出到 stdout。
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { resolveHomeRoot } from '../../core/paths.ts';
import { readDeclaration, getSkillsJsonPath } from '../../core/sync.ts';
import { readSkillsLock, getSkillsLockPath } from '../../core/lock.ts';

export interface SspBundle {
  profile: 1;
  declaration: object;
  lock: object;
}

interface ExportCliOptions {
  home?: string;
  out?: string;
  json?: boolean;
}

export function registerExportCommand(program: Command): void {
  program
    .command('export')
    .description('把 skills.json + skills.lock.json 打包成可携带的 .ssp 档案(只读)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--out <file>', '输出文件路径(默认 ./skill-switch-profile.ssp)')
    .option('--json', '把档案内容输出到 stdout,不写文件')
    .action(async (options: ExportCliOptions, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);

      const skillsJsonPath = getSkillsJsonPath(home);
      if (!existsSync(skillsJsonPath)) {
        throw new Error(`找不到 skills.json,请先运行 skill-switch init 初始化: ${skillsJsonPath}`);
      }

      const declaration = await readDeclaration(skillsJsonPath);
      const lockPath = getSkillsLockPath(home);
      const lock = await readSkillsLock(lockPath);

      const bundle: SspBundle = {
        profile: 1,
        declaration,
        lock,
      };

      if (options.json) {
        console.log(JSON.stringify(bundle, null, 2));
        return;
      }

      const outPath = resolve(options.out ?? './skill-switch-profile.ssp');
      await writeFile(outPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
      console.log(`exported: ${outPath}`);
    });
}
