// W5-b 后续:import 在写入前用 lint 的结构校验器校验内层 declaration,
// 拒绝写入会污染 skills.json 的损坏档案。全程写临时目录。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listSnapshots } from '../src/core/backup.ts';
import { getSkillsLockPath } from '../src/core/lock.ts';
import { acquireOperationLock } from '../src/core/operation-lock.ts';
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

function runCliAsync(args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout, stderr, status: code ?? -1 }));
  });
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
  it('holds one cross-process home lock across state writes, snapshot, and apply', async () => {
    const home = tmpHome();
    const source = join(home, 'source', 'demo');
    const target = join(home, '.claude', 'skills', 'demo');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: demo\ndescription: import lock fixture.\n---\nSOURCE.\n',
    );
    await writeFile(join(target, 'SKILL.md'), 'TAMPERED\n');

    const bundle = {
      profile: 1,
      declaration: {
        version: 1,
        skills: [
          {
            name: 'demo',
            source,
            agents: ['claude-code'],
            enabled: true,
            mode: 'copy',
          },
        ],
      },
      lock: { version: 1, skills: [] },
    };
    const bundlePath = join(home, 'locked.ssp');
    await writeFile(bundlePath, JSON.stringify(bundle), 'utf8');

    const held = await acquireOperationLock(home, 'test-hold');
    const importing = runCliAsync(['import', bundlePath, '--home', home, '--apply']);

    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(getSkillsJsonPath(home))).toBe(false);
      expect(existsSync(getSkillsLockPath(home))).toBe(false);
      expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('TAMPERED\n');
      expect(await listSnapshots(join(home, '.skill-switch', 'backups'))).toEqual([]);
    } finally {
      await held.release();
    }
    const result = await importing;
    expect(result, result.stderr).toMatchObject({ status: 0 });
    expect(existsSync(getSkillsJsonPath(home))).toBe(true);
    expect(existsSync(getSkillsLockPath(home))).toBe(true);
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('SOURCE.');
    expect(await listSnapshots(join(home, '.skill-switch', 'backups'))).toHaveLength(1);
  });

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

  it('releases the home lock when import fails its in-lock overwrite check', async () => {
    const home = tmpHome();
    const bundle = {
      profile: 1,
      declaration: { version: 1, skills: [] },
      lock: { version: 1, skills: [] },
    };
    const bundlePath = join(home, 'conflict.ssp');
    await writeFile(bundlePath, JSON.stringify(bundle), 'utf8');
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(getSkillsJsonPath(home), JSON.stringify(bundle.declaration), 'utf8');

    const result = runCli(['import', bundlePath, '--home', home]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('已存在');

    const next = await acquireOperationLock(home, 'after-import-error', { waitMs: 50 });
    await next.release();
  });
});
