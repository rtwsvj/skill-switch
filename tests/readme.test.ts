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

  it('documents release-facing usage, safety, native GUI, and screenshots', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    for (const required of [
      '跨 agent 的 skill 治理层',
      '## GUI',
      // 原生 macOS App 开发入口(详见 macos/README.md)
      '(cd macos && swift run)',
      // 截图已从 gui/docs/ 迁到 assets/screenshots/
      'assets/screenshots/g1-overview.png',
      'assets/screenshots/g1-audit.png',
      'assets/screenshots/p1-i18n-en.png',
      // i18n 四语言覆盖
      'zh-CN',
      'en',
      'ja',
      'es',
      // 文档结构钉
      'Exit Codes',
      'Safety Model',
      '装前快照',
      '确认 + 快照 + audit',
      'install/toggle/sync/remove/restore',
      'clone + run',
      // 原生产物路径(pnpm release 描述)
      'macos/dist/skill-switch.app',
      // 内置 SEA sidecar(产物名统一小写)
      'skill-switch-cli',
      // 原生 App 内置 CLI 路径(改过 Resources,不再是 MacOS/)
      '/Applications/skill-switch.app/Contents/Resources/skill-switch-cli',
    ]) {
      expect(readme).toContain(required);
    }
    // 版本号 / DMG 文件名用模式匹配,避免每次发版都要改测试(原先硬编码 v0.4.0 很脆)
    expect(readme).toMatch(/状态:\*\*v\d+\.\d+\.\d+\*\*/);
    expect(readme).toMatch(/skill-switch_\d+\.\d+\.\d+_aarch64\.dmg/);
    // Tauri 时代的 GUI 入口 / 旧文档术语 必须清掉
    expect(readme).not.toContain('只读白名单');
    expect(readme).not.toContain('read-only dashboard sidecar');
    expect(readme).not.toContain('pnpm --dir gui tauri dev');
    expect(readme).not.toContain('gui/docs/');
    expect(readme).not.toContain('gui/src-tauri/bin/');
  });

  it('README.en.md keeps screenshots, native GUI entry, and parity with 中文版', () => {
    const readmeEn = readFileSync(join(ROOT, 'README.en.md'), 'utf8');
    for (const required of [
      'assets/screenshots/g1-overview.png',
      'assets/screenshots/g1-skills.png',
      'assets/screenshots/g1-audit.png',
      'assets/screenshots/g1-usage.png',
      '(cd macos && swift run)',
      'macos/dist/skill-switch.app',
      '/Applications/skill-switch.app/Contents/Resources/skill-switch-cli',
    ]) {
      expect(readmeEn).toContain(required);
    }
    expect(readmeEn).not.toContain('gui/docs/');
    expect(readmeEn).not.toContain('pnpm --dir gui tauri dev');
  });
});
