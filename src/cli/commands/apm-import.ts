// 任务 D:apm-import 子命令 —— 与 microsoft/apm 生态互操作(只读)。
//
// 读取一个 apm.yml(可选同目录的 apm.lock.yaml),把其中的 **skill 类原语** 映射到
// skill-switch 的声明模型;非 skill 原语(prompts/agents/hooks/mcp…)明确跳过并报告。
//
// 安全姿态(硬约束):
//   - 默认 **dry-run / 只预览**:解析 + 报告"将纳管哪些 skill、跳过了什么",绝不写盘。
//   - 仅 `--apply` 时才把这些 skill 写入 skill-switch 声明(复用 upsertSkillDeclarations),
//     且默认 enabled=false(纳管但不启用,交由用户显式开启)。
//   - 绝不执行 apm.yml 里的任何命令 / 脚本 / install;绝不联网;纯本地文件解析。
//   - apm.yml 里 source 只作为 provenance 记录,不会据此抓取远端内容。
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import {
  InvalidApmYamlError,
  mapApmToImports,
  parseYamlSubset,
  toSkillDeclarations,
  type ApmMapping,
} from '../../core/apm-interop.ts';
import { resolveHomeRoot } from '../../core/paths.ts';
import { getSkillsJsonPath, upsertSkillDeclarations } from '../../core/sync.ts';
import type { AgentType } from '../../vendor/vercel-skills/types.ts';

interface ApmImportCliOptions {
  home?: string;
  apply?: boolean;
  /** 逗号分隔的 agent 列表,默认 claude-code */
  agents?: string;
  /** 覆盖 apm.lock.yaml 路径;默认探测 apm.yml 同目录 */
  lock?: string;
  mode?: string;
}

async function readMaybe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`无法读取文件 ${path}: ${(err as Error).message}`);
  }
}

function parseAgents(raw: string | undefined): AgentType[] | undefined {
  if (!raw) return undefined;
  const agents = raw
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0) as AgentType[];
  return agents.length > 0 ? agents : undefined;
}

/** 把映射结果打印成大白话报告(dry-run 与 apply 共用)。 */
function printReport(mapping: ApmMapping, opts: { apply: boolean; declPath: string }): void {
  const { skills, skipped, warnings } = mapping;

  if (skills.length === 0) {
    console.log('未在 apm.yml 中发现可纳管的 skill。');
  } else {
    const verb = opts.apply ? '已纳入 skill-switch 声明' : '将纳入 skill-switch';
    console.log(`${verb}:`);
    for (const s of skills) {
      const bits: string[] = [];
      if (s.version) bits.push(`版本 ${s.version}`);
      if (s.sourceRef) bits.push(`源 ${s.sourceRef}`);
      if (s.source) bits.push(s.source);
      if (s.integrity) bits.push(`哈希 ${s.integrity}`);
      console.log(`  • ${s.name}${bits.length ? `  (${bits.join(', ')})` : ''}`);
    }
  }

  if (skipped.length > 0) {
    console.log('\n跳过的非 skill 内容(skill-switch 只管 skill 的安全与治理):');
    for (const sk of skipped) {
      const c = sk.count !== undefined ? ` ×${sk.count}` : '';
      console.log(`  - ${sk.category}${c}:${sk.reason}`);
    }
  }

  if (warnings.length > 0) {
    console.log('\n提醒:');
    for (const w of warnings) console.log(`  ! ${w}`);
  }

  if (!opts.apply) {
    console.log('\n[dry-run] 以上为预览,未写入任何文件。加 --apply 才会写入声明。');
  } else {
    console.log(`\n✓ 已写入声明: ${opts.declPath}`);
    console.log('提示:声明已写入但 skill 文件尚未同步到磁盘;请运行 skill-switch sync 应用。');
  }
}

/**
 * apm-import 命令核心逻辑(可被测试直接调用,不经过 commander)。
 * 默认 dry-run;仅 apply=true 时写入声明。返回映射结果便于断言。
 */
export async function runApmImport(
  apmYmlPath: string,
  options: ApmImportCliOptions = {},
): Promise<ApmMapping> {
  const home = resolveHomeRoot(options.home);
  const filePath = resolve(apmYmlPath);

  const apmRaw = await readMaybe(filePath);
  if (apmRaw === undefined) {
    throw new Error(`找不到 apm.yml: ${filePath}`);
  }

  // 探测锁文件:--lock 优先,否则同目录的 apm.lock.yaml / apm.lock.yml。
  let lockRaw: string | undefined;
  if (options.lock) {
    lockRaw = await readMaybe(resolve(options.lock));
    if (lockRaw === undefined) throw new Error(`找不到指定的锁文件: ${resolve(options.lock)}`);
  } else {
    const dir = dirname(filePath);
    for (const candidate of ['apm.lock.yaml', 'apm.lock.yml']) {
      lockRaw = await readMaybe(join(dir, candidate));
      if (lockRaw !== undefined) break;
    }
  }

  let apmDoc: unknown;
  let lockDoc: unknown;
  try {
    apmDoc = parseYamlSubset(apmRaw);
    lockDoc = lockRaw !== undefined ? parseYamlSubset(lockRaw) : undefined;
  } catch (err) {
    if (err instanceof InvalidApmYamlError) {
      throw new Error(`apm.yml 解析失败:${err.message}`);
    }
    throw err;
  }

  let mapping: ApmMapping;
  try {
    mapping = mapApmToImports(apmDoc as never, lockDoc as never);
  } catch (err) {
    if (err instanceof InvalidApmYamlError) {
      throw new Error(`apm.yml 内容非法:${err.message}`);
    }
    throw err;
  }

  const apply = options.apply === true;
  const declPath = getSkillsJsonPath(home);

  if (apply && mapping.skills.length > 0) {
    const agents = parseAgents(options.agents);
    const mode = options.mode === 'symlink' ? 'symlink' : 'copy';
    // 复用现有的、幂等 + 原子的声明写入逻辑(upsertSkillDeclarations)。把映射出的
    // 每个 skill 在每个目标 agent 下注入为一条 addition,一次批量写入。
    const declarations = toSkillDeclarations(mapping.skills, { agents, mode });
    const additions = declarations.flatMap((decl) =>
      decl.agents.map((agent) => ({
        name: decl.name,
        agent,
        source: decl.source,
        mode: decl.mode,
      })),
    );
    await upsertSkillDeclarations(declPath, additions);
  }

  printReport(mapping, { apply: apply && mapping.skills.length > 0, declPath });
  return mapping;
}

export function registerApmImportCommand(program: Command): void {
  program
    .command('apm-import <apm.yml>')
    .description('与 microsoft/apm 互操作(只读):预览/导入 apm.yml 里的 skill 到 skill-switch')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--apply', '把发现的 skill 写入 skill-switch 声明(默认只预览,不写盘)')
    .option('--agents <list>', '逗号分隔的目标 agent(默认 claude-code)')
    .option('--mode <mode>', 'symlink 或 copy(默认 copy)')
    .option('--lock <file>', '指定 apm.lock.yaml 路径(默认探测 apm.yml 同目录)')
    .action(async (apmYml: string, options: ApmImportCliOptions, command: Command) => {
      const home = options.home ?? command.parent?.opts<{ home?: string }>().home;
      await runApmImport(apmYml, { ...options, home });
    });
}
