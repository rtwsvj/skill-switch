// F10:README 命令清单必须与 CLI 实际注册命令一致。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

function cliCommands(): string[] {
  const help = execFileSync(process.execPath, ['--import', 'tsx', CLI, '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return help
    .split('\n')
    .map((line) => /^\s{2}([a-z][a-z-]*)\b/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name) && name !== 'help')
    .sort();
}

function readmeCommands(): string[] {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  return [...readme.matchAll(/^\|\s*`([a-z][a-z-]*)`\s*\|/gm)]
    .map((match) => match[1]!)
    .sort();
}

describe('README', () => {
  it('lists every registered CLI command and no stale commands', () => {
    expect(readmeCommands()).toEqual(cliCommands());
  });

  it('documents release-facing usage, safety, GUI, and screenshots', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    for (const required of [
      '跨 agent 的 skill 治理层',
      '## GUI',
      'pnpm --dir gui tauri dev',
      'gui/docs/g1-overview.png',
      'gui/docs/g1-audit.png',
      'gui/docs/p1-i18n-zh-CN.png',
      'zh-CN',
      'en',
      'ja',
      'es',
      'Exit Codes',
      'Safety Model',
      '装前快照',
      '只读白名单',
    ]) {
      expect(readme).toContain(required);
    }
  });
});
