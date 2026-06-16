#!/usr/bin/env node
// M0-5.3:校验 macOS entitlement 分离 —— GUI 主程序最小(无 JIT),Node sidecar 才持 JIT。
// 纯只读(codesign -d),不需要签名凭据。非 macOS / 未构建则 graceful skip(exit 0)。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const guiDir = resolve(scriptDir, '..');

if (process.platform !== 'darwin') {
  console.log('check-entitlements: 非 macOS,跳过。');
  process.exit(0);
}

const candidates = [
  resolve(guiDir, 'src-tauri/target/release/bundle/macos/skill-switch.app'),
  '/Applications/skill-switch.app',
];
const app = candidates.find((p) => existsSync(p));
if (!app) {
  console.log('check-entitlements: 未找到已构建的 skill-switch.app,跳过(先 pnpm --dir gui tauri build 或 sign)。');
  process.exit(0);
}

const JIT = 'com.apple.security.cs.allow-jit';
const WX = 'com.apple.security.cs.allow-unsigned-executable-memory';

// entitlement 分离只对 hardened runtime 的 Developer ID 发布构建有意义;
// ad-hoc/dev 构建无 hardened runtime,JIT entitlement 是 no-op,跳过检查。
function isHardened(binary) {
  try {
    const out = execFileSync('codesign', ['--display', '--verbose=2', binary], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return /flags=\S*runtime/.test(out);
  } catch {
    return false;
  }
}

function entitlements(binary) {
  if (!existsSync(binary)) return null;
  try {
    return execFileSync('codesign', ['-d', '--entitlements', ':-', binary], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

const mainBin = `${app}/Contents/MacOS/app`;
const sidecar = `${app}/Contents/MacOS/skill-switch-cli`;

if (!isHardened(mainBin)) {
  console.log('check-entitlements: 当前为非 hardened runtime 构建(ad-hoc/dev),entitlement 分离检查仅适用于 Developer ID 发布构建,跳过。');
  process.exit(0);
}

const mainEnt = entitlements(mainBin) ?? '';
const sidecarEnt = entitlements(sidecar);

const problems = [];
if (mainEnt.includes(JIT) || mainEnt.includes(WX)) {
  problems.push(`GUI 主程序带了 JIT/可写可执行内存 entitlement(应最小化,只 sidecar 需要):${mainBin}`);
}
if (sidecarEnt === null) {
  console.log(`check-entitlements: 未找到 sidecar(${sidecar}),跳过 sidecar 校验。`);
} else if (!sidecarEnt.includes(JIT)) {
  problems.push(`Node sidecar 缺 ${JIT}(SEA V8 在 hardened runtime 下需要):${sidecar}`);
}

if (problems.length > 0) {
  console.error('✗ entitlement 分离检查未通过:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\n修法:tauri.conf macOS.entitlements 指向 entitlements-app.plist(最小);');
  console.error('sign 时对 Contents/MacOS/skill-switch-cli 单独用 entitlements-sidecar.plist 重签(JIT)。');
  process.exit(1);
}
console.log('✓ entitlement 分离正确:GUI 主程序最小,sidecar 持 JIT。');
