import scan from '../../fixtures/scan.json';
import audit from '../../fixtures/audit.json';
import doctor from '../../fixtures/doctor.json';
import stats from '../../fixtures/stats.json';
import lockVerify from '../../fixtures/lock-verify.json';
import type {
  AuditReport,
  DashboardData,
  DoctorReport,
  LockVerifyReport,
  ScanReport,
  StatsReport,
} from './types';

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
  const [scanReport, auditReport, doctorReport, statsReport, lockReport] = await Promise.all([
    loadScan(),
    loadAudit(),
    loadDoctor(),
    loadStats(),
    loadLockVerify(),
  ]);

  return {
    scan: scanReport,
    audit: auditReport,
    doctor: doctorReport,
    stats: statsReport,
    lockVerify: lockReport,
    source: 'fixtures',
    loadedAt: new Date().toISOString(),
  };
}
