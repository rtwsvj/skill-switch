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
import { assembleDashboard } from './dashboard';

const sidecarProgram = 'bin/skill-switch-cli';

interface AuditHomeReport {
  skills: AuditReport[];
}

function parseJson<T>(stdout: string, label: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new Error(`Unable to parse ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runCliJson<T>(
  args: string[],
  label: string,
  allowNonZero = false,
): Promise<CliJsonResult<T>> {
  const command = Command.sidecar(sidecarProgram, args, {
    env: {
      PAGER: '',
      GIT_PAGER: '',
    },
  });
  const output = await command.execute();
  if (!allowNonZero && output.code !== 0) {
    throw new Error(`${label} exited ${output.code}: ${output.stderr || output.stdout}`);
  }
  if (!output.stdout.trim()) {
    throw new Error(`${label} produced no JSON output.`);
  }
  return {
    data: parseJson<T>(output.stdout, label),
    stdout: output.stdout,
    stderr: output.stderr,
    exitCode: output.code ?? -1,
  };
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
