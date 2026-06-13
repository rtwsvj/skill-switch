import { Command } from '@tauri-apps/plugin-shell';
import type {
  AuditReport,
  DashboardData,
  DoctorReport,
  LockVerifyReport,
  ScanReport,
  StatsReport,
} from './types';

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

async function runCli<T>(args: string[], label: string, allowNonZero = false): Promise<T> {
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
  return parseJson<T>(output.stdout, label);
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
  const [scan, audit, doctor, stats, lockVerify] = await Promise.all([
    loadScan(),
    loadAudit(),
    loadDoctor(),
    loadStats(),
    loadLockVerify(),
  ]);

  return {
    scan,
    audit,
    doctor,
    stats,
    lockVerify,
    source: 'tauri',
    loadedAt: new Date().toISOString(),
  };
}
