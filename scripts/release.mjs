#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(label, command, args) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function requireArtifact(path) {
  const fullPath = resolve(root, path);
  if (!existsSync(fullPath)) {
    throw new Error(`Expected release artifact was not created: ${path}`);
  }
  const stats = statSync(fullPath);
  if (!stats.isDirectory() && stats.size <= 0) {
    throw new Error(`Expected release artifact is empty: ${path}`);
  }
  return { path, detail: stats.isDirectory() ? 'directory' : `${stats.size} bytes` };
}

run('Vitest suite', 'pnpm', ['test']);
run('TypeScript typecheck', 'pnpm', ['typecheck']);
run('npm package dry-run', 'npm', ['pack', '--dry-run', '--json']);
run('Tauri app and dmg build', 'pnpm', ['--dir', 'gui', 'tauri', 'build']);

const artifacts = [
  requireArtifact('gui/src-tauri/target/release/bundle/macos/skill-switch.app'),
  requireArtifact('gui/src-tauri/target/release/bundle/macos/skill-switch.app/Contents/MacOS/skill-switch-cli'),
  requireArtifact('gui/src-tauri/target/release/bundle/dmg/skill-switch_0.1.0_aarch64.dmg'),
];

console.log('\nRelease build artifacts:');
for (const artifact of artifacts) {
  console.log(`- ${artifact.path} (${artifact.detail})`);
}
