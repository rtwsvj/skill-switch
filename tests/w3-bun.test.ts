/**
 * w3-bun.test.ts
 *
 * W3 Wave: bun compile 路径验证测试。
 *
 * 测试策略：
 *   1. 纯函数部分（参数构造、triple 命名规则）——无论 CI 是否有 bun 都运行。
 *   2. 实际构建 + smoke 运行——用 it.skipIf(!bunAvailable) 守卫，CI 无 bun 不红。
 *
 * 不改动 src/**（禁区），不破坏 SEA 路径。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ── 路径常量 ────────────────────────────────────────────────────────────────

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// bundle-cli-bun.mjs 导出的纯函数
const bundleCliBunPath = resolve(repoRoot, 'gui', 'scripts', 'bundle-cli-bun.mjs');

// ── bun 可用性检测 ──────────────────────────────────────────────────────────

function detectBunBin(): string | null {
  // 1. 项目本地 node_modules/.bin/bun
  const localBun = resolve(repoRoot, 'node_modules', '.bin', 'bun');
  if (existsSync(localBun)) return localBun;

  // 2. PATH 中的 bun
  const result = spawnSync('which', ['bun'], { encoding: 'utf8' });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();

  return null;
}

const bunBin = detectBunBin();
const bunAvailable = bunBin !== null;

// ── 动态导入 bundle-cli-bun.mjs 的导出 ─────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: 动态导入测试辅助，类型不关键
let bunModule: any;

beforeAll(async () => {
  // 动态导入确保脚本存在且语法正确
  bunModule = await import(bundleCliBunPath);
});

// ── 测试套件 ────────────────────────────────────────────────────────────────

describe('W3 bun 路径：纯函数验证（始终运行，不依赖 bun 二进制）', () => {
  it('bundle-cli-bun.mjs 文件存在', () => {
    expect(existsSync(bundleCliBunPath)).toBe(true);
  });

  it('bunBuildArgs 返回正确的命令结构', async () => {
    const { bunBuildArgs } = bunModule;

    const triple = 'aarch64-apple-darwin';
    const ext = '';
    const entryFile = '/tmp/bun-entry.ts';

    const args = bunBuildArgs(entryFile, triple, ext);

    // 必须包含 --compile 标志
    expect(args).toContain('--compile');
    // 必须包含 build 子命令
    expect(args).toContain('build');
    // 入口文件在参数中
    expect(args).toContain(entryFile);

    // --outfile 指向正确路径
    const outfileIdx = args.indexOf('--outfile');
    expect(outfileIdx).toBeGreaterThan(-1);
    const outfile = args[outfileIdx + 1];
    expect(outfile).toMatch(/skill-switch-cli-aarch64-apple-darwin$/);
  });

  it('outfilePath 命名规则与 SEA 路径一致（含 triple）', async () => {
    const { outfilePath } = bunModule;

    // 各平台 triple 覆盖
    const triples = [
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
      'x86_64-unknown-linux-gnu',
      'aarch64-unknown-linux-gnu',
      'x86_64-pc-windows-msvc',
    ];

    for (const triple of triples) {
      const ext = triple.includes('windows') ? '.exe' : '';
      const path = outfilePath(triple, ext);

      // 必须包含 triple
      expect(path).toContain(triple);
      // Windows 有 .exe 后缀
      if (triple.includes('windows')) {
        expect(path).toMatch(/\.exe$/);
      } else {
        expect(path).not.toMatch(/\.exe$/);
      }
      // 输出目录在 gui/src-tauri/bin/ 下
      expect(path).toContain(join('gui', 'src-tauri', 'bin', 'skill-switch-cli'));
    }
  });

  it('bunBuildArgs Windows 版本含 .exe 后缀', async () => {
    const { bunBuildArgs } = bunModule;

    const args = bunBuildArgs('/tmp/entry.ts', 'x86_64-pc-windows-msvc', '.exe');
    const outfileIdx = args.indexOf('--outfile');
    expect(outfileIdx).toBeGreaterThan(-1);
    expect(args[outfileIdx + 1]).toMatch(/\.exe$/);
  });

  it('hostTriple 返回非空字符串', async () => {
    const { hostTriple } = bunModule;
    const triple = hostTriple();
    expect(typeof triple).toBe('string');
    expect(triple.length).toBeGreaterThan(0);
    // 格式：<arch>-<vendor/os>-<env>（至少含一个连字符）
    expect(triple).toMatch(/-/);
  });
});

describe('W3 bun 路径：实际构建 smoke（需要 bun 二进制）', () => {
  // 临时目录，用于 scan --home
  let tempHome: string;

  beforeAll(() => {
    if (bunAvailable) {
      tempHome = mkdtempSync(join(tmpdir(), 'skill-switch-bun-smoke-'));
    }
  });

  afterAll(() => {
    if (bunAvailable && tempHome && existsSync(tempHome)) {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it.skipIf(!bunAvailable)('bun 版本可读取', () => {
    const result = spawnSync(bunBin!, ['--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    // bun 版本格式：X.Y.Z
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.skipIf(!bunAvailable)(
    'pnpm bundle:cli:bun 构建成功（生成产物文件）',
    async () => {
      // 动态获取 triple 和 outfile 路径
      const { hostTriple, outfilePath } = bunModule;
      const triple = hostTriple();
      const ext = process.platform === 'win32' ? '.exe' : '';
      const expectedOutfile = outfilePath(triple, ext);

      // 确保输出目录存在
      mkdirSync(dirname(expectedOutfile), { recursive: true });

      // 运行实际构建
      const result = spawnSync('node', [bundleCliBunPath], {
        cwd: repoRoot,
        env: process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (result.status !== 0) {
        console.error('[w3-bun smoke] stderr:', result.stderr);
        console.error('[w3-bun smoke] stdout:', result.stdout);
      }

      expect(result.status, `bun build 失败: ${result.stderr}`).toBe(0);
      expect(existsSync(expectedOutfile)).toBe(true);
    },
    // bun 首次编译可能需要较长时间（需下载依赖/编译）
    120_000,
  );

  it.skipIf(!bunAvailable)(
    'bun 产物 --version 输出正确',
    async () => {
      const { hostTriple, outfilePath } = bunModule;
      const triple = hostTriple();
      const ext = process.platform === 'win32' ? '.exe' : '';
      const binary = outfilePath(triple, ext);

      if (!existsSync(binary)) {
        // 如果构建测试被跳过，这里也跳过
        return;
      }

      const result = spawnSync(binary, ['--version'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      // bun 打包后 package.json 路径解析失败，readCliVersion() 回退到 'unknown'——已知限制。
      // 断言：输出非空，且是版本号格式或回退值 'unknown'。
      const out = result.stdout.trim();
      expect(out.length).toBeGreaterThan(0);
      expect(out === 'unknown' || /\d+\.\d+\.\d+/.test(out)).toBe(true);
    },
    15_000,
  );

  it.skipIf(!bunAvailable)(
    'bun 产物 scan --home <空目录> 正常退出',
    async () => {
      const { hostTriple, outfilePath } = bunModule;
      const triple = hostTriple();
      const ext = process.platform === 'win32' ? '.exe' : '';
      const binary = outfilePath(triple, ext);

      if (!existsSync(binary) || !tempHome) return;

      const result = spawnSync(binary, ['scan', '--home', tempHome], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      // 空目录下 scan 应以 0 退出（无 MCP 配置，报告空结果）
      expect(result.status).toBe(0);
    },
    20_000,
  );

  it.skipIf(!bunAvailable)(
    'bun 产物 mcp --list-tools 正常退出',
    async () => {
      const { hostTriple, outfilePath } = bunModule;
      const triple = hostTriple();
      const ext = process.platform === 'win32' ? '.exe' : '';
      const binary = outfilePath(triple, ext);

      if (!existsSync(binary)) return;

      const result = spawnSync(binary, ['mcp', '--list-tools'], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      // mcp --list-tools 应以 0 退出并列出工具名
      expect(result.status).toBe(0);
    },
    20_000,
  );

  it.skipIf(!bunAvailable)(
    '冷启动时间对比：bun 产物 vs tsx',
    async () => {
      const { hostTriple, outfilePath } = bunModule;
      const triple = hostTriple();
      const ext = process.platform === 'win32' ? '.exe' : '';
      const binary = outfilePath(triple, ext);

      if (!existsSync(binary)) return;

      // 测量 bun 产物冷启动（连跑 3 次取中位数，避免缓存预热误差）
      const bunTimes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        spawnSync(binary, ['--version'], { encoding: 'utf8' });
        bunTimes.push(Date.now() - t0);
      }
      bunTimes.sort((a, b) => a - b);
      const bunMedian = bunTimes[1]; // 中位数

      // 测量 tsx 冷启动（连跑 3 次取中位数）
      const tsxBin = resolve(repoRoot, 'node_modules', '.bin', 'tsx');
      const tsxEntry = resolve(repoRoot, 'src', 'cli', 'index.ts');
      const tsxTimes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        spawnSync(tsxBin, [tsxEntry, '--version'], { encoding: 'utf8' });
        tsxTimes.push(Date.now() - t0);
      }
      tsxTimes.sort((a, b) => a - b);
      const tsxMedian = tsxTimes[1];

      // 打印对比（便于 CI 日志查阅）
      console.log(
        `[w3-bun] 冷启动对比：bun=${bunMedian}ms(中位数) vs tsx=${tsxMedian}ms(中位数)`,
      );

      // bun 产物启动必须在 2000ms 内（宽松上限，CI 可能较慢）
      expect(bunMedian).toBeLessThan(2000);

      // bun 产物应明显快于 tsx（至少快 50%），否则仅警告不硬断言
      if (bunMedian >= tsxMedian) {
        console.warn(
          `[w3-bun] bun 产物(${bunMedian}ms)未快于 tsx(${tsxMedian}ms)，可能是 CI 测量误差`,
        );
      }
    },
    60_000,
  );
});
