// S1.4:scan CLI 验收 — 表格/JSON 双输出,含坏样本时 exit 0。
// exit code 用真实子进程验证(node --import tsx),不是 mock。
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatScanJson, formatScanTable } from '../src/cli/commands/scan.ts';
import { scanHome } from '../src/core/scan.ts';

const ROOT = join(import.meta.dirname, '..');
const HOME_BASIC = join(import.meta.dirname, 'fixtures', 'home-basic');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

function runCli(args: string[]): { stdout: string; status: number } {
  // execFileSync 非零退出会抛 → 正常返回即 exit 0
  const stdout = execFileSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return { stdout, status: 0 };
}

describe('scan CLI', () => {
  it('--json against home-basic exits 0 despite broken samples (real subprocess)', () => {
    const { stdout } = runCli(['scan', '--home', HOME_BASIC, '--json']);
    const parsed = JSON.parse(stdout) as { total: number; skills: Array<{ error?: string }> };
    expect(parsed.total).toBe(6);
    expect(parsed.skills.some((s) => s.error)).toBe(true);
  });

  it('json output matches the normalized snapshot', async () => {
    const records = await scanHome(HOME_BASIC);
    const normalized = formatScanJson(HOME_BASIC, records).replaceAll(HOME_BASIC, '<home>');
    expect(normalized).toMatchSnapshot();
  });

  it('table output lists every skill and surfaces parse errors', async () => {
    const records = await scanHome(HOME_BASIC);
    const table = formatScanTable(records);
    for (const dirName of [
      'git-helper',
      'commit-style',
      'broken-frontmatter',
      'deploy-checklist',
      'mismatched-name',
      'code-review-helper',
    ]) {
      expect(table).toContain(dirName);
    }
    expect(table).toMatch(/error/i);
  });

  it('table output for an empty home says so without throwing', () => {
    expect(formatScanTable([])).toContain('未发现');
  });
});
