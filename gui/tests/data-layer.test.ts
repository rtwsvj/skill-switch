// R32-a:数据层纯逻辑覆盖 —— cli-args 其余命令 + tauri runCliJson 错误/边界路径。
// 所有测试 headless,不依赖 Tauri 运行时。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { toggleArgs, syncArgs, removeArgs, restoreArgs } from '../src/data/cli-args';
import { InvalidJsonError, NoJsonOutputError } from '../src/data/errors';

// ── toggleArgs ────────────────────────────────────────────────
describe('toggleArgs', () => {
  it('启用(on)→ ["toggle", name, "--on", "--json"]', () => {
    expect(toggleArgs({ name: 'my-skill', enabled: true })).toEqual([
      'toggle', 'my-skill', '--on', '--json',
    ]);
  });

  it('禁用(off)→ ["toggle", name, "--off", "--json"]', () => {
    expect(toggleArgs({ name: 'my-skill', enabled: false })).toEqual([
      'toggle', 'my-skill', '--off', '--json',
    ]);
  });

  it('始终带 --json(无论 enabled 值)', () => {
    expect(toggleArgs({ name: 'x', enabled: true }).at(-1)).toBe('--json');
    expect(toggleArgs({ name: 'x', enabled: false }).at(-1)).toBe('--json');
  });
});

// ── syncArgs ──────────────────────────────────────────────────
describe('syncArgs', () => {
  it('dry run → 带 --dry-run', () => {
    expect(syncArgs({ dryRun: true })).toEqual(['sync', '--dry-run', '--json']);
  });

  it('非 dry run → 不带 --dry-run', () => {
    expect(syncArgs({ dryRun: false })).toEqual(['sync', '--json']);
  });

  it('始终以 --json 结尾', () => {
    expect(syncArgs({ dryRun: true }).at(-1)).toBe('--json');
    expect(syncArgs({ dryRun: false }).at(-1)).toBe('--json');
  });
});

// ── removeArgs ────────────────────────────────────────────────
describe('removeArgs', () => {
  it('包含 name 和 --agent', () => {
    expect(removeArgs({ name: 'foo', agent: 'claude-code' })).toEqual([
      'remove', 'foo', '--agent', 'claude-code', '--json',
    ]);
  });

  it('始终以 --json 结尾', () => {
    expect(removeArgs({ name: 'x', agent: 'a' }).at(-1)).toBe('--json');
  });
});

// ── restoreArgs ───────────────────────────────────────────────
describe('restoreArgs', () => {
  it('无参数 → 列表模式 ["restore", "--json"]', () => {
    expect(restoreArgs({})).toEqual(['restore', '--json']);
  });

  it('latest=true → 还原最新快照', () => {
    expect(restoreArgs({ latest: true })).toEqual(['restore', '--latest', '--json']);
  });

  it('id 指定 → 还原指定 id', () => {
    expect(restoreArgs({ id: 'abc123' })).toEqual(['restore', '--id', 'abc123', '--json']);
  });

  it('latest 优先于 id(两者都传时,latest 先判断)', () => {
    // latest=true 分支先于 id 分支;两者都传时走 latest
    const args = restoreArgs({ latest: true, id: 'abc123' });
    expect(args).toContain('--latest');
    expect(args).not.toContain('--id');
  });

  it('始终以 --json 结尾', () => {
    expect(restoreArgs({}).at(-1)).toBe('--json');
    expect(restoreArgs({ latest: true }).at(-1)).toBe('--json');
    expect(restoreArgs({ id: 'x' }).at(-1)).toBe('--json');
  });
});

// ── data/index.ts 路由逻辑:在 node/headless 环境下始终走 fixtures ──
// isTauriRuntime() 检查 typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window。
// vitest/node 环境下 window 未定义 → 始终降级到 fixtures。
// 不需要 mock —— 直接调用 index 导出的函数并验证返回的是 fixture 数据形状。
describe('data/index adapter routing (node env → fixtures)', () => {
  it('loadScan 在 headless 环境返回 fixtures 数据(有 home 字段)', async () => {
    const { loadScan } = await import('../src/data/index');
    const result = await loadScan();
    expect(result).toHaveProperty('home');
    expect(result).toHaveProperty('skills');
    expect(Array.isArray(result.skills)).toBe(true);
  });

  it('loadAudit 在 headless 环境返回数组', async () => {
    const { loadAudit } = await import('../src/data/index');
    const result = await loadAudit();
    expect(Array.isArray(result)).toBe(true);
  });

  it('loadDoctor 在 headless 环境有 clean 和 declarations 字段', async () => {
    const { loadDoctor } = await import('../src/data/index');
    const result = await loadDoctor();
    expect(result).toHaveProperty('clean');
    expect(result).toHaveProperty('declarations');
  });

  it('loadStats 在 headless 环境有 invocations 字段', async () => {
    const { loadStats } = await import('../src/data/index');
    const result = await loadStats();
    expect(result).toHaveProperty('invocations');
  });

  it('loadLockVerify 在 headless 环境有 ok 字段', async () => {
    const { loadLockVerify } = await import('../src/data/index');
    const result = await loadLockVerify();
    expect(result).toHaveProperty('ok');
  });

  it('loadDashboardData source 字段为 "fixtures"(非 tauri)', async () => {
    const { loadDashboardData } = await import('../src/data/index');
    const data = await loadDashboardData();
    // fixtures 适配器硬编码 source='fixtures'
    expect(data.source).toBe('fixtures');
  });

  it('loadCoreDashboard audit/stats 为空占位(首屏轻量)', async () => {
    const { loadCoreDashboard } = await import('../src/data/index');
    const data = await loadCoreDashboard();
    expect(data.audit).toEqual([]);
    // stats 为 emptyStats 结构(invocations=0)
    expect(data.stats.invocations).toBe(0);
  });
});

