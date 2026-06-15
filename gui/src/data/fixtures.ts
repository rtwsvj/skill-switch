import scan from '../../fixtures/scan.json';
import audit from '../../fixtures/audit.json';
import doctor from '../../fixtures/doctor.json';
import stats from '../../fixtures/stats.json';
import lockVerify from '../../fixtures/lock-verify.json';
import { assembleDashboard } from './dashboard';
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

function fixtureResult<T>(data: T): CliJsonResult<T> {
  return {
    data,
    stdout: `${JSON.stringify(data, null, 2)}\n`,
    stderr: '',
    exitCode: 0,
  };
}

export async function loadScan(): Promise<ScanReport> {
  return scan as ScanReport;
}

export async function loadAudit(): Promise<AuditReport[]> {
  return audit as AuditReport[];
}

export async function loadDoctor(): Promise<DoctorReport> {
  return doctor as DoctorReport;
}

export async function loadStats(): Promise<StatsReport> {
  return stats as StatsReport;
}

export async function loadLockVerify(): Promise<LockVerifyReport> {
  return lockVerify as LockVerifyReport;
}

export async function loadDashboardData(): Promise<DashboardData> {
  const [scan, audit, doctor, stats, lockVerify] = await Promise.allSettled([
    loadScan(),
    loadAudit(),
    loadDoctor(),
    loadStats(),
    loadLockVerify(),
  ]);

  return assembleDashboard({ scan, audit, doctor, stats, lockVerify }, 'fixtures');
}

export async function runInstall(request: InstallRequest): Promise<CliJsonResult<InstallRunResult>> {
  const data: InstallRunResult = {
    installed: [{ name: request.skill ?? 'fixture-skill', targetPath: `/fixtures/${request.agent}` }],
    blocked: [],
    snapshotPath: '/fixtures/backups/pre-install.tar.gz',
    lockPath: '/fixtures/.skill-switch/skills.lock.json',
    declarationPath: '/fixtures/.skill-switch/skills.json',
  };
  return fixtureResult(data);
}

export async function runToggle(request: ToggleRequest): Promise<CliJsonResult<ToggleRunResult>> {
  return fixtureResult({
    name: request.name,
    enabled: request.enabled,
    declarationPath: '/fixtures/.skill-switch/skills.json',
    snapshots: [],
    actions: [{ kind: request.enabled ? 'create' : 'remove', agent: 'claude-code', name: request.name, target: `/fixtures/${request.name}` }],
  });
}

export async function runSync(request: SyncRequest): Promise<CliJsonResult<SyncRunResult>> {
  return fixtureResult({
    declarationPath: '/fixtures/.skill-switch/skills.json',
    dryRun: request.dryRun,
    snapshots: request.dryRun ? [] : [{ path: '/fixtures/backups/pre-sync.tar.gz', label: 'pre-sync', createdAt: new Date().toISOString() }],
    actions: [{ kind: 'noop', agent: 'claude-code', name: 'fixture-skill', target: '/fixtures/fixture-skill' }],
  });
}

export async function runRemove(request: RemoveRequest): Promise<CliJsonResult<RemoveRunResult>> {
  return fixtureResult({
    name: request.name,
    agent: request.agent,
    targetPath: `/fixtures/${request.agent}/${request.name}`,
    lockPath: '/fixtures/.skill-switch/skills.lock.json',
    declarationPath: '/fixtures/.skill-switch/skills.json',
    snapshots: [{ path: '/fixtures/backups/pre-remove.tar.gz', label: 'pre-remove', createdAt: new Date().toISOString() }],
  });
}

export async function runRestore(
  request: RestoreRequest = {},
): Promise<CliJsonResult<RestoreListResult | RestoreRunResult>> {
  if (request.id || request.latest) {
    return fixtureResult({
      restored: true,
      target: '/fixtures/.claude/skills',
      snapshot: { id: request.id ?? 'latest', path: '/fixtures/backups/snapshot.tar.gz', label: 'pre-toggle', createdAt: new Date().toISOString(), sourceDir: '/fixtures/.claude/skills' },
      safetySnapshot: { path: '/fixtures/backups/pre-restore.tar.gz', label: 'pre-restore', createdAt: new Date().toISOString(), sourceDir: '/fixtures/.claude/skills' },
    });
  }
  return fixtureResult({
    store: '/fixtures/.skill-switch/backups',
    snapshots: [{ id: '1', path: '/fixtures/backups/snapshot.tar.gz', label: 'pre-toggle', createdAt: new Date().toISOString(), sourceDir: '/fixtures/.claude/skills' }],
  });
}
