import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installArgs,
  removeArgs,
  restoreArgs,
  syncArgs,
  toggleArgs,
} from '../gui/src/data/cli-args.ts';

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

  it('allows exactly one sidecar program in the shell capability', () => {
    // 注:Tauri v2 对同名 sidecar 的多条 allow 不按 args 区分、永远跑第一条,
    // 会导致每个命令都被当成第一条(scan)执行。因此只保留单条 args:true 条目,
    // 读写边界改由数据层固定参数和 UI 确认流保证。
    const capability = readJson<{
      permissions: Array<string | { identifier: string; allow: Array<{ name: string; sidecar: boolean; args: unknown }> }>;
    }>('gui/src-tauri/capabilities/default.json');
    const shell = capability.permissions.find(
      (permission): permission is { identifier: string; allow: Array<{ name: string; sidecar: boolean; args: unknown }> } =>
        typeof permission !== 'string' && permission.identifier === 'shell:allow-execute',
    );

    expect(shell).toBeDefined();
    expect(shell!.allow).toEqual([{ name: 'bin/skill-switch-cli', sidecar: true, args: true }]);
  });

  it('GUI data layer exposes read and write CLI subcommands through the sidecar', () => {
    const tauriData = readFileSync(join(ROOT, 'gui/src/data/tauri.ts'), 'utf8');
    expect(tauriData).toContain("const sidecarProgram = 'bin/skill-switch-cli'");
    expect(tauriData).toContain('Command.sidecar(sidecarProgram');
    expect(tauriData).not.toContain('tsx');
    expect(tauriData).not.toContain('src/cli/index.ts');
    for (const readCmd of ['scan', 'audit', 'doctor', 'stats', 'lock']) {
      expect(tauriData.includes(`'${readCmd}'`), `data layer should call ${readCmd}`).toBe(true);
    }
    for (const writeMethod of ['runInstall', 'runRemove', 'runToggle', 'runSync', 'runRestore']) {
      expect(tauriData.includes(`function ${writeMethod}`), `data layer should expose ${writeMethod}`).toBe(true);
    }
  });

  it('constructs write sidecar args with --json and explicit command parameters', () => {
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

  it('GUI write UI wires install, toggle, sync, remove, restore behind the app confirmation dialog and refresh', () => {
    const app = readFileSync(join(ROOT, 'gui/src/App.tsx'), 'utf8');
    for (const method of ['runInstall', 'runToggle', 'runSync', 'runRemove', 'runRestore']) {
      expect(app.includes(method), `App should call ${method}`).toBe(true);
    }
    expect(app).not.toContain('window.confirm');
    expect(app).toContain('ConfirmationDialog');
    expect(app).toContain('requestConfirmation');
    expect(app).toContain('runSync({ dryRun: true })');
    expect(app).toContain('runRestore({})');
    expect(app).toContain('onRefresh');
    expect(app).not.toContain('handleAdopt');
    expect(app).not.toContain('skills.actions.adopt');
    expect(app).not.toContain('operations.confirm.adopt');
  });

  it('GUI disables an undeclared skill by first declaring from the scanned directory, then toggling off', () => {
    const app = readFileSync(join(ROOT, 'gui/src/App.tsx'), 'utf8');
    const toggleStart = app.indexOf('const handleToggle');
    const toggleEnd = app.indexOf('const handleRemove');
    const toggleBody = app.slice(toggleStart, toggleEnd);

    expect(toggleStart).toBeGreaterThanOrEqual(0);
    expect(toggleEnd).toBeGreaterThan(toggleStart);
    expect(toggleBody).toContain('const name = actionSkillName(skill)');
    expect(toggleBody).toContain('source: skill.dir');
    expect(toggleBody).toContain('skill: name');
    expect(toggleBody).toContain("mode: 'copy'");
    expect(toggleBody).toContain('await runInstall');
    expect(toggleBody).toContain('await runToggle({ name, enabled })');
    expect(toggleBody.indexOf('await runInstall')).toBeLessThan(toggleBody.indexOf('await runToggle({ name, enabled })'));
    expect(toggleBody).not.toContain('source: skill.path');
  });

  it('skill rows always expose one enable/disable action and one delete action without a governance/adopt gate', () => {
    const app = readFileSync(join(ROOT, 'gui/src/App.tsx'), 'utf8');
    const skillsStart = app.indexOf('function Skills');
    const skillsEnd = app.indexOf('function Audit');
    const skillsBody = app.slice(skillsStart, skillsEnd);

    expect(skillsStart).toBeGreaterThanOrEqual(0);
    expect(skillsEnd).toBeGreaterThan(skillsStart);
    expect(skillsBody).toContain('skills.actions.disable');
    expect(skillsBody).toContain('skills.actions.enable');
    expect(skillsBody).toContain('skills.actions.delete');
    expect(skillsBody).toContain('onToggle(skill, !enabled)');
    expect(skillsBody).toContain('onRemove(skill)');
    expect(skillsBody).not.toContain('managed');
    expect(skillsBody).not.toContain('onAdopt');
  });

  it('GUI write safety UX keeps app confirmations, audit blocking, snapshots, and refresh visible', () => {
    const app = readFileSync(join(ROOT, 'gui/src/App.tsx'), 'utf8');
    const confirmationCount = app.match(/requestConfirmation/g)?.length ?? 0;
    expect(confirmationCount).toBeGreaterThanOrEqual(5);
    for (const key of [
      'operations.confirm.install',
      'operations.confirm.forceInstall',
      'operations.confirm.toggleOn',
      'operations.confirm.toggleOff',
      'operations.confirm.remove',
      'operations.confirm.sync',
      'operations.confirm.restore',
    ]) {
      expect(app).toContain(key);
    }
    expect(app).toContain('result.data.blocked.length > 0');
    expect(app).toContain('return;');
    expect(app).toContain('snapshotPaths(result.data)');
    expect(app.match(/await onRefresh\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('GUI derives declared state from skills.json data instead of lock-only data', () => {
    const app = readFileSync(join(ROOT, 'gui/src/App.tsx'), 'utf8');
    const shellStart = app.indexOf('export function DashboardShell');
    const shellEnd = app.indexOf('const setAdvancedPreference');
    const shellBody = app.slice(shellStart, shellEnd);

    expect(shellStart).toBeGreaterThanOrEqual(0);
    expect(shellEnd).toBeGreaterThan(shellStart);
    expect(shellBody).toContain('mergeDeclaredSkills');
    expect(shellBody).toContain('data.doctor.declarations');
    expect(shellBody).not.toContain('data.lockVerify.entries.map');
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
