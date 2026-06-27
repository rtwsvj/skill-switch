// S1.4 scan 子命令:表格(默认)与 --json 两种输出。
// scan 是纯读盘点:即使含坏样本也 exit 0(坏样本以 error 字段呈现);
// 非零退出语义留给 lint/doctor 等判定类命令。
import type { Command } from 'commander';
import { resolveHomeRoot } from '../../core/paths.ts';
import { scanHome, type SkillRecord } from '../../core/scan.ts';

export function formatScanJson(home: string, records: SkillRecord[]): string {
  return JSON.stringify({ home, total: records.length, skills: records }, null, 2);
}

const MAX_AGENTS_SHOWN = 3;

function agentsCell(record: SkillRecord): string {
  const { agents } = record;
  if (agents.length <= MAX_AGENTS_SHOWN) return agents.join(',');
  return `${agents.slice(0, MAX_AGENTS_SHOWN).join(',')} +${agents.length - MAX_AGENTS_SHOWN}`;
}

export function formatScanTable(records: SkillRecord[]): string {
  if (records.length === 0) {
    return '未发现任何 skill。\n提示:试试 `skill-switch install <source>` 安装第一个,或 `skill-switch packs suggest` 获取推荐。';
  }

  const header = ['DIR', 'SKILL', 'NAME', 'AGENTS', 'STATUS'];
  const rows = records.map((record) => [
    record.relSkillsDir,
    record.dirName,
    record.name ?? '-',
    agentsCell(record),
    record.error ? `error: ${record.error.split('\n')[0]}` : 'ok',
  ]);

  const widths = header.map((h, col) =>
    Math.max(h.length, ...rows.map((row) => row[col]!.length)),
  );
  const renderRow = (row: string[]) =>
    row.map((cell, col) => cell.padEnd(widths[col]!)).join('  ').trimEnd();

  return [renderRow(header), ...rows.map(renderRow), '', `共 ${records.length} 个 skill`].join(
    '\n',
  );
}

export function registerScanCommand(program: Command): void {
  program
    .command('scan')
    .description('盘点各 agent 已安装的 skill(纯读,坏样本以 error 字段呈现)')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--json', '机器可读 JSON 输出')
    .action(async (options: { home?: string; json?: boolean }, command: Command) => {
      const homeOverride = options.home ?? command.parent?.opts<{ home?: string }>().home;
      const home = resolveHomeRoot(homeOverride);
      const records = await scanHome(home);
      console.log(options.json ? formatScanJson(home, records) : formatScanTable(records));
    });
}
