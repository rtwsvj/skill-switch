// W5-b 后续:import 在写入前用 lint 的结构校验器校验内层 declaration,
// 拒绝写入会污染 skills.json 的损坏档案。全程写临时目录。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSkillsJsonPath } from '../src/core/sync.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

const homes: string[] = [];
function tmpHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'ss-importval-'));
  homes.push(h);
  return h;
}
afterEach(async () => {
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});

describe('import: 内层 declaration 结构校验(W5-b)', () => {
  it('拒绝写入缺 name 的 declaration → exit 1,不写任何文件', async () => {
    const home = tmpHome();
    const bundle = {
      profile: 1,
      // skills 是数组(过得了基础 bundle 校验),但 skill 缺 name(过不了结构校验)
      declaration: { version: 1, skills: [{ source: '/x', agents: ['claude-code'], enabled: true, mode: 'copy' }] },
      lock: { version: 1, skills: [] },
    };
    const bundlePath = join(home, 'bad.ssp');
    await writeFile(bundlePath, JSON.stringify(bundle), 'utf8');

    const r = runCli(['import', bundlePath, '--home', home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('错误:');
    expect(r.stderr).toContain('结构非法');
    expect(existsSync(getSkillsJsonPath(home))).toBe(false);
  });

  it('合法 declaration 正常导入 → exit 0,写入 skills.json', async () => {
    const home = tmpHome();
    const bundle = {
      profile: 1,
      declaration: {
        version: 1,
        skills: [{ name: 'demo', source: '/x', agents: ['claude-code'], enabled: true, mode: 'copy' }],
      },
      lock: { version: 1, skills: [] },
    };
    const bundlePath = join(home, 'ok.ssp');
    await writeFile(bundlePath, JSON.stringify(bundle), 'utf8');

    const r = runCli(['import', bundlePath, '--home', home]);
    expect(r.status).toBe(0);
    expect(existsSync(getSkillsJsonPath(home))).toBe(true);
  });
});
