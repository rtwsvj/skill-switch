import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as T;
}

describe('GUI Tauri sidecar wiring', () => {
  it('builds the CLI sidecar before Tauri dev/build and embeds it as externalBin', () => {
    const pkg = readJson<{ scripts: Record<string, string> }>('gui/package.json');
    const tauri = readJson<{
      build: { beforeDevCommand: string; beforeBuildCommand: string };
      bundle: { externalBin?: string[] };
    }>('gui/src-tauri/tauri.conf.json');

    expect(pkg.scripts['bundle:cli']).toBe('node scripts/bundle-cli.mjs');
    expect(tauri.build.beforeDevCommand).toBe('pnpm bundle:cli && pnpm dev');
    expect(tauri.build.beforeBuildCommand).toBe('pnpm bundle:cli && pnpm build');
    expect(tauri.bundle.externalBin).toEqual(['bin/skill-switch-cli']);
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
});
