import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const FIXTURE_HOME = join(ROOT, 'tests/fixtures/home-basic');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as T;
}

function builtSidecarPath(): string {
  const binDir = join(ROOT, 'gui/src-tauri/bin');
  const candidate = readdirSync(binDir).find((entry) => entry.startsWith('skill-switch-cli-'));
  expect(candidate).toBeDefined();
  return join(binDir, candidate!);
}

function parseTotal(stdout: string): number {
  return (JSON.parse(stdout) as { total: number }).total;
}

describe('GUI Tauri sidecar wiring', () => {
  it('builds the CLI sidecar before Tauri dev/build and embeds it as externalBin', () => {
    const pkg = readJson<{ devDependencies?: Record<string, string>; scripts: Record<string, string> }>('gui/package.json');
    const tauri = readJson<{
      build: { beforeDevCommand: string; beforeBuildCommand: string };
      bundle: { externalBin?: string[] };
    }>('gui/src-tauri/tauri.conf.json');

    expect(pkg.scripts['bundle:cli']).toBe('node scripts/bundle-cli.mjs');
    expect(pkg.devDependencies?.postject).toBeDefined();
    expect(tauri.build.beforeDevCommand).toBe('pnpm bundle:cli && pnpm dev');
    expect(tauri.build.beforeBuildCommand).toBe('pnpm bundle:cli && pnpm build');
    expect(tauri.bundle.externalBin).toEqual(['bin/skill-switch-cli']);
  });

  it('uses Node SEA for the packaged sidecar instead of a shell wrapper that execs node', () => {
    const bundler = readFileSync(join(ROOT, 'gui/scripts/bundle-cli.mjs'), 'utf8');
    const cliIndex = readFileSync(join(ROOT, 'src/cli/index.ts'), 'utf8');
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');

    expect(bundler).toContain('postject');
    expect(bundler).toContain('NODE_SEA_BLOB');
    expect(bundler).toContain('--macho-segment-name');
    expect(bundler).toContain("'src', 'cli', 'index.ts'");
    expect(bundler).not.toContain('cli-sidecar-entry.ts');
    expect(cliIndex).toContain("from 'node:sea'");
    expect(cliIndex).toContain('isSea()');
    expect(bundler).not.toContain('exec node - "$@"');
    expect(gitignore).toContain('gui/src-tauri/bin/');
  });

  it('keeps the shell permission scoped to read-only sidecar calls', () => {
    const capability = readJson<{
      permissions: Array<string | { identifier: string; allow: Array<{ name: string; sidecar: boolean; args: unknown[] }> }>;
    }>('gui/src-tauri/capabilities/default.json');
    const shell = capability.permissions.find(
      (permission): permission is { identifier: string; allow: Array<{ name: string; sidecar: boolean; args: unknown[] }> } =>
        typeof permission !== 'string' && permission.identifier === 'shell:allow-execute',
    );

    expect(shell).toBeDefined();
    expect(shell!.allow).toEqual([
      { name: 'bin/skill-switch-cli', sidecar: true, args: ['scan', '--json'] },
      { name: 'bin/skill-switch-cli', sidecar: true, args: ['audit', '--home', '--json'] },
      { name: 'bin/skill-switch-cli', sidecar: true, args: ['doctor', '--json'] },
      { name: 'bin/skill-switch-cli', sidecar: true, args: ['stats', '--days', { validator: '^[0-9]{1,4}$' }, '--json'] },
      { name: 'bin/skill-switch-cli', sidecar: true, args: ['lock', '--verify', '--json'] },
    ]);
  });

  it('uses the sidecar data path without repo-relative tsx', () => {
    const tauriData = readFileSync(join(ROOT, 'gui/src/data/tauri.ts'), 'utf8');
    expect(tauriData).toContain("const sidecarProgram = 'bin/skill-switch-cli'");
    expect(tauriData).toContain('Command.sidecar(sidecarProgram');
    expect(tauriData).toContain("'audit', '--home', '--json'");
    expect(tauriData).not.toContain('tsx');
    expect(tauriData).not.toContain('src/cli/index.ts');
  });

  it('runs both the tsx CLI and the SEA sidecar as real child processes', () => {
    const cliStdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', join(ROOT, 'src/cli/index.ts'), 'scan', '--home', FIXTURE_HOME, '--json'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(parseTotal(cliStdout)).toBe(6);

    execFileSync('pnpm', ['--dir', 'gui', 'bundle:cli'], { cwd: ROOT, encoding: 'utf8' });

    const sea = spawnSync(builtSidecarPath(), ['scan', '--home', FIXTURE_HOME, '--json'], {
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
