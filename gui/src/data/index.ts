import * as fixtures from './fixtures';
import type { DashboardData } from './types';

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function activeAdapter() {
  if (isTauriRuntime()) {
    return import('./tauri');
  }
  return fixtures;
}

export async function loadScan() {
  return (await activeAdapter()).loadScan();
}

export async function loadAudit() {
  return (await activeAdapter()).loadAudit();
}

export async function loadDoctor() {
  return (await activeAdapter()).loadDoctor();
}

export async function loadStats() {
  return (await activeAdapter()).loadStats();
}

export async function loadLockVerify() {
  return (await activeAdapter()).loadLockVerify();
}

export async function loadDashboardData(): Promise<DashboardData> {
  return (await activeAdapter()).loadDashboardData();
}

export type {
  AuditFinding,
  AuditReport,
  DashboardData,
  DoctorFinding,
  DoctorReport,
  LockVerifyEntry,
  LockVerifyReport,
  ScanReport,
  SkillRecord,
  StatsReport,
} from './types';
