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
run('Native macOS app build (skill-switch.app, unsigned)', 'bash', ['macos/build-app.sh']);

const artifacts = [
  requireArtifact('macos/dist/skill-switch.app'),
  requireArtifact('macos/dist/skill-switch.app/Contents/MacOS/SkillSwitch'),
  requireArtifact('macos/dist/skill-switch.app/Contents/Resources/skill-switch-cli'),
];

console.log('\nRelease build artifacts:');
for (const artifact of artifacts) {
  console.log(`- ${artifact.path} (${artifact.detail})`);
}
console.log('\n下一步:维护者本地跑 macos/sign-notarize.sh 完成签名 + 公证,产出 dist/skill-switch_<ver>_aarch64.dmg 上传到 Release。');
