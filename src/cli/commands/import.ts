// W3-b import 子命令:读取 .ssp 档案,校验格式,把 declaration 写入 skills.json、
// lock 写入 skills.lock.json。不执行 sync——完成后提示用户运行 skill-switch sync。
// 默认不覆盖已有文件,需加 --force;--dry-run 只打印会写什么,不写文件。
//
// P3-D5:--apply 选项:import 后直接调用 applySync,新机一条命令 bootstrap。
//   无 --apply 时行为不变。
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { resolveHomeRoot } from '../../core/paths.ts';
import { applySync, getSkillsJsonPath, readDeclaration } from '../../core/sync.ts';
import { snapshotAgents } from '../../core/agent-snapshots.ts';
import { validateSkillsJson } from '../../core/lint/skills-json-validator.ts';
import { getSkillsLockPath, writeSkillsLock } from '../../core/lock.ts';
import { writeJsonState } from '../../core/state-io.ts';
import type { SspBundle } from './export.ts';

interface ImportCliOptions {
  home?: string;
  force?: boolean;
  dryRun?: boolean;
  /** P3-D5:import 后直接执行 applySync */
  apply?: boolean;
}

function validateBundle(raw: unknown): SspBundle {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('档案格式非法:根不是 JSON 对象');
  }
  const obj = raw as Record<string, unknown>;

  if (obj.profile !== 1) {
    throw new Error(`档案格式非法:期望 profile=1,得到 ${JSON.stringify(obj.profile)}`);
  }

  const decl = obj.declaration;
  if (
    typeof decl !== 'object' ||
    decl === null ||
    (decl as Record<string, unknown>).version !== 1 ||
    !Array.isArray((decl as Record<string, unknown>).skills)
  ) {
    throw new Error('档案格式非法:declaration 不是有效的 SkillsDeclarationFile({ version: 1, skills: [...] })');
  }

  const lock = obj.lock;
  if (
    typeof lock !== 'object' ||
    lock === null ||
    (lock as Record<string, unknown>).version !== 1 ||
    !Array.isArray((lock as Record<string, unknown>).skills)
  ) {
    throw new Error('档案格式非法:lock 不是有效的 SkillsLockFile({ version: 1, skills: [...] })');
  }

  return raw as SspBundle;
}

export function registerImportCommand(program: Command): void {
  program
    .command('import <file>')
    .description('从 .ssp 档案还原 skills.json + skills.lock.json(不执行 sync)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--force', '覆盖已有的 skills.json / skills.lock.json')
    .option('--dry-run', '只打印会写入的内容,不真正写文件')
    .option('--apply', '[P3] import 后直接执行 sync,新机一条命令 bootstrap')
    .action(async (file: string, options: ImportCliOptions, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);

      const filePath = resolve(file);
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new Error(`找不到档案文件: ${filePath}`);
        }
        throw new Error(`无法读取档案文件 ${filePath}: ${(err as Error).message}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`档案文件 JSON 损坏: ${filePath}`);
      }

      const bundle = validateBundle(parsed);

      // 写入前对内层 declaration 做结构校验:拒绝写入会污染 skills.json 的损坏档案
      //(覆盖 dry-run / 覆盖 / 正常写入所有路径)。复用 lint 的结构校验器,不另写一套。
      const declErrors = validateSkillsJson(bundle.declaration).filter((f) => f.severity === 'error');
      if (declErrors.length > 0) {
        const summary = declErrors.map((f) => `${f.path ?? '?'}: ${f.message}`).join('; ');
        throw new Error(`档案内 declaration 结构非法,已拒绝写入: ${summary}`);
      }

      const skillsJsonPath = getSkillsJsonPath(home);
      const lockPath = getSkillsLockPath(home);

      const declExists = existsSync(skillsJsonPath);
      const lockExists = existsSync(lockPath);

      if (!options.force && !options.dryRun) {
        if (declExists) {
          throw new Error(`skills.json 已存在,加 --force 才可覆盖: ${skillsJsonPath}`);
        }
        if (lockExists) {
          throw new Error(`skills.lock.json 已存在,加 --force 才可覆盖: ${lockPath}`);
        }
      }

      if (options.dryRun) {
        console.log('[dry-run] 以下文件将被写入(--dry-run 模式,实际不写):');
        console.log(`  ${skillsJsonPath}  (${JSON.stringify(bundle.declaration).length} bytes)`);
        console.log(`  ${lockPath}  (${JSON.stringify(bundle.lock).length} bytes)`);
        if (!options.force && (declExists || lockExists)) {
          console.log('  注意:目标文件已存在;实际执行时需加 --force 才能覆盖。');
        }
        return;
      }

      // 写入 declaration
      await writeJsonState(skillsJsonPath, bundle.declaration);

      // 写入 lock(用 writeSkillsLock 保证 agent|name 排序一致性)
      await writeSkillsLock(lockPath, bundle.lock as Parameters<typeof writeSkillsLock>[1]);

      console.log(`imported declaration → ${skillsJsonPath}`);
      console.log(`imported lock        → ${lockPath}`);

      // P3-D5:--apply 模式:import 后直接执行 applySync(快照+同步)
      if (options.apply) {
        const declaration = await readDeclaration(skillsJsonPath);
        // 计算有哪些 agent 受影响,先快照
        const affectedAgents = [...new Set(declaration.skills.flatMap((s) => s.agents))];
        const snapshots = await snapshotAgents(home, affectedAgents, 'pre-import-apply');
        const { actions } = await applySync(home, declaration);
        const changed = actions.filter((a) => a.kind !== 'noop').length;
        console.log(`✓ import --apply 完成:同步 ${changed}/${actions.length} 动作`);
        for (const snap of snapshots) {
          console.log(`  快照: ${snap.path}`);
        }
        return;
      }

      console.log('提示:档案已写入,skill 文件尚未同步。请运行 skill-switch sync 把声明应用到磁盘。');
    });
}