// ── tauri.ts runCliJson 错误/边界路径 ────────────────────────
// runCliJson 内部调用 runWithTimeout,我们通过 vi.mock 替换 run-with-timeout 模块
// 来注入各种失败场景,确认 runCliJson 正确封装错误而不是裸抛或静默丢失。
vi.mock('../src/data/run-with-timeout', () => ({
  runWithTimeout: vi.fn(),
  CommandTimeoutError: class CommandTimeoutError extends Error {
    constructor(msg: string) { super(msg); this.name = 'CommandTimeoutError'; }
  },
  CommandCancelledError: class CommandCancelledError extends Error {
    constructor(msg: string) { super(msg); this.name = 'CommandCancelledError'; }
  },
}));

// Command.sidecar 是 Tauri 特有 API,需要 stub 掉
vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    sidecar: vi.fn(),
  },
}));

describe('tauri runCliJson 错误处理', () => {
  let runWithTimeout: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('../src/data/run-with-timeout');
    runWithTimeout = mod.runWithTimeout as ReturnType<typeof vi.fn>;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('非零退出码且 allowNonZero=false → 抛出含 exit code 的 Error', async () => {
    runWithTimeout.mockResolvedValue({ code: 1, stdout: '', stderr: 'permission denied' });
    const { loadScan } = await import('../src/data/tauri');
    await expect(loadScan()).rejects.toThrow(/exited 1/);
  });

  it('stdout 为空字符串 → 抛出 NoJsonOutputError(code=noJsonOutput,无硬编码文案)', async () => {
    runWithTimeout.mockResolvedValue({ code: 0, stdout: '', stderr: 'boom' });
    const { loadScan } = await import('../src/data/tauri');
    const err = await loadScan().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoJsonOutputError);
    expect((err as NoJsonOutputError).code).toBe('noJsonOutput');
    // stderr 摘要进入 params,供 UI 用 t('errors.noJsonOutput', params) 渲染
    expect((err as NoJsonOutputError).params.stderr).toBe('boom');
  });

  it('stdout 只有空白 → 同样抛出 NoJsonOutputError', async () => {
    runWithTimeout.mockResolvedValue({ code: 0, stdout: '   \n  ', stderr: '' });
    const { loadScan } = await import('../src/data/tauri');
    await expect(loadScan()).rejects.toBeInstanceOf(NoJsonOutputError);
  });

  it('stdout 是非法 JSON → 抛出 InvalidJsonError 并在 params 携带 stdout 摘要', async () => {
    runWithTimeout.mockResolvedValue({ code: 0, stdout: 'not-json-at-all', stderr: '' });
    const { loadScan } = await import('../src/data/tauri');
    const err = await loadScan().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidJsonError);
    expect((err as InvalidJsonError).code).toBe('invalidJson');
    // 应携带 stdout 摘要,供排查(放在 params,而非硬编码进 message)
    expect((err as InvalidJsonError).params.stdout).toContain('not-json-at-all');
  });

  it('stdout 是截断 JSON → 抛出 InvalidJsonError', async () => {
    const truncated = '{"skills": [{"name": "foo"';
    runWithTimeout.mockResolvedValue({ code: 0, stdout: truncated, stderr: '' });
    const { loadScan } = await import('../src/data/tauri');
    await expect(loadScan()).rejects.toBeInstanceOf(InvalidJsonError);
  });

  it('allowNonZero=true(如 loadAudit)时非零退出不抛,正常解析 JSON', async () => {
    // audit 命令 exit 1 属于「有 blocking finding」,不应当作错误
    runWithTimeout.mockResolvedValue({
      code: 1,
      stdout: JSON.stringify({ skills: [] }),
      stderr: '',
    });
    const { loadAudit } = await import('../src/data/tauri');
    // loadAudit 内部取 .skills,应该返回空数组而非 throw
    await expect(loadAudit()).resolves.toEqual([]);
  });

  it('runWithTimeout 本身 reject → 错误向上传播(非吞异常)', async () => {
    runWithTimeout.mockRejectedValue(new Error('timeout boom'));
    const { loadScan } = await import('../src/data/tauri');
    await expect(loadScan()).rejects.toThrow('timeout boom');
  });

  it('exit code null(进程被 kill)→ 错误消息包含 null', async () => {
    runWithTimeout.mockResolvedValue({ code: null, stdout: '', stderr: 'killed' });
    const { loadScan } = await import('../src/data/tauri');
    await expect(loadScan()).rejects.toThrow(/null/);
  });
});
