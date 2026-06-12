import { Command } from '@tauri-apps/plugin-shell';
import type {
  AuditReport,
  DashboardData,
  DoctorReport,
  LockVerifyReport,
  ScanReport,
  SkillRecord,
  StatsReport,
} from './types';

const repoRoot = import.meta.env.VITE_SKILL_SWITCH_ROOT || '..';
const cliPrefix = ['--import', 'tsx', 'src/cli/index.ts'];

type CliProgram = 'skill-switch-scan' | 'skill-switch-audit' | 'skill-switch-doctor' | 'skill-switch-stats' | 'skill-switch-lock';

function parseJson<T>(stdout: string, label: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new Error(`Unable to parse ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runCli<T>(program: CliProgram, args: string[], label: string, allowNonZero = false): Promise<T> {
  const command = Command.create(program, [...cliPrefix, ...args], {
    cwd: repoRoot,
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

function folderFor(skill: SkillRecord): string {
  return skill.path.endsWith('/SKILL.md') ? skill.path.slice(0, -'/SKILL.md'.length) : skill.path;
}

function blockedByPolicy(report: AuditReport): boolean {
  return report.score < 70 || report.findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high');
}

async function loadAuditForScan(scan: ScanReport): Promise<AuditReport[]> {
  return Promise.all(
    scan.skills.map(async (skill) => {
      const path = folderFor(skill);
      const report = await runCli<AuditReport>('skill-switch-audit', ['audit', path, '--json'], `audit ${skill.dirName}`, true);
      return {
        ...report,
        name: skill.name ?? skill.dirName,
        agents: skill.agents,
        relSkillsDir: skill.relSkillsDir,
        blocked: blockedByPolicy(report),
      };
    }),
  );
}

export async function loadScan(): Promise<ScanReport> {
  return runCli<ScanReport>('skill-switch-scan', ['scan', '--json'], 'scan');
}

export async function loadAudit(): Promise<AuditReport[]> {
  return loadAuditForScan(await loadScan());
}

export async function loadDoctor(): Promise<DoctorReport> {
  return runCli<DoctorReport>('skill-switch-doctor', ['doctor', '--json'], 'doctor');
}

export async function loadStats(): Promise<StatsReport> {
  return runCli<StatsReport>('skill-switch-stats', ['stats', '--days', '30', '--json'], 'stats');
}

export async function loadLockVerify(): Promise<LockVerifyReport> {
  return runCli<LockVerifyReport>('skill-switch-lock', ['lock', '--verify', '--json'], 'lock --verify', true);
}

export async function loadDashboardData(): Promise<DashboardData> {
  const scan = await loadScan();
  const [audit, doctor, stats, lockVerify] = await Promise.all([
    loadAuditForScan(scan),
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
