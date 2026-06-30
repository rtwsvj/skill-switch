/**
 * bundle-cli-bun.mjs
 *
 * 用 bun compile 生成单文件原生可执行文件的并列构建路径。
 * ⚠ 这是【实验性】路径，不替换现有 Node SEA 路径（bundle-cli.mjs）。
 *
 * 产物命名规则与 SEA 路径相同：
 *   gui/src-tauri/bin/skill-switch-cli-<triple>[.exe]
 *
 * bun 与 Node SEA 的关键区别：
 *   - bun 下 `process.isBun === 1`，但不提供 node:sea 的 `isSea()`
 *   - src/cli/index.ts 里 `isSea()` 会在 bun 运行时崩溃（node:sea 是 Node 内置）
 *   - 解决方案：用 bun 的 --define 把 node:sea 模块注入为空实现，
 *     或用一个 wrapper 入口脚本代替 index.ts 直接调用 buildProgram()
 *
 * 本脚本采用「wrapper 入口」方案：
 *   生成一个临时的 bun-entry.ts（写到 scratchpad / OS tmp），
 *   直接导入 program.ts 并以正确方式解析参数，
 *   完全不碰 src/cli/index.ts（禁区）。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');

// 产物输出目录与 SEA 路径保持一致：gui/src-tauri/bin/
const outBase = resolve(scriptDir, '..', 'src-tauri', 'bin', 'skill-switch-cli');

// ── 平台/架构 → Rust target triple 映射 ────────────────────────────────────

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function homeCandidates() {
  return unique([homedir(), userInfo().homedir]);
}

function rustcCandidates() {
  return unique([
    'rustc',
    process.env.CARGO_HOME ? resolve(process.env.CARGO_HOME, 'bin', 'rustc') : undefined,
    ...homeCandidates().map((home) => resolve(home, '.cargo', 'bin', 'rustc')),
  ]);
}

/**
 * hostTriple:与 bundle-cli.mjs 中的同名函数逻辑完全一致，
 * 单独复制以避免改动现有 SEA 脚本。
 */
