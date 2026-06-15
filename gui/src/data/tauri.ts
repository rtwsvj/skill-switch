import { Command } from '@tauri-apps/plugin-shell';
import type {
  AuditReport,
  CliJsonResult,
  DashboardData,
  DoctorReport,
  InstallRequest,
  InstallRunResult,
  LockVerifyReport,
  RemoveRequest,
  RemoveRunResult,
  RestoreListResult,
  RestoreRequest,
  RestoreRunResult,
  ScanReport,
  StatsReport,
  SyncRequest,
  SyncRunResult,
  ToggleRequest,
  ToggleRunResult,
} from './types';
import { installArgs, removeArgs, restoreArgs, syncArgs, toggleArgs } from './cli-args';
import { assembleDashboard, emptyStats } from './dashboard';
import { runWithTimeout, type SpawnHandle } from './run-with-timeout';

const sidecarProgram = 'bin/skill-switch-cli';

// 各命令的超时上限(ms)。install 走网络/clone 给足 5min;读命令短。
const COMMAND_TIMEOUTS: Record<string, number> = {
  scan: 10_000,
  doctor: 15_000,
  lock: 10_000,
  audit: 60_000,
  stats: 30_000,
  install: 300_000,
  toggle: 60_000,
  sync: 60_000,
  remove: 60_000,
  restore: 60_000,
};

function timeoutFor(label: string): number {
  return COMMAND_TIMEOUTS[label.split(' ')[0] ?? ''] ?? 60_000;
}

// 用 execute() 运行 sidecar:它可靠地缓冲完整 stdout/stderr(无按行分块/JSON 截断问题),
// 且只需 capability 里已有的 shell:allow-execute。超时/取消由上层 runWithTimeout 兜底:
// 超时/取消时 UI 的 promise 立即拒绝、界面恢复;execute() 无法中途 kill 子进程(那需要
// shell:allow-kill,会扩大 shell capability 面,与 M0 最小权限取向相悖),因此 kill 是
// 文档化的 no-op —— 进程自行结束,写操作本身是原子的,刷新后状态一致。后续若要真正 kill,
// 再单独评估加 shell:allow-spawn/kill。
function spawnSidecar(args: string[]): SpawnHandle {
  const command = Command.sidecar(sidecarProgram, args, { env: { PAGER: '', GIT_PAGER: '' } });
  const result = command
    .execute()
    .then((output) => ({ code: output.code, stdout: output.stdout, stderr: output.stderr }));
  return { result, kill: () => undefined };
}

interface AuditHomeReport {
  skills: AuditReport[];
}

async function runCliJson<T>(
  args: string[],
  label: string,
  allowNonZero = false,
  signal?: AbortSignal,
): Promise<CliJsonResult<T>> {
  const output = await runWithTimeout(() => spawnSidecar(args), label, timeoutFor(label), signal);
  if (!allowNonZero && output.code !== 0) {
    throw new Error(`${label} exited ${output.code ?? 'null'}: ${output.stderr || output.stdout}`);
  }
  if (!output.stdout.trim()) {
    throw new Error(`${label} 无 JSON 输出。stderr: ${output.stderr.slice(0, 300)}`);
  }
  let data: T;
  try {
    data = JSON.parse(output.stdout) as T;
  } catch (error) {
    // JSON 解析失败:展示 stdout/stderr 摘要,而不是裸抛一个无上下文的 SyntaxError。
    throw new Error(
      `${label} 输出不是合法 JSON:${error instanceof Error ? error.message : String(error)}` +
        `\nstdout: ${output.stdout.slice(0, 300)}\nstderr: ${output.stderr.slice(0, 300)}`,
    );
  }
  return { data, stdout: output.stdout, stderr: output.stderr, exitCode: output.code ?? -1 };
}

async function runCli<T>(args: string[], label: string, allowNonZero = false): Promise<T> {
  return (await runCliJson<T>(args, label, allowNonZero)).data;
}

export async function loadScan(): Promise<ScanReport> {
  return runCli<ScanReport>(['scan', '--json'], 'scan');
}

export async function loadAudit(): Promise<AuditReport[]> {
  // 注意:用 `audit --json`(不带 --home)。audit 的 home 全量模式由「无 path 参数」触发;
  // `--home` 是可选值选项,放在 --json 前会把 --json 当成它的值,导致输出人类表格而非 JSON。
  return (await runCli<AuditHomeReport>(['audit', '--json'], 'audit', true)).skills;
}

export async function loadDoctor(): Promise<DoctorReport> {
  return runCli<DoctorReport>(['doctor', '--json'], 'doctor');
}

export async function loadStats(): Promise<StatsReport> {
  return runCli<StatsReport>(['stats', '--days', '30', '--json'], 'stats');
}

export async function loadLockVerify(): Promise<LockVerifyReport> {
  return runCli<LockVerifyReport>(['lock', '--verify', '--json'], 'lock --verify', true);
}

export async function loadDashboardData(): Promise<DashboardData> {
  // allSettled:任一区块失败用安全默认值兜底 + 记 loadErrors,绝不整屏白错误。
  const [scan, audit, doctor, stats, lockVerify] = await Promise.allSettled([
    loadScan(),
    loadAudit(),
    loadDoctor(),
    loadStats(),
    loadLockVerify(),
  ]);

  return assembleDashboard({ scan, audit, doctor, stats, lockVerify }, 'tauri');
}

export async function loadCoreDashboard(): Promise<DashboardData> {
  // M0-5.6 懒加载:首屏只跑轻量区块(scan/doctor/lock),audit/stats(可能慢:逐文件审计 /
  // 解析 transcript)由 App 在首屏渲染后台懒加载,不阻塞首屏。audit/stats 先填空值占位。
  const [scan, doctor, lockVerify] = await Promise.allSettled([
    loadScan(),
    loadDoctor(),
    loadLockVerify(),
  ]);

  return assembleDashboard(
    {
      scan,
      doctor,
      lockVerify,
      audit: { status: 'fulfilled', value: [] },
      stats: { status: 'fulfilled', value: emptyStats },
    },
    'tauri',
  );
}

export async function runInstall(
  request: InstallRequest,
): Promise<CliJsonResult<InstallRunResult>> {
  return runCliJson<InstallRunResult>(installArgs(request), 'install', true);
}

export async function runToggle(
  request: ToggleRequest,
): Promise<CliJsonResult<ToggleRunResult>> {
  return runCliJson<ToggleRunResult>(toggleArgs(request), 'toggle');
}

export async function runSync(request: SyncRequest): Promise<CliJsonResult<SyncRunResult>> {
  return runCliJson<SyncRunResult>(syncArgs(request), 'sync');
}

export async function runRemove(
  request: RemoveRequest,
): Promise<CliJsonResult<RemoveRunResult>> {
  return runCliJson<RemoveRunResult>(removeArgs(request), 'remove');
}

export async function runRestore(
  request: RestoreRequest = {},
): Promise<CliJsonResult<RestoreListResult | RestoreRunResult>> {
  return runCliJson<RestoreListResult | RestoreRunResult>(restoreArgs(request), 'restore');
}
