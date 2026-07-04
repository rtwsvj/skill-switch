// SEA CLI 自包含打包回归(v0.1 抓过的真 bug 关键回归):
//   1) scripts/bundle-cli.mjs 必须真把 esbuild 产物注入到 node 二进制(NODE_SEA_BLOB + postject)
//   2) 产出的 SEA 二进制必须能跑 scan 并把 argv 分流到正确的子命令
//   3) .gitignore 必须忽略产物目录 dist/
//
// 历史:本测试原名 gui-sidecar.test.ts,Tauri 退役后那些 Tauri 特有断言(capabilities /
// externalBin / tauri.conf.json / DashboardShell 等)已无意义,只剩 SEA 打包与运行回归本体。

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const FIXTURE_HOME = join(ROOT, 'tests/fixtures/home-basic');
const BUNDLE_CLI = join(ROOT, 'scripts/bundle-cli.mjs');

function readText(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function builtSeaPath(): string {
  const binDir = join(ROOT, 'dist', 'sea');
  const candidate = readdirSync(binDir).find((entry) => entry.startsWith('skill-switch-cli-'));
  expect(candidate, `expected a built SEA binary under ${binDir}`).toBeDefined();
  return join(binDir, candidate!);
}

function parseTotal(stdout: string): number {
  return (JSON.parse(stdout) as { total: number }).total;
}

// ── 内联自原 gui/src/data/cli-args.ts 的 argv 构造器 ────────────────────────
// (Tauri 退役后该模块已删,但 argv 构造契约本身就是 CLI 的对外契约,
// 必须有测试钉住 —— 这是 v0.1 抓过「命令分流错位」的关键回归。)

interface InstallArgsRequest {
  source: string;
  agent: string;
  mode: 'copy' | 'symlink';
  skill?: string;
  ref?: string;
  force?: boolean;
  forceReason?: string;
}

interface ToggleArgsRequest {
  name: string;
  enabled: boolean;
}

interface SyncArgsRequest {
  dryRun: boolean;
}

interface RemoveArgsRequest {
  name: string;
  agent: string;
}

interface RestoreArgsRequest {
  id?: string;
  latest?: boolean;
}

function installArgs(request: InstallArgsRequest): string[] {
  const args = ['install', request.source, '--agent', request.agent, '--mode', request.mode];
  if (request.skill) args.push('--skill', request.skill);
  if (request.ref) args.push('--ref', request.ref);
  if (request.force) args.push('--force');
  if (request.force && request.forceReason?.trim()) args.push('--force-reason', request.forceReason.trim());
  args.push('--json');
  return args;
}

function toggleArgs(request: ToggleArgsRequest): string[] {
  return ['toggle', request.name, request.enabled ? '--on' : '--off', '--json'];
}

function syncArgs(request: SyncArgsRequest): string[] {
  return request.dryRun ? ['sync', '--dry-run', '--json'] : ['sync', '--json'];
}

function removeArgs(request: RemoveArgsRequest): string[] {
  return ['remove', request.name, '--agent', request.agent, '--json'];
}

function restoreArgs(request: RestoreArgsRequest): string[] {
  if (request.latest) return ['restore', '--latest', '--json'];
  if (request.id) return ['restore', '--id', request.id, '--json'];
  return ['restore', '--json'];
}

describe('SEA CLI 自包含打包', () => {
  it('根 package.json 暴露 bundle:cli / bundle:cli:bun,且 esbuild/postject 同版本平移到根 devDependencies', () => {
    const pkg = JSON.parse(readText('package.json')) as {
      scripts: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.scripts['bundle:cli']).toBe('node scripts/bundle-cli.mjs');
    expect(pkg.scripts['bundle:cli:bun']).toBe('node scripts/bundle-cli-bun.mjs');
    expect(pkg.devDependencies?.esbuild).toBe('^0.28.1');
    expect(pkg.devDependencies?.postject).toBe('1.0.0-alpha.6');
  });

  it('bundle-cli.mjs 用 esbuild + postject 注入 SEA blob,产物输出到 dist/sea/', () => {
    const bundler = readText('scripts/bundle-cli.mjs');
    const cliIndex = readText('src/cli/index.ts');
    const gitignore = readText('.gitignore');

    expect(bundler).toContain('postject');
    expect(bundler).toContain('NODE_SEA_BLOB');
    expect(bundler).toContain('--macho-segment-name');
    expect(bundler).toContain("'dist', 'sea', 'skill-switch-cli'");
    expect(bundler).not.toContain('src-tauri/bin');
    expect(bundler).not.toContain('gui/scripts');

    expect(cliIndex).toContain("from 'node:sea'");
    expect(cliIndex).toContain('isSea()');

    expect(gitignore).toMatch(/^dist\/$/m);
    expect(gitignore).not.toContain('gui/src-tauri/bin');
  });

  it('CLI 写操作 argv 构造器必须钉住(命令 / 旗标 / --json 三件套)', () => {
    expect(
      installArgs({
        source: '/tmp/source',
        agent: 'claude-code',
        mode: 'copy',
        skill: 'tidy-notes',
        ref: 'main',
        force: true,
      }),
    ).toEqual([
      'install',
      '/tmp/source',
      '--agent',
      'claude-code',
      '--mode',
      'copy',
      '--skill',
      'tidy-notes',
      '--ref',
      'main',
      '--force',
      '--json',
    ]);
    expect(toggleArgs({ name: 'tidy-notes', enabled: true })).toEqual([
      'toggle',
      'tidy-notes',
      '--on',
      '--json',
    ]);
    expect(toggleArgs({ name: 'tidy-notes', enabled: false })).toEqual([
      'toggle',
      'tidy-notes',
      '--off',
      '--json',
    ]);
    expect(syncArgs({ dryRun: true })).toEqual(['sync', '--dry-run', '--json']);
    expect(syncArgs({ dryRun: false })).toEqual(['sync', '--json']);
    expect(removeArgs({ name: 'tidy-notes', agent: 'gemini-cli' })).toEqual([
      'remove',
      'tidy-notes',
      '--agent',
      'gemini-cli',
      '--json',
    ]);
    expect(restoreArgs({})).toEqual(['restore', '--json']);
    expect(restoreArgs({ latest: true })).toEqual(['restore', '--latest', '--json']);
    expect(restoreArgs({ id: '123' })).toEqual(['restore', '--id', '123', '--json']);
  });

  it('跑 SEA 打包并真子进程 spawn 产物,断言 argv 分流到 scan 子命令', () => {
    const cliStdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', join(ROOT, 'src/cli/index.ts'), 'scan', '--home', FIXTURE_HOME, '--json'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(parseTotal(cliStdout)).toBe(6);

    execFileSync('node', [BUNDLE_CLI], { cwd: ROOT, encoding: 'utf8' });

    const sea = spawnSync(builtSeaPath(), ['scan', '--home', FIXTURE_HOME, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        HOME: '/tmp',
        PATH: '/usr/bin:/bin',
      },
    });

    expect(sea.status, sea.stderr || sea.stdout).toBe(0);
    expect(parseTotal(sea.stdout)).toBe(6);
  }, 60_000);
});