export function hostTriple() {
  const rustEnv = { ...process.env };
  if (!process.env.RUSTUP_TOOLCHAIN) delete rustEnv.RUSTUP_TOOLCHAIN;
  for (const rustc of rustcCandidates()) {
    try {
      return execFileSync(rustc, ['--print', 'host-tuple'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: rustEnv,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // 继续尝试下一个候选
    }
  }
  // 无法运行 rustc 时的降级推断
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin';
  if (process.platform === 'linux' && process.arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-pc-windows-msvc';
  throw new Error(`无法确定 Rust host triple：${process.platform}/${process.arch}`);
}

// ── 参数构造（可被测试单独导入）────────────────────────────────────────────

/**
 * bunBuildArgs:组装传给 `bun build --compile` 的完整参数列表。
 * 纯函数，不依赖副作用，方便单元测试验证命名规则。
 *
 * @param {string} entryFile - bun 入口脚本的绝对路径
 * @param {string} triple    - Rust target triple（例如 "aarch64-apple-darwin"）
 * @param {string} extension - 可执行文件扩展名（Windows 为 ".exe"，其余为 ""）
 * @returns {string[]} bun build 参数数组
 */
export function bunBuildArgs(entryFile, triple, extension) {
  const outfile = `${outBase}-${triple}${extension}`;
  return [
    'build',
    '--compile',
    entryFile,
    '--outfile',
    outfile,
    // 定义空的 node:sea 替换，让 isSea() 调用不崩溃
    // 注：bun 1.x 尚未支持 --define 对 named-import，用 wrapper 入口绕过
  ];
}

/**
 * outfilePath:计算产物路径（与 SEA 路径的命名规则保持一致）。
 *
 * @param {string} triple    - Rust target triple
 * @param {string} extension - 扩展名
 * @returns {string}
 */
export function outfilePath(triple, extension) {
  return `${outBase}-${triple}${extension}`;
}

// ── 以下为实际构建逻辑（仅在直接运行时执行）──────────────────────────────

// 用于判断脚本是否以 `node gui/scripts/bundle-cli-bun.mjs` 形式直接调用
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  await runBuild();
}

async function runBuild() {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const triple = hostTriple();
  const outfile = outfilePath(triple, extension);

  // 确保输出目录存在
  mkdirSync(dirname(outfile), { recursive: true });

  // ── 生成 bun wrapper 入口（写在 repoRoot/.bun-tmp，不在 src/ 下）──────────
  //
  // 为什么需要 wrapper？
  //   src/cli/index.ts 调用了 `import { isSea } from 'node:sea'`。
  //   `node:sea` 是 Node.js 内置模块，bun 不提供它。
  //   在 bun 中运行 index.ts 会抛 "Cannot find module 'node:sea'"。
  //
  // 为什么必须放在 repoRoot 下而非 OS tmp？
  //   bun 按入口文件位置向上查找 node_modules。
  //   若入口在 /tmp，bun 找不到项目的 node_modules（commander 等），构建失败。
  //   写到 repoRoot/.bun-tmp/ 可让 bun 正确解析所有依赖。
  //
  // wrapper 方案：直接导入 program.ts，跳过 SEA 检测逻辑，
  // 以正常 CLI 方式解析 process.argv（bun 打包后 argv[0] 是可执行文件自身）。
  //
  // bun 打包后 argv 布局：["bun", "/$bunfs/root/<binary>", ...userArgs]
  // Commander with { from: 'user' } 只要 userArgs，故 wrapper 里用 argv.slice(2)。
  const bunTmpDir = join(repoRoot, '.bun-tmp');
  mkdirSync(bunTmpDir, { recursive: true });
  const tempDir = mkdtempSync(join(bunTmpDir, 'bun-'));

  const wrapperContent = `
// bun compile 入口（由 bundle-cli-bun.mjs 自动生成，勿手动编辑）
// 不导入 node:sea，直接使用 buildProgram()，适配 bun 可执行的 argv 布局。
import { buildProgram } from '${resolve(repoRoot, 'src', 'cli', 'program.ts').replace(/\\/g, '/')}';
import { CommanderError } from 'commander';

async function main(): Promise<void> {
  try {
    // bun 编译后可执行的 argv 布局：
    //   ["bun", "/$bunfs/root/<binary-name>", ...userArgs]
    // Commander with { from: 'user' } 期望只有 userArgs，故 slice(2)。
    await buildProgram().parseAsync(process.argv.slice(2), { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exit(err.exitCode);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(\`错误: \${message}\`);
    process.exit(1);
  }
}

void main();
`.trimStart();

  const entryFile = join(tempDir, 'bun-entry.ts');
  writeFileSync(entryFile, wrapperContent, 'utf8');

  // ── 查找 bun 二进制 ───────────────────────────────────────────────────────
  const bunBin = findBunBin();
  if (!bunBin) {
    throw new Error(
      'bun 可执行文件未找到。请确保已运行 pnpm add -D bun，或将 bun 加入 PATH。',
    );
  }

  const args = bunBuildArgs(entryFile, triple, extension);
  console.log(`[bundle-cli-bun] 构建命令: ${bunBin} ${args.join(' ')}`);

  try {
    const result = spawnSync(bunBin, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });
    if (result.status !== 0) {
      throw new Error(`bun build 失败，退出码: ${result.status}`);
    }
  } finally {
    // 清理临时入口文件
    if (!process.env.SKILL_SWITCH_KEEP_BUN_TEMP) {
      rmSync(tempDir, { recursive: true, force: true });
    } else {
      console.log(`[bundle-cli-bun] 保留临时目录: ${tempDir}`);
    }
  }

  console.log(`[bundle-cli-bun] 产物: ${outfile}`);
}

/**
 * findBunBin:按优先级查找 bun 可执行文件。
 * 1. 项目 node_modules/.bin/bun（pnpm add -D bun 的产物）
 * 2. PATH 中的 bun
 */
function findBunBin() {
  // 优先用项目本地的 bun（node_modules/.bin/bun）
  const localBun = resolve(repoRoot, 'node_modules', '.bin', 'bun');
  if (existsSync(localBun)) return localBun;

  // 回退：PATH 中的 bun
  const result = spawnSync('which', ['bun'], { encoding: 'utf8' });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();

  return null;
}
